import type { FetchLike, HttpRequestInit, HttpResponseLike, TokenProvider, TokenRequest, TransportClock } from '../../../src/dataverse/readTransport.js';

/**
 * TEST-ONLY fakes. They simulate responses to exercise orchestration and trust-boundary logic; they are
 * not evidence of any Microsoft protocol and must never be used by production code.
 */
export interface FakeResponseSpec {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export class FakeResponse implements HttpResponseLike {
  readonly headers: { get(name: string): string | null };
  constructor(
    readonly status: number,
    private readonly bodyText: string,
    headers: Record<string, string>,
  ) {
    const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.headers = { get: (name) => lower.get(name.toLowerCase()) ?? null };
  }
  async text(): Promise<string> {
    return this.bodyText;
  }
}

export interface RecordedRequest {
  url: string;
  init: HttpRequestInit;
}

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly queue: (FakeResponseSpec | 'hang')[];

  constructor(responses: (FakeResponseSpec | 'hang')[]) {
    this.queue = [...responses];
  }

  readonly fetch: FetchLike = async (url, init) => {
    this.requests.push({ url, init });
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error('FakeFetch: no scripted response left');
    }
    if (next === 'hang') {
      return new Promise<HttpResponseLike>((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const text = typeof next.body === 'string' ? next.body : next.body === undefined ? '' : JSON.stringify(next.body);
    return new FakeResponse(next.status, text, next.headers ?? {});
  };
}

export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.fake-signature`;
}

export class FakeTokenProvider implements TokenProvider {
  readonly requests: TokenRequest[] = [];
  constructor(private readonly token: string | (() => never)) {}
  async getAccessToken(request: TokenRequest): Promise<{ token: string }> {
    this.requests.push(request);
    if (typeof this.token === 'function') {
      this.token();
    }
    return { token: this.token as string };
  }
}

export class FakeClock implements TransportClock {
  readonly sleeps: number[] = [];
  constructor(private current = Date.parse('2026-10-15T10:00:00Z')) {}
  now(): number {
    return this.current;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }
}
