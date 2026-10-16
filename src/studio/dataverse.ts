import { randomUUID } from 'node:crypto';

/**
 * Power Platform (BAP) environment list and Dataverse Web API calls, authenticated with our own sign-in (auth.ts), the
 * same endpoints the Power Apps CLI uses. Tokens only go to BAP or a validated Dataverse host; redirects are refused.
 */

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Supplies a delegated access token for a resource: the Power Apps service or a Dataverse origin. */
export interface TokenSource {
  getToken(resource: string): Promise<string>;
}

const BAP_ORIGIN = 'https://api.bap.microsoft.com';
const BAP_RESOURCE = 'https://service.powerapps.com/';
const API = 'api/data/v9.2';
const REQUEST_TIMEOUT_MS = 120_000;
const IMPORT_TIMEOUT_MS = 20 * 60_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(authorization|proxy-authorization|cookie|set-cookie)(\s*["']?\s*:\s*)[^\r\n]*/gi, '$1$2[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]'],
  [
    /\b(client_secret|client_assertion|access_token|refresh_token|id_token|password|pwd|code_verifier|x-ms-client-secret|sig)(\s*["']?\s*[:=]\s*["']?)[^\s"',;&]*/gi,
    '$1$2[REDACTED]',
  ],
];

/** Keeps tokens and secrets out of anything this tool shows or returns. */
export function redactText(text: string, maxLength: number): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.length > maxLength ? `${out.slice(0, maxLength)}…[TRUNCATED]` : out;
}

/** Allowed Dataverse hosts (commercial and sovereign clouds). */
const DATAVERSE_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(dynamics\.com|dynamics\.cn|microsoftdynamics\.us|appsplatform\.us|microsoftdynamics\.de)\/?$/i;

export function normalizeEnvironmentUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!DATAVERSE_URL.test(trimmed)) {
    return undefined;
  }
  return `${trimmed.replace(/\/+$/, '').toLowerCase()}/`;
}

/** The token resource for a URL (BAP → Power Apps service, Dataverse → its origin), or undefined for anything else. */
export function tokenResource(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const origin = parsed.origin.toLowerCase();
  if (origin === BAP_ORIGIN) {
    return BAP_RESOURCE;
  }
  return normalizeEnvironmentUrl(origin) !== undefined ? origin : undefined;
}

export const ENVIRONMENT_TYPES = ['Production', 'Sandbox', 'Developer', 'Default', 'Trial', 'Teams', 'Unknown'] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

export interface Environment {
  name: string;
  /** Power Platform environment name (a GUID, or Default-<tenant id>). */
  id: string;
  url: string;
  type: EnvironmentType;
}

export class DataverseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataverseError';
  }
}

export interface ImportOutcome {
  ok: boolean;
  detail: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const rowsOf = (data: unknown): Record<string, unknown>[] => (isRecord(data) && Array.isArray(data['value']) ? data['value'].filter(isRecord) : []);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Dataverse refuses to start a solution operation while another customization is running (0x80071151). */
export const isBusyError = (message: string): boolean =>
  /80071151|there is another \[\w+\] running|installation or removal of another solution at the same time/i.test(message);

function errorMessage(status: number, data: unknown): string {
  const error = isRecord(data) && isRecord(data['error']) ? data['error'] : undefined;
  const message = typeof error?.['message'] === 'string' ? error['message'] : '';
  return redactText(`HTTP ${status}${message ? `: ${message}` : ''}`, 1000);
}

export class DataverseClient {
  constructor(
    private readonly tokens: TokenSource,
    private readonly fetchImpl: HttpFetch = (url, init) => fetch(url, init),
    private readonly pollIntervalMs = 2000,
    /** Waits before retrying an import that collided with another customization (publish, import, …). */
    private readonly busyRetryDelaysMs: readonly number[] = [15_000, 30_000, 45_000, 60_000, 60_000, 60_000],
  ) {}

  private async request(url: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<unknown> {
    const resource = tokenResource(url);
    if (resource === undefined) {
      throw new DataverseError('Refusing to send a token to a non-Dataverse URL.');
    }
    const origin = new URL(url).origin;
    const token = await this.tokens.getToken(resource);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DataverseError(`Could not reach ${origin}: ${error instanceof Error ? error.message : 'network error'}`);
    }
    const text = await response.text();
    let data: unknown = {};
    try {
      data = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new DataverseError(errorMessage(response.status, data));
    }
    return data;
  }

