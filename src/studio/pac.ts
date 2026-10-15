import { spawn } from 'node:child_process';
import { redactText } from '../core/redact.js';

/**
 * Thin wrapper over the Power Platform CLI (pac). pac owns sign-in and token storage; this tool never sees tokens.
 * Commands are spawned without a shell and with fixed argument arrays, so no value is ever interpreted by a shell.
 */

export interface PacResult {
  code: number;
  output: string;
}

export type PacRunner = (args: readonly string[], options?: { timeoutMs?: number }) => Promise<PacResult>;

export class PacNotFoundError extends Error {
  constructor() {
    super('Power Platform CLI (pac) was not found on PATH. Install it from https://aka.ms/PowerPlatformCLI.');
    this.name = 'PacNotFoundError';
  }
}

const MAX_OUTPUT = 2_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export function createPacRunner(executable = 'pac'): PacRunner {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const append = (chunk: Buffer): void => {
        if (output.length < MAX_OUTPUT) {
          output += chunk.toString('utf8');
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => child.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(error.code === 'ENOENT' ? new PacNotFoundError() : error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output: redactText(output, MAX_OUTPUT) });
      });
    });
}

const URL_PATTERN = /https:\/\/[^\s]+/i;
const GUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_PATTERN = /\S+@\S+\.\S+/;
const ENV_TYPES = ['Production', 'Sandbox', 'Developer', 'Default', 'Trial', 'Teams'] as const;

/** Allowed Dataverse hosts (commercial and sovereign clouds). */
const DATAVERSE_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(dynamics\.com|dynamics\.cn|microsoftdynamics\.us|appsplatform\.us|microsoftdynamics\.de)\/?$/i;

export function normalizeEnvironmentUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!DATAVERSE_URL.test(trimmed)) {
    return undefined;
  }
  return `${trimmed.replace(/\/+$/, '').toLowerCase()}/`;
}

export interface AuthProfile {
  index: number;
  active: boolean;
  user: string;
  environment: string;
  environmentUrl: string;
}

/** Parses `pac auth list`. Columns are whitespace aligned, so fields are found by shape rather than position. */
export function parseAuthList(output: string): AuthProfile[] {
  const profiles: AuthProfile[] = [];
  for (const line of output.split(/\r?\n/)) {
    const index = /^\s*\[(\d+)\]\s*(\*)?/.exec(line);
    if (index === null) {
      continue;
    }
    const user = EMAIL_PATTERN.exec(line);
    const url = URL_PATTERN.exec(line);
    let environment = '';
    if (user !== null && url !== null && url.index > user.index) {
      // After the user: Cloud, auth Type, then the environment display name.
      environment = line.slice(user.index + user[0].length, url.index).trim().split(/\s+/).slice(2).join(' ');
    }
    profiles.push({
      index: Number(index[1]),
      active: index[2] === '*',
      user: user?.[0] ?? '',
      environment,
      environmentUrl: url === null ? '' : (normalizeEnvironmentUrl(url[0]) ?? ''),
    });
  }
  return profiles;
}

export interface PacEnvironment {
  name: string;
  id: string;
  url: string;
  active: boolean;
  /** Only known when pac prints it; otherwise "Unknown". */
  type: (typeof ENV_TYPES)[number] | 'Unknown';
}

/** Parses `pac env list`: one environment per line containing a Dataverse URL. */
export function parseEnvList(output: string): PacEnvironment[] {
  const envs: PacEnvironment[] = [];
  for (const line of output.split(/\r?\n/)) {
    const url = URL_PATTERN.exec(line);
    const normalized = url === null ? undefined : normalizeEnvironmentUrl(url[0]);
    if (url === null || normalized === undefined) {
      continue;
    }
    const guid = new RegExp(GUID_PATTERN.source, 'i').exec(line);
    const before = line.slice(0, guid !== null && guid.index < url.index ? guid.index : url.index);
    const active = /^\s*(\[\d+\]\s*)?\*/.test(line);
    const name = before.replace(/^\s*(\[\d+\]\s*)?\*?\s*/, '').trim();
    const rest = `${before} ${line.slice(url.index + url[0].length)}`;
    const type = ENV_TYPES.find((t) => new RegExp(`\\b${t}\\b`).test(rest.replace(name, ''))) ?? 'Unknown';
    envs.push({ name, id: guid?.[0].toLowerCase() ?? '', url: normalized, active, type });
  }
  return envs;
}

/**
 * Reads GUID values of one attribute from `pac env fetch` output. Values are only taken from lines after the header
 * row that names the attribute, so unrelated GUIDs printed by pac cannot be mistaken for results.
 */
export function parseFetchGuids(output: string, attribute: string): string[] | undefined {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((l) => new RegExp(`\\b${attribute}\\b`, 'i').test(l));
  if (header === -1) {
    return new RegExp(GUID_PATTERN.source, 'i').test(output) ? undefined : [];
  }
  const ids = new Set<string>();
  for (const line of lines.slice(header + 1)) {
    for (const match of line.matchAll(GUID_PATTERN)) {
      ids.add(match[0].toLowerCase());
    }
  }
  return [...ids];
}

export class PacClient {
  constructor(private readonly run: PacRunner) {}

  async profiles(): Promise<AuthProfile[]> {
    const result = await this.run(['auth', 'list']);
    return result.code === 0 ? parseAuthList(result.output) : [];
  }

  /** Interactive browser sign-in handled entirely by pac. */
  async login(): Promise<PacResult> {
    return this.run(['auth', 'create'], { timeoutMs: 300_000 });
  }

  async selectProfile(index: number): Promise<PacResult> {
    return this.run(['auth', 'select', '--index', String(index)]);
  }

  async environments(): Promise<{ environments: PacEnvironment[]; result: PacResult }> {
    const result = await this.run(['env', 'list']);
    return { environments: result.code === 0 ? parseEnvList(result.output) : [], result };
  }

  async fetchGuids(environmentUrl: string, xmlFile: string, attribute: string): Promise<string[] | undefined> {
    const result = await this.run(['env', 'fetch', '--environment', environmentUrl, '--xmlFile', xmlFile]);
    if (result.code !== 0) {
      throw new Error(`pac env fetch failed: ${pacError(result.output)}`);
    }
    return parseFetchGuids(result.output, attribute);
  }

  async pack(folder: string, zipFile: string): Promise<PacResult> {
    return this.run(['solution', 'pack', '--zipfile', zipFile, '--folder', folder, '--packagetype', 'Unmanaged']);
  }

  async importSolution(environmentUrl: string, zipFile: string): Promise<PacResult> {
    return this.run(['solution', 'import', '--environment', environmentUrl, '--path', zipFile], { timeoutMs: 1_200_000 });
  }
}

export function lastLines(output: string, count = 6): string {
  return output
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-count)
    .join('\n');
}

/** The first "Error:" line pac printed (without its version banner), or the last lines when there is none. */
export function pacError(output: string): string {
  const line = output.split(/\r?\n/).find((l) => /^\s*Error:/i.test(l));
  const message = line === undefined ? lastLines(output, 3) : line.trim();
  return /AADSTS(50173|700082|70043|50078|50076)|interaction_required|expired/i.test(message) ? `${message}\nSign in again with pac (login).` : message;
}
