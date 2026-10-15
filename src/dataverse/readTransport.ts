import type { JsonObject, JsonValue } from '../contracts/common.js';
import { GUID_PATTERN, LOGICAL_NAME_PATTERN } from '../contracts/patterns.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import { PUBLIC_CLOUD_AUTHORITY_HOST, type TargetConfig } from '../contracts/target.js';
import { checkTargetPolicy, parseExactOrigin } from '../core/policy.js';

export const DATAVERSE_API_PATH = '/api/data/v9.2/';

export interface TokenRequest {
  authorityHost: string;
  authorityTenantId: string;
  clientId: string;
  scopes: readonly string[];
}

export interface AccessToken {
  token: string;
}

/**
 * Supplies delegated tokens from an approved public client with an OS-backed cache. No implementation
 * ships in Phase 1; credentials never come from specs, arguments, environment variables, or logs.
 */
export interface TokenProvider {
  getAccessToken(request: TokenRequest): Promise<AccessToken>;
}

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** When present (e.g. Node fetch), the body is streamed and aborted as soon as the byte limit is exceeded. */
  body?: AsyncIterable<Uint8Array> | null;
}

export interface HttpRequestInit {
  method: 'GET';
  headers: Record<string, string>;
  redirect: 'manual';
  signal: AbortSignal;
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

export interface TransportClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: TransportClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface TransportOptions {
  requestTimeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  totalDeadlineMs: number;
  maxPages: number;
  maxResponseBytes: number;
}

export const DEFAULT_TRANSPORT_OPTIONS: TransportOptions = {
  requestTimeoutMs: 30_000,
  maxRetries: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 10_000,
  totalDeadlineMs: 60_000,
  maxPages: 20,
  maxResponseBytes: 4 * 1024 * 1024,
};

/** OData query options a service-provided continuation may add to the original collection request. */
const CONTINUATION_QUERY_OPTIONS = new Set(['$skiptoken', '$skip']);

export interface ReadFailure {
  ok: false;
  reasonCode: ReasonCode;
  httpStatus: number | null;
  requestId: string | null;
  completeness: 'unknown';
}

export interface ReadSuccess<T> {
  ok: true;
  value: T;
  completeness: 'complete' | 'partial';
  gaps: ReasonCode[];
  requestIds: string[];
}

export type ReadResult<T> = ReadSuccess<T> | ReadFailure;

function failure(reasonCode: ReasonCode, httpStatus: number | null = null, requestId: string | null = null): ReadFailure {
  return { ok: false, reasonCode, httpStatus, requestId, completeness: 'unknown' };
}

export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === '') {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function safeRequestId(headers: HttpResponseLike['headers']): string | null {
  for (const name of ['x-ms-service-request-id', 'req_id', 'request-id']) {
    const value = headers.get(name)?.toLowerCase();
    if (value !== undefined && GUID_PATTERN.test(value)) {
      return value;
    }
  }
  return null;
}

/** Reads at most `limit` UTF-8 bytes; aborts the request and returns undefined when the limit is exceeded. */
async function readBounded(response: HttpResponseLike, limit: number, controller: AbortController): Promise<string | undefined> {
  if (response.body !== undefined && response.body !== null) {
    const decoder = new TextDecoder('utf-8');
    let total = 0;
    let out = '';
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > limit) {
        controller.abort();
        return undefined;
      }
      out += decoder.decode(chunk, { stream: true });
    }
    return out + decoder.decode();
  }
  const text = await response.text();
  return Buffer.byteLength(text, 'utf8') > limit ? undefined : text;
}

/**
 * Bounded, GET-only Dataverse read transport. It is not a generic HTTP client: requests are built only
 * from fixed templates with validated identifiers, tokens are sent only to the single allowlisted
 * organization origin, redirects are never followed, and every continuation URL is re-validated.
 */
export class DataverseReadTransport {
  private readonly origin: string;
  private readonly options: TransportOptions;

