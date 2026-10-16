import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { runCli, type CliIo } from '../src/cli/run.js';
import { Auth } from '../src/studio/auth.js';
import { DataverseClient, type HttpFetch, type TokenSource } from '../src/studio/dataverse.js';
import { memoryProfileStore, type ProfileStore } from '../src/studio/profileStore.js';

/** Compiled helpers live in dist/tests, so the project root is two levels up. */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const examplePath = (name: string): string => join(ROOT, 'examples', name);

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dv-native-test-'));
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export async function cli(argv: string[], io: Partial<CliIo> = {}): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), ...io });
  return { code, stdout, stderr };
}

export const ENV_URL = 'https://contoso-dev.crm.dynamics.com/';
export const PROD_URL = 'https://contoso.crm.dynamics.com/';
export const DEV_ID = '11111111-2222-3333-4444-555555555555';
export const TENANT_ID = '99999999-8888-7777-6666-555555555555';
export const OBJECT_ID = '12345678-1234-4234-8234-123456789012';
export const MESSAGE_ID = '9ebdbb1b-ea3e-db11-86a7-000a3a5473e8';
export const OPERATION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const SOLUTION_ID = 'cccccccc-0000-4000-8000-000000000002';

export interface FakeCall {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

export interface FakePlatformOptions {
  messages?: string[];
  steps?: string[];
  /** asyncoperation statuscode once completed: 30 succeeded, 31 failed. */
  importStatus?: number;
  importMessage?: string;
  /** The first N imports fail because another customization is running (0x80071151). */
  busyImports?: number;
  tokenError?: { error: string; error_description: string };
  /** Account returned by sign-in; defaults to maker@contoso.com. */
  user?: { oid: string; username: string };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fakeJwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;

/** Fake Entra token endpoint, Power Platform (BAP) API and Dataverse Web API. Records every call; no network. */
export function fakePlatform(options: FakePlatformOptions = {}): { fetch: HttpFetch; calls: FakeCall[]; options: FakePlatformOptions } {
  const calls: FakeCall[] = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ method: init.method ?? 'GET', url, authorization: headers['Authorization'], body });
    if (url.startsWith('https://login.microsoftonline.com/') && url.endsWith('/oauth2/v2.0/token')) {
      if (options.tokenError !== undefined) {
        return json(options.tokenError, 400);
      }
      const form = new URLSearchParams(body);
      const resource = (form.get('scope') ?? '').split(' ')[0]!.replace(/\/\.default$/, '');
      const user = options.user ?? { oid: OBJECT_ID, username: 'maker@contoso.com' };
      return json({
        token_type: 'Bearer',
        access_token: `token-for-${resource}`,
        expires_in: 3600,
        refresh_token: `refresh-${calls.length}`,
        id_token: fakeJwt({ tid: TENANT_ID, oid: user.oid, preferred_username: user.username, name: 'Maker' }),
      });
    }
    if (url.startsWith('https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?')) {
      const env = (name: string, displayName: string, sku: string, instanceUrl: string | undefined, isDefault = false) => ({
        name,
        properties: { displayName, environmentSku: sku, isDefault, ...(instanceUrl === undefined ? {} : { linkedEnvironmentMetadata: { instanceUrl } }) },
      });
      return json({
        value: [
          env(DEV_ID, 'Contoso Dev', 'Sandbox', 'https://Contoso-Dev.crm.dynamics.com'),
          env('66666666-7777-8888-9999-000000000000', 'Contoso Prod', 'Production', PROD_URL),
          env(`Default-${TENANT_ID}`, 'Contoso (default)', 'Production', 'https://orgdefault.crm.dynamics.com/', true),
          env('22222222-2222-2222-2222-222222222222', 'No Dataverse', 'Sandbox', undefined),
        ],
      });
    }
    const path = new URL(url).pathname;
    if (path.endsWith('/sdkmessages')) {
      return json({ value: (options.messages ?? [MESSAGE_ID]).map((id) => ({ sdkmessageid: id })) });
    }
    if (path.endsWith('/sdkmessageprocessingsteps')) {
      return json({ value: (options.steps ?? []).map((id) => ({ sdkmessageprocessingstepid: id })) });
    }
    if (path.endsWith('/ImportSolutionAsync') && init.method === 'POST') {
      return json({ AsyncOperationId: OPERATION_ID, ImportJobKey: 'key' });
    }
    if (path.includes('/asyncoperations(')) {
      if ((options.busyImports ?? 0) > 0) {
        options.busyImports! -= 1;
        return json({
          statecode: 3,
          statuscode: 31,
          friendlymessage: null,
          message: 'Cannot start the requested operation [Import] because there is another [EntityCustomization] running at this moment.',
        });
      }
      return json({ statecode: 3, statuscode: options.importStatus ?? 30, friendlymessage: options.importMessage ?? null, message: null });
    }
    if (path.includes('/importjobs(')) {
      return json({ progress: 50 });
    }
    if (path.endsWith('/solutions')) {
      return json({ value: [{ solutionid: SOLUTION_ID }] });
    }
    return json({ error: { code: '0x0', message: `unexpected call ${url}` } }, 404);
  };
  return { fetch: fetchImpl, calls, options };
}

export const fakeTokens: TokenSource = { getToken: async (origin) => `token-for-${origin}` };

export const fakeDataverse = (fetchImpl: HttpFetch, tokens: TokenSource = fakeTokens): DataverseClient => new DataverseClient(tokens, fetchImpl, 0, [0, 0]);

/** Plays the browser: follows the authorize URL straight to the loopback redirect with a code and the given state. */
export function fakeBrowser(options: { state?: string; error?: string } = {}): { openUrl: (url: string) => void; opened: string[] } {
  const opened: string[] = [];
  const openUrl = (url: string): void => {
    opened.push(url);
    const params = new URL(url).searchParams;
    const redirect = new URL(params.get('redirect_uri')!);
    redirect.hostname = '127.0.0.1';
    redirect.searchParams.set('state', options.state ?? params.get('state')!);
    if (options.error === undefined) {
      redirect.searchParams.set('code', 'auth-code');
    } else {
      redirect.searchParams.set('error', options.error);
      redirect.searchParams.set('error_description', 'AADSTS65001: consent required.\nTrace ID: abc');
    }
    void fetch(redirect).then((r) => r.text()).catch(() => undefined);
  };
  return { openUrl, opened };
}

export function fakeAuth(fetchImpl: HttpFetch, openUrl = fakeBrowser().openUrl, store: ProfileStore = memoryProfileStore()): Auth {
  return new Auth({ store, fetch: fetchImpl, openUrl });
}

/** Reads a zip produced by the packer (deflate or stored entries) into name → content, in central directory order. */
export function unzip(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(start, start + size);
    const content = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    if (crc32(content) !== zip.readUInt32LE(p + 16)) {
      throw new Error(`CRC mismatch for ${name}`);
    }
    entries.set(name, content);
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return entries;
}
