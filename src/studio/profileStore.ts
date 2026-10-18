import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Remembered sign-ins (profiles) with their refresh tokens. On Windows the file is encrypted for the current user with
 * DPAPI (via the built-in Windows PowerShell, so nothing extra is installed); elsewhere it is a 0600 file, like the MSAL
 * plaintext fallback cache.
 */

export interface StoredProfile {
  /** `<oid>.<tid>`, stable per account and tenant. */
  id: string;
  username: string;
  name: string;
  tenantId: string;
  lastUsed: string;
  refreshToken: string;
}

export interface StoredProfiles {
  activeId: string | undefined;
  profiles: StoredProfile[];
}

export interface ProfileStore {
  load(): Promise<StoredProfiles>;
  save(data: StoredProfiles): Promise<void>;
}

export interface Protector {
  protect(data: Buffer): Promise<Buffer>;
  unprotect(data: Buffer): Promise<Buffer>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 20_000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

export function parseStoredProfiles(json: string): StoredProfiles {
  const empty: StoredProfiles = { activeId: undefined, profiles: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['profiles'])) {
    return empty;
  }
  const profiles = parsed['profiles']
    .filter(isRecord)
    .filter((p) => isText(p['id'], 200) && isText(p['username'], 320) && typeof p['name'] === 'string' && isText(p['tenantId'], 64) && isText(p['lastUsed'], 64) && isText(p['refreshToken']))
    .map((p) => ({
      id: p['id'] as string,
      username: p['username'] as string,
      name: p['name'] as string,
      tenantId: p['tenantId'] as string,
      lastUsed: p['lastUsed'] as string,
      refreshToken: p['refreshToken'] as string,
    }));
  const activeId = typeof parsed['activeId'] === 'string' && profiles.some((p) => p.id === parsed['activeId']) ? parsed['activeId'] : undefined;
  return { activeId, profiles };
}

const DPAPI_SCRIPT = (method: 'Protect' | 'Unprotect'): string =>
  'Add-Type -AssemblyName System.Security; ' +
  '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
  `$out = [Security.Cryptography.ProtectedData]::${method}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  '[Console]::Out.Write([Convert]::ToBase64String($out))';

/** Windows DPAPI (current user) through the in-box Windows PowerShell; data goes over stdin, never the command line. */
export function windowsDpapiProtector(): Protector {
  const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = (method: 'Protect' | 'Unprotect', data: Buffer): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT(method)], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('ascii')));
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(Buffer.from(output.trim(), 'base64')) : reject(new Error(`DPAPI ${method} failed.`))));
      child.stdin.end(data.toString('base64'));
    });
  return { protect: (data) => run('Protect', data), unprotect: (data) => run('Unprotect', data) };
}

export const plainProtector: Protector = { protect: async (data) => data, unprotect: async (data) => data };

export function fileProfileStore(path: string, protector: Protector): ProfileStore {
  let writing: Promise<void> = Promise.resolve();
  return {
    async load() {
      let raw: Buffer;
      try {
        raw = await readFile(path);
      } catch {
        return { activeId: undefined, profiles: [] };
      }
      try {
        return parseStoredProfiles((await protector.unprotect(raw)).toString('utf8'));
      } catch {
        return { activeId: undefined, profiles: [] };
      }
    },
    save(data) {
      const json = JSON.stringify({ version: 1, ...data });
      writing = writing
        .catch(() => undefined)
        .then(async () => {
          const content = await protector.protect(Buffer.from(json, 'utf8'));
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
          try {
            await writeFile(temp, content, { mode: 0o600 });
            await rename(temp, path);
          } catch (error) {
            await rm(temp, { force: true });
            throw error;
          }
        });
      return writing;
    },
  };
}

export function defaultProfileStore(): ProfileStore {
  const windows = process.platform === 'win32';
  return fileProfileStore(join(homedir(), '.dataverse-plugins-native', windows ? 'profiles.dat' : 'profiles.json'), windows ? windowsDpapiProtector() : plainProtector);
}

export function memoryProfileStore(initial: StoredProfiles = { activeId: undefined, profiles: [] }): ProfileStore & { data: StoredProfiles } {
  const store = {
    data: initial,
    load: async () => structuredClone(store.data),
    save: async (data: StoredProfiles) => {
      store.data = structuredClone(data);
    },
  };
  return store;
}