  constructor(
    private readonly target: TargetConfig,
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: FetchLike,
    options: Partial<TransportOptions> = {},
    private readonly clock: TransportClock = systemClock,
  ) {
    const policyErrors = checkTargetPolicy(target).filter((d) => d.severity === 'error');
    const org = parseExactOrigin(target.expectedTarget.organizationUrl).origin;
    const allowed = target.allowedOrigins.map((o) => parseExactOrigin(o).origin);
    if (policyErrors.length > 0 || org === undefined || allowed.length !== 1 || allowed[0] !== org) {
      throw new Error('Target configuration is outside the trust boundary; validate it before constructing a transport.');
    }
    this.origin = org;
    this.options = { ...DEFAULT_TRANSPORT_OPTIONS, ...options };
  }

  /** Documented WhoAmI read; verifies the organization ID matches the expected target. */
  async whoAmI(): Promise<ReadResult<{ userId: string; businessUnitId: string; organizationId: string }>> {
    const response = await this.getJson(`${this.origin}${DATAVERSE_API_PATH}WhoAmI`);
    if (!response.ok) {
      return response;
    }
    const pick = (key: string): string | undefined => {
      const value = response.body[key];
      return typeof value === 'string' && GUID_PATTERN.test(value.toLowerCase()) ? value.toLowerCase() : undefined;
    };
    const userId = pick('UserId');
    const businessUnitId = pick('BusinessUnitId');
    const organizationId = pick('OrganizationId');
    if (userId === undefined || businessUnitId === undefined || organizationId === undefined) {
      return failure('TRANSPORT_RESPONSE_INVALID', 200, response.requestId);
    }
    if (organizationId !== this.target.expectedTarget.organizationId) {
      return failure('TARGET_ORGANIZATION_MISMATCH', 200, response.requestId);
    }
    return this.success({ userId, businessUnitId, organizationId }, [], response.requestId);
  }

