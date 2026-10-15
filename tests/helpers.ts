import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli/run.js';
import type { PacRunner } from '../src/studio/pac.js';

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

export async function cli(argv: string[], pacRunner?: PacRunner): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), ...(pacRunner === undefined ? {} : { pacRunner }) });
  return { code, stdout, stderr };
}
