import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli/run.js';
import type { JsonValue } from '../src/contracts/common.js';
import type { CommandResult } from '../src/contracts/result.js';
import type { Snapshot } from '../src/contracts/snapshot.js';
import type { FunctionSpec } from '../src/contracts/spec.js';
import type { TargetConfig } from '../src/contracts/target.js';
import { buildPlan } from '../src/core/planner.js';
import { hashCanonical } from '../src/core/canonical.js';
import type { Plan } from '../src/contracts/plan.js';

/** Compiled helpers live in dist/tests, so the project root is two levels up. */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const examplePath = (name: string): string => join(ROOT, 'examples', name);

export async function readExample<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(examplePath(name), 'utf8')) as T;
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function exampleSpec(): Promise<FunctionSpec> {
  return readExample<FunctionSpec>('calculation.spec.json');
}
export async function exampleTarget(): Promise<TargetConfig> {
  return readExample<TargetConfig>('synthetic.target.json');
}
export async function convergedSnapshot(): Promise<Snapshot> {
  return readExample<Snapshot>('converged.snapshot.json');
}
export async function driftedSnapshot(): Promise<Snapshot> {
  return readExample<Snapshot>('drifted.snapshot.json');
}

export function planFor(spec: FunctionSpec, snapshot?: Snapshot, target?: TargetConfig): Plan {
  const outcome = buildPlan({
    spec,
    ...(snapshot !== undefined ? { snapshot: { value: snapshot, sha256: hashCanonical(snapshot) } } : {}),
    ...(target !== undefined ? { target } : {}),
  });
  if (outcome.kind !== 'planned') {
    throw new Error(`Expected a plan, got blocked: ${outcome.reasonCodes.join(', ')}`);
  }
  return outcome.plan;
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dv-native-test-'));
}

export async function writeJson(dir: string, name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  return path;
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  result: CommandResult | undefined;
}

export async function cli(argv: string[], now = new Date('2026-10-15T10:00:00Z')): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), now: () => now });
  let result: CommandResult | undefined;
  if (argv.includes('--json')) {
    result = JSON.parse(stdout) as CommandResult;
  }
  return { code, stdout, stderr, result };
}

export const asJsonValue = (value: unknown): JsonValue => value as JsonValue;