  /** Discovers the entity set name from metadata rather than synthesizing it. */
  async getEntitySetName(logicalName: string): Promise<ReadResult<string>> {
    if (!LOGICAL_NAME_PATTERN.test(logicalName)) {
      return failure('TRANSPORT_IDENTIFIER_INVALID');
    }
    const url = `${this.origin}${DATAVERSE_API_PATH}EntityDefinitions(LogicalName='${logicalName}')?$select=LogicalName,EntitySetName`;
    const response = await this.getJson(url);
    if (!response.ok) {
      return response;
    }
    const name = response.body['EntitySetName'];
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || response.body['LogicalName'] !== logicalName) {
      return failure('TRANSPORT_RESPONSE_INVALID', 200, response.requestId);
    }
    return this.success(name, [], response.requestId);
  }

  /** Reads attribute metadata for one entity, following only trusted continuation links. */
  async listAttributes(logicalName: string): Promise<ReadResult<{ logicalName: string; attributeType: string }[]>> {
    if (!LOGICAL_NAME_PATTERN.test(logicalName)) {
      return failure('TRANSPORT_IDENTIFIER_INVALID');
    }
    const url = `${this.origin}${DATAVERSE_API_PATH}EntityDefinitions(LogicalName='${logicalName}')/Attributes?$select=LogicalName,AttributeType`;
    const pages = await this.getAllPages(url);
    if (!pages.ok) {
      return pages;
    }
    const attributes: { logicalName: string; attributeType: string }[] = [];
    for (const item of pages.value) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return failure('TRANSPORT_RESPONSE_INVALID');
      }
      const ln = item['LogicalName'];
      const type = item['AttributeType'];
      if (typeof ln !== 'string' || typeof type !== 'string') {
        return failure('TRANSPORT_RESPONSE_INVALID');
      }
      attributes.push({ logicalName: ln, attributeType: type });
    }
    return { ...pages, value: attributes };
  }

  private success<T>(value: T, gaps: ReasonCode[], requestId: string | null): ReadSuccess<T> {
    return { ok: true, value, completeness: gaps.length > 0 ? 'partial' : 'complete', gaps, requestIds: requestId === null ? [] : [requestId] };
  }

  /**
   * A continuation must stay on the original collection: same trusted origin and path, original query
   * options unchanged, and only OData paging options added. A same-origin link to another entity is rejected.
   */
  isTrustedContinuation(firstUrl: string, candidate: string): boolean {
    if (!this.isTrustedUrl(candidate)) {
      return false;
    }
    const first = new URL(firstUrl);
    const next = new URL(candidate);
    if (first.pathname !== next.pathname) {
      return false;
    }
    for (const key of new Set(next.searchParams.keys())) {
      if (first.searchParams.has(key)) {
        if (first.searchParams.getAll(key).join('\u0000') !== next.searchParams.getAll(key).join('\u0000')) {
          return false;
        }
      } else if (!CONTINUATION_QUERY_OPTIONS.has(key)) {
        return false;
      }
    }
    return [...first.searchParams.keys()].every((key) => next.searchParams.has(key));
  }

  isTrustedUrl(candidate: string): boolean {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return false;
    }
    return (
      url.protocol === 'https:' &&
      url.origin === this.origin &&
      url.username === '' &&
      url.password === '' &&
      url.pathname.startsWith(DATAVERSE_API_PATH)
    );
  }

  private async acquireToken(): Promise<{ token: string } | { reason: ReasonCode }> {
    let token: string;
    try {
      ({ token } = await this.tokens.getAccessToken({
        authorityHost: PUBLIC_CLOUD_AUTHORITY_HOST,
        authorityTenantId: this.target.auth.authorityTenantId,
        clientId: this.target.auth.clientId,
        scopes: [`${this.origin}/user_impersonation`],
      }));
    } catch {
      return { reason: 'TOKEN_ACQUISITION_FAILED' };
    }
    const claims = typeof token === 'string' ? decodeJwtClaims(token) : undefined;
    if (claims === undefined) {
      return { reason: 'TOKEN_UNVERIFIABLE' };
    }
    const audiences = (Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']]).filter((a): a is string => typeof a === 'string');
    if (!audiences.some((a) => a.replace(/\/+$/, '') === this.origin)) {
      return { reason: 'TOKEN_AUDIENCE_MISMATCH' };
    }
    if (claims['tid'] !== this.target.expectedTarget.tenantId) {
      return { reason: 'TOKEN_TENANT_MISMATCH' };
    }
    if (typeof claims['exp'] === 'number' && claims['exp'] * 1000 <= this.clock.now()) {
      return { reason: 'TOKEN_ACQUISITION_FAILED' };
    }
    return { token };
  }

  private retryDelayMs(retryAfter: string | null, attempt: number): number {
    if (retryAfter !== null) {
      const trimmed = retryAfter.trim();
      if (/^\d{1,6}$/.test(trimmed)) {
        return Number(trimmed) * 1000;
      }
      const date = Date.parse(trimmed);
      if (!Number.isNaN(date)) {
        return Math.max(0, date - this.clock.now());
      }
    }
    return Math.min(this.options.baseBackoffMs * 2 ** attempt, this.options.maxBackoffMs);
  }

  private async getJson(url: string): Promise<{ ok: true; body: JsonObject; requestId: string | null } | ReadFailure> {
    if (!this.isTrustedUrl(url)) {
      return failure('TRANSPORT_ORIGIN_REJECTED');
    }
    const startedAt = this.clock.now();
    const acquired = await this.acquireToken();
    if ('reason' in acquired) {
      return failure(acquired.reason);
    }
    for (let attempt = 0; ; attempt++) {
      const remaining = this.options.totalDeadlineMs - (this.clock.now() - startedAt);
      if (remaining <= 0) {
        return failure('TRANSPORT_DEADLINE_EXCEEDED');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.options.requestTimeoutMs, remaining));
      let response: HttpResponseLike;
      let text: string | undefined;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${acquired.token}`,
            Accept: 'application/json',
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
          },
          redirect: 'manual',
          signal: controller.signal,
        });
        if (response.status === 200) {
          const declared = Number(response.headers.get('content-length') ?? '0');
          if (declared > this.options.maxResponseBytes) {
            controller.abort();
            return failure('TRANSPORT_RESPONSE_TOO_LARGE', 200, safeRequestId(response.headers));
          }
          text = await readBounded(response, this.options.maxResponseBytes, controller);
          if (text === undefined) {
            return failure('TRANSPORT_RESPONSE_TOO_LARGE', 200, safeRequestId(response.headers));
          }
        }
      } catch {
        return failure(controller.signal.aborted ? 'TRANSPORT_TIMEOUT' : 'TRANSPORT_NETWORK_ERROR');
      } finally {
        clearTimeout(timer);
      }
      const status = response.status;
      const requestId = safeRequestId(response.headers);
      if (status === 0 || (status >= 300 && status < 400)) {
        return failure('TRANSPORT_REDIRECT_REJECTED', status, requestId);
      }
      if (status === 401) {
        return failure('TRANSPORT_UNAUTHENTICATED', status, requestId);
      }
      if (status === 403) {
        return failure('TRANSPORT_FORBIDDEN', status, requestId);
      }
      if (status === 429 || status === 503) {
        if (attempt >= this.options.maxRetries) {
          return failure('TRANSPORT_THROTTLED_EXHAUSTED', status, requestId);
        }
        const delay = this.retryDelayMs(response.headers.get('retry-after'), attempt);
        if (delay > this.options.maxBackoffMs) {
          return failure('TRANSPORT_THROTTLED_EXHAUSTED', status, requestId);
        }
        if (this.clock.now() - startedAt + delay >= this.options.totalDeadlineMs) {
          return failure('TRANSPORT_DEADLINE_EXCEEDED', status, requestId);
        }
        await this.clock.sleep(delay);
        continue;
      }
      if (status !== 200 || text === undefined) {
        return failure('TRANSPORT_HTTP_ERROR', status, requestId);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return failure('TRANSPORT_RESPONSE_INVALID', status, requestId);
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return failure('TRANSPORT_RESPONSE_INVALID', status, requestId);
      }
      return { ok: true, body: body as JsonObject, requestId };
    }
  }

  private async getAllPages(firstUrl: string): Promise<ReadResult<JsonValue[]>> {
    const items: JsonValue[] = [];
    const gaps: ReasonCode[] = [];
    const requestIds: string[] = [];
    let url = firstUrl;
    for (let page = 0; ; page++) {
      if (page >= this.options.maxPages) {
        gaps.push('TRANSPORT_PAGE_LIMIT_REACHED');
        break;
      }
      const response = await this.getJson(url);
      if (!response.ok) {
        if (page === 0) {
          return response;
        }
        gaps.push(response.reasonCode);
        break;
      }
      if (response.requestId !== null) {
        requestIds.push(response.requestId);
      }
      const value = response.body['value'];
      if (!Array.isArray(value)) {
        if (page === 0) {
          return failure('TRANSPORT_RESPONSE_INVALID', 200, response.requestId);
        }
        gaps.push('TRANSPORT_RESPONSE_INVALID');
        break;
      }
      items.push(...value);
      const next = response.body['@odata.nextLink'];
      if (next === undefined) {
        break;
      }
      if (typeof next !== 'string' || !this.isTrustedContinuation(firstUrl, next)) {
        gaps.push('TRANSPORT_NEXT_LINK_REJECTED');
        break;
      }
      url = next;
    }
    return { ok: true, value: items, completeness: gaps.length > 0 ? 'partial' : 'complete', gaps, requestIds };
  }
}