  /** Dataverse-backed environments the signed-in user can access, from the Power Platform (BAP) API. */
  async environments(): Promise<Environment[]> {
    const environments: Environment[] = [];
    let next: string | undefined = `${BAP_ORIGIN}/providers/Microsoft.BusinessAppPlatform/environments?api-version=2020-10-01`;
    for (let page = 0; next !== undefined && page < 20; page++) {
      const data = await this.request(next);
      for (const row of rowsOf(data)) {
        const properties = isRecord(row['properties']) ? row['properties'] : {};
        const linked = isRecord(properties['linkedEnvironmentMetadata']) ? properties['linkedEnvironmentMetadata'] : {};
        const url = typeof linked['instanceUrl'] === 'string' ? normalizeEnvironmentUrl(linked['instanceUrl']) : undefined;
        const id = typeof row['name'] === 'string' ? row['name'] : '';
        if (url === undefined || !/^(default-)?[0-9a-f-]{36}$/i.test(id)) {
          continue;
        }
        const sku = typeof properties['environmentSku'] === 'string' ? properties['environmentSku'] : '';
        const type = properties['isDefault'] === true ? 'Default' : (ENVIRONMENT_TYPES.find((t) => t.toLowerCase() === sku.toLowerCase()) ?? 'Unknown');
        environments.push({ name: typeof properties['displayName'] === 'string' ? properties['displayName'] : '', id, url, type });
      }
      const link = isRecord(data) ? data['nextLink'] ?? data['@odata.nextLink'] : undefined;
      next = typeof link === 'string' && link.startsWith(`${BAP_ORIGIN}/`) ? link : undefined;
    }
    return environments.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** Runs a FetchXML query and returns the GUID values of one attribute. */
  async fetchIds(environmentUrl: string, entitySet: string, fetchXml: string, attribute: string): Promise<string[]> {
    const data = await this.request(`${environmentUrl}${API}/${entitySet}?fetchXml=${encodeURIComponent(fetchXml)}`);
    return rowsOf(data)
      .map((row) => row[attribute])
      .filter((id): id is string => typeof id === 'string' && GUID.test(id))
      .map((id) => id.toLowerCase());
  }

  async solutionId(environmentUrl: string, uniqueName: string): Promise<string | undefined> {
    const filter = encodeURIComponent(`uniquename eq '${uniqueName.replace(/'/g, "''")}'`);
    const id = rowsOf(await this.request(`${environmentUrl}${API}/solutions?$select=solutionid&$filter=${filter}`))[0]?.['solutionid'];
    return typeof id === 'string' && GUID.test(id) ? id.toLowerCase() : undefined;
  }

  /**
   * ImportSolutionAsync, then polls the async operation. Unmanaged customizations are not overwritten and
   * processes are not activated. Dataverse runs one customization operation at a time, so an import that collides with
   * another one (0x80071151) is retried after a wait, like pac and Package Deployer do.
   */
  async importSolution(environmentUrl: string, zip: Buffer, onProgress?: (detail: string) => void): Promise<ImportOutcome> {
    const attempts = this.busyRetryDelaysMs.length + 1;
    for (let attempt = 1; ; attempt++) {
      let outcome: ImportOutcome;
      try {
        outcome = await this.importOnce(environmentUrl, zip, onProgress);
      } catch (error) {
        if (!(error instanceof DataverseError) || !isBusyError(error.message)) throw error;
        outcome = { ok: false, detail: error.message };
      }
      const delay = this.busyRetryDelaysMs[attempt - 1];
      if (outcome.ok || !isBusyError(outcome.detail) || delay === undefined) {
        return attempt > 1 && !outcome.ok ? { ok: false, detail: `${outcome.detail}\nGave up after ${attempt} attempts.` } : outcome;
      }
      onProgress?.(
        `Another customization (a publish or another solution import) is running in the environment. Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1} of ${attempts})…`,
      );
      await sleep(delay);
    }
  }

  private async importOnce(environmentUrl: string, zip: Buffer, onProgress?: (detail: string) => void): Promise<ImportOutcome> {
    const importJobId = randomUUID();
    const started = await this.request(`${environmentUrl}${API}/ImportSolutionAsync`, {
      method: 'POST',
      body: { OverwriteUnmanagedCustomizations: false, PublishWorkflows: false, CustomizationFile: zip.toString('base64'), ImportJobId: importJobId },
    });
    const operationId = isRecord(started) ? started['AsyncOperationId'] : undefined;
    if (typeof operationId !== 'string' || !GUID.test(operationId)) {
      throw new DataverseError('ImportSolutionAsync did not return an async operation id.');
    }
    const startedAt = Date.now();
    let pollFailures = 0;
    while (Date.now() - startedAt < IMPORT_TIMEOUT_MS) {
      await sleep(this.pollIntervalMs);
      let operation: unknown;
      try {
        operation = await this.request(`${environmentUrl}${API}/asyncoperations(${operationId})?$select=statecode,statuscode,message,friendlymessage`);
        pollFailures = 0;
      } catch (error) {
        if (++pollFailures >= 3) {
          throw error;
        }
        continue;
      }
      if (isRecord(operation) && operation['statecode'] === 3) {
        if (operation['statuscode'] === 30) {
          return { ok: true, detail: 'Imported.' };
        }
        const message = [operation['friendlymessage'], operation['message']].find((m): m is string => typeof m === 'string' && m.trim().length > 0);
        return { ok: false, detail: redactText(message ?? `Import ended with status ${String(operation['statuscode'])}.`, 4000) };
      }
      const progress = await this.request(`${environmentUrl}${API}/importjobs(${importJobId})?$select=progress`).catch(() => undefined);
      const percent = isRecord(progress) && typeof progress['progress'] === 'number' ? ` ${Math.round(progress['progress'])}%` : '';
      onProgress?.(`Importing…${percent} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }
    return { ok: false, detail: 'Import is still running after 20 minutes; check the solution history in the environment.' };
  }
}
