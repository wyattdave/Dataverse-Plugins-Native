import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalizeEnvironmentUrl, type HttpFetch, type TokenSource } from './dataverse.js';
import type { ProfileStore, StoredProfile, StoredProfiles } from './profileStore.js';

/**
 * Interactive sign-in the same way the Power Apps CLI (codeapp-js-cli / MSAL) does it: the Power Apps first-party public
 * client, authorization code + PKCE in the system browser, redirected to a one-shot http://localhost listener, with
 * `<resource>/.default` scopes. Refresh tokens are remembered per account as profiles; access tokens stay in memory.
 */

export const POWER_APPS_CLIENT_ID = '9cee029c-6210-4654-90bb-17e6e9d36617';
/** Resource for the Power Platform (BAP) environment list. */
export const POWER_APPS_RESOURCE = 'https://service.powerapps.com/';

const AUTHORITY = 'https://login.microsoftonline.com';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
const EXPIRY_MARGIN_MS = 5 * 60_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProfileView {
  id: string;
  username: string;
  name: string;
  tenantId: string;
  lastUsed: string;
  /** The remembered sign-in no longer works; the user must reconnect. */
  needsReauth: boolean;
}

export interface AuthStatus {
  state: 'signed-out' | 'pending' | 'signed-in';
  active?: ProfileView;
  /** Most recently used first. */
  profiles: ProfileView[];
  /** While pending: the page to open if the browser did not. */
  authorizeUrl?: string;
  error?: string;
}

export class SignInRequiredError extends Error {
  constructor(message = 'Sign in first.') {
    super(message);
    this.name = 'SignInRequiredError';
  }
}

export interface LoginOptions {
  /** Show the account picker (add another account). */
  selectAccount?: boolean;
  /** Sign the active profile in again. */
  reconnect?: boolean;
}

export interface AuthOptions {
  store: ProfileStore;
  fetch?: HttpFetch;
  /** Opens the sign-in page in the user's browser. */
  openUrl: (url: string) => void;
}

const base64Url = (bytes: Buffer): string => bytes.toString('base64url');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const scopeFor = (resource: string): string => `${resource}/.default`;

/** Only the Power Platform resource and Dataverse origins ever get a token. */
function isAllowedResource(resource: string): boolean {
  return resource === POWER_APPS_RESOURCE || (/^https:\/\/[^/]+$/.test(resource) && normalizeEnvironmentUrl(resource) === `${resource.toLowerCase()}/`);
}

/** AAD error text without the trace/correlation footer. */
function describeAadError(data: unknown): string {
  if (!isRecord(data)) {
    return 'Sign-in failed.';
  }
  const description = typeof data['error_description'] === 'string' ? data['error_description'].split(/\r?\n|Trace ID:/)[0]!.trim() : '';
  const code = typeof data['error'] === 'string' ? data['error'] : 'error';
  return `${code}: ${description}`.slice(0, 500);
}

function claimsOf(idToken: unknown): Record<string, unknown> {
  const payload = typeof idToken === 'string' ? idToken.split('.')[1] : undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** One-shot loopback listener for the authorization response. Only a response carrying our `state` completes it. */
function listenForRedirect(state: string): Promise<{ port: number; code: Promise<string>; cancel: (reason: string) => void }> {
  return new Promise((resolveListen, rejectListen) => {
    let settle: (error: Error | undefined, code?: string) => void = () => undefined;
    const code = new Promise<string>((resolve, reject) => {
      settle = (error, value) => (error === undefined ? resolve(value!) : reject(error));
    });
    let finished = false;
    const finish = (error: Error | undefined, value?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      server.closeIdleConnections();
      settle(error, value);
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const params = url.searchParams;
      if (req.method !== 'GET' || url.pathname !== '/' || params.get('state') !== state) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const error = params.get('error');
      const value = params.get('code') ?? '';
      const ok = error === null && value !== '';
      res.writeHead(ok ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>dv-native</title><p style="font:16px system-ui;margin:40px">${
          ok ? 'Signed in. You can close this tab and return to dv-native.' : 'Sign-in did not complete. Return to dv-native for details.'
        }</p>`,
      );
      finish(ok ? undefined : new Error(describeAadError({ error: error ?? 'no_code', error_description: params.get('error_description') ?? '' })), value);
    });
    const timer = setTimeout(() => finish(new Error('Sign-in timed out; start it again.')), SIGN_IN_TIMEOUT_MS);
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      resolveListen({ port: (server.address() as AddressInfo).port, code, cancel: (reason) => finish(new Error(reason)) });
    });
  });
}

export class Auth implements TokenSource {
  private readonly fetchImpl: HttpFetch;
  private data: StoredProfiles | undefined;
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly needsReauth = new Set<string>();
  private pending: { authorizeUrl: string; done: Promise<ProfileView>; cancel: (reason: string) => void } | undefined;
  private lastError: string | undefined;

  constructor(private readonly options: AuthOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  private async profiles(): Promise<StoredProfiles> {
    this.data ??= await this.options.store.load();
    return this.data;
  }

  private view(profile: StoredProfile): ProfileView {
    const { refreshToken: _secret, ...rest } = profile;
    return { ...rest, needsReauth: this.needsReauth.has(profile.id) };
  }

  private async active(): Promise<StoredProfile | undefined> {
    const data = await this.profiles();
    return data.profiles.find((p) => p.id === data.activeId);
  }

  async status(): Promise<AuthStatus> {
    const data = await this.profiles();
    const profiles = [...data.profiles].sort((a, b) => b.lastUsed.localeCompare(a.lastUsed)).map((p) => this.view(p));
    const active = profiles.find((p) => p.id === data.activeId);
    const base = { profiles, ...(active === undefined ? {} : { active }), ...(this.lastError === undefined ? {} : { error: this.lastError }) };
    if (this.pending !== undefined) {
      return { ...base, state: 'pending', authorizeUrl: this.pending.authorizeUrl };
    }
    return { ...base, state: active === undefined ? 'signed-out' : 'signed-in' };
  }

  /** Starts a browser sign-in and returns the authorize URL; a sign-in already in progress is reused. */
  async startLogin(options: LoginOptions = {}): Promise<string> {
    if (this.pending !== undefined) {
      return this.pending.authorizeUrl;
    }
    const active = options.reconnect === true ? await this.active() : undefined;
    const verifier = base64Url(randomBytes(32));
    const state = base64Url(randomBytes(16));
    const loopback = await listenForRedirect(state);
    const redirectUri = `http://localhost:${loopback.port}`;
    const scope = `${scopeFor(POWER_APPS_RESOURCE)} offline_access openid profile`;
    const query = new URLSearchParams({
      client_id: POWER_APPS_CLIENT_ID,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: base64Url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    if (options.selectAccount === true) {
      query.set('prompt', 'select_account');
    } else if (active !== undefined) {
      query.set('login_hint', active.username);
    }
    const authorizeUrl = `${AUTHORITY}/organizations/oauth2/v2.0/authorize?${query.toString()}`;
    let current = true;
    const done: Promise<ProfileView> = (async () => {
      try {
        const code = await loopback.code;
        const result = await this.tokenRequest('organizations', {
          client_id: POWER_APPS_CLIENT_ID,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          scope,
        });
        if (!current) {
          throw new SignInRequiredError('Sign-in cancelled.');
        }
        const profile = await this.remember(result);
        this.lastError = undefined;
        return this.view(profile);
      } catch (error) {
        if (current) {
          this.lastError = error instanceof Error ? error.message : 'Sign-in failed.';
        }
        throw error;
      } finally {
        if (current) {
          this.pending = undefined;
        }
      }
    })();
    done.catch(() => undefined);
    this.pending = {
      authorizeUrl,
      done,
      cancel: (reason) => {
        current = false;
        loopback.cancel(reason);
      },
    };
    this.lastError = undefined;
    this.options.openUrl(authorizeUrl);
    return authorizeUrl;
  }

  /** Resolves when the sign-in started by startLogin completes. */
  async waitForLogin(): Promise<ProfileView> {
    if (this.pending === undefined) {
      throw new SignInRequiredError(this.lastError ?? 'No sign-in is in progress.');
    }
    return this.pending.done;
  }

  cancelLogin(): void {
    this.pending?.cancel('Sign-in cancelled.');
    this.pending = undefined;
    this.lastError = undefined;
  }

  async useProfile(id: string): Promise<void> {
    const data = await this.profiles();
    const profile = data.profiles.find((p) => p.id === id);
    if (profile === undefined) {
      throw new SignInRequiredError('That profile no longer exists.');
    }
    profile.lastUsed = new Date().toISOString();
    data.activeId = id;
    await this.options.store.save(data);
  }

  /** Forgets a remembered sign-in; the most recently used remaining profile becomes active. */
  async removeProfile(id: string): Promise<void> {
    const data = await this.profiles();
    data.profiles = data.profiles.filter((p) => p.id !== id);
    if (data.activeId === id) {
      data.activeId = [...data.profiles].sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))[0]?.id;
    }
    for (const key of [...this.tokens.keys()].filter((k) => k.startsWith(`${id} `))) {
      this.tokens.delete(key);
    }
    this.needsReauth.delete(id);
    await this.options.store.save(data);
  }

  /** Access token for the active profile; `resource` is POWER_APPS_RESOURCE or a Dataverse origin. */
  async getToken(resource: string): Promise<string> {
    if (!isAllowedResource(resource)) {
      throw new Error('Tokens are only issued for Power Platform and Dataverse.');
    }
    const profile = await this.active();
    if (profile === undefined) {
      throw new SignInRequiredError();
    }
    const key = `${profile.id} ${resource}`;
    const cached = this.tokens.get(key);
    if (cached !== undefined && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return cached.value;
    }
    let result: Record<string, unknown>;
    try {
      result = await this.tokenRequest(profile.tenantId, {
        client_id: POWER_APPS_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: profile.refreshToken,
        scope: `${scopeFor(resource)} offline_access`,
      });
    } catch (error) {
      if (error instanceof SignInRequiredError) {
        this.needsReauth.add(profile.id);
        throw new SignInRequiredError(`The sign-in for ${profile.username} has expired; reconnect.`);
      }
      throw error;
    }
    this.needsReauth.delete(profile.id);
    if (typeof result['refresh_token'] === 'string' && result['refresh_token'] !== profile.refreshToken) {
      profile.refreshToken = result['refresh_token'];
      await this.options.store.save(await this.profiles()).catch(() => undefined);
    }
    return this.cacheToken(key, result);
  }

  private async remember(result: Record<string, unknown>): Promise<StoredProfile> {
    const claims = claimsOf(result['id_token']);
    const tenantId = typeof claims['tid'] === 'string' && GUID.test(claims['tid']) ? claims['tid'].toLowerCase() : '';
    const objectId = typeof claims['oid'] === 'string' && GUID.test(claims['oid']) ? claims['oid'].toLowerCase() : '';
    if (tenantId === '' || objectId === '' || typeof result['refresh_token'] !== 'string') {
      throw new Error('The sign-in response did not identify the account.');
    }
    const username = typeof claims['preferred_username'] === 'string' ? claims['preferred_username'] : objectId;
    const data = await this.profiles();
    const profile: StoredProfile = {
      id: `${objectId}.${tenantId}`,
      username,
      name: typeof claims['name'] === 'string' ? claims['name'] : username,
      tenantId,
      lastUsed: new Date().toISOString(),
      refreshToken: result['refresh_token'],
    };
    data.profiles = [...data.profiles.filter((p) => p.id !== profile.id), profile];
    data.activeId = profile.id;
    this.needsReauth.delete(profile.id);
    this.cacheToken(`${profile.id} ${POWER_APPS_RESOURCE}`, result);
    await this.options.store.save(data);
    return profile;
  }

  private cacheToken(key: string, result: Record<string, unknown>): string {
    const value = result['access_token'] as string;
    const seconds = Number(result['expires_in'] ?? 0);
    this.tokens.set(key, { value, expiresAt: Date.now() + (Number.isFinite(seconds) ? seconds : 0) * 1000 });
    return value;
  }

  private async tokenRequest(tenant: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(body).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Could not reach the Microsoft sign-in service.');
    }
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok || !isRecord(data) || typeof data['access_token'] !== 'string') {
      const message = describeAadError(data);
      if (isRecord(data) && (data['error'] === 'invalid_grant' || data['error'] === 'interaction_required')) {
        throw new SignInRequiredError(message);
      }
      throw new Error(message);
    }
    return data;
  }
}
