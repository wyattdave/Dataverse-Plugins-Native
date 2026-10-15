import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { checkSpecText, deploy, type DeployResult } from '../studio/deploy.js';
import { lastLines, pacError, PacClient, type PacRunner } from '../studio/pac.js';
import { applySettings, SETTING_NAMES, SETTING_OPTIONS } from '../studio/settings.js';
import { starterSpec, type Issue } from '../studio/spec.js';
import { isPlainObject } from '../core/schema.js';
import { parseStrictJson } from '../core/strictJson.js';

interface CommandSpec {
  values: readonly string[];
  flags: readonly string[];
  required: readonly string[];
  usage: string;
  summary: string;
}

const SETTINGS_USAGE = '[settings]';

/** The plug-in workflow: new/set → check → login/envs → deploy. Every command accepts --json for agents. */
export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  new: {
    values: ['--kind', '--out', ...SETTING_NAMES],
    flags: ['--json'],
    required: ['--kind', '--out'],
    usage: `new --kind instant|automated --out <file> ${SETTINGS_USAGE} [--json]`,
    summary: 'Create a plug-in spec file from a starter, applying any settings (never overwrites).',
  },
  set: {
    values: ['--spec', ...SETTING_NAMES],
    flags: ['--json'],
    required: ['--spec'],
    usage: `set --spec <file> ${SETTINGS_USAGE} [--json]`,
    summary: 'Change settings or load the formula from a script file (--formula-file); updates the spec in place.',
  },
  check: {
    values: ['--spec'],
    flags: ['--json'],
    required: ['--spec'],
    usage: 'check --spec <file> [--json]',
    summary: 'Check the spec and the Power Fx syntax offline.',
  },
  login: { values: [], flags: ['--json'], required: [], usage: 'login [--json]', summary: 'Sign in through pac (opens a browser for the user).' },
  envs: {
    values: ['--select'],
    flags: ['--json'],
    required: [],
    usage: 'envs [--select <profile index>] [--json]',
    summary: 'List pac profiles and the environments you can deploy to; --select switches profile.',
  },
  deploy: {
    values: ['--spec', '--environment'],
    flags: ['--json'],
    required: ['--spec', '--environment'],
    usage: 'deploy --spec <file> --environment <url|name|id> [--json]',
    summary: 'Check, build, pack and import the plug-in into the environment.',
  },
};

export const isCommand = (command: string | undefined): command is string => command !== undefined && Object.hasOwn(COMMANDS, command);

export interface CommandIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  pacRunner: PacRunner;
}

const MAX_SPEC_BYTES = 1024 * 1024;

class UsageError extends Error {}

function parse(command: string, argv: readonly string[]): Map<string, string> {
  const spec = COMMANDS[command]!;
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (spec.flags.includes(token)) {
      continue;
    }
    if (spec.values.includes(token)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--') || values.has(token)) {
        throw new UsageError(`${token} needs exactly one value.`);
      }
      values.set(token, value);
      i++;
    } else {
      throw new UsageError(`Unknown argument "${token}". Usage: ${spec.usage}`);
    }
  }
  const missing = spec.required.find((r) => !values.has(r));
  if (missing !== undefined) {
    throw new UsageError(`${missing} is required. Usage: ${spec.usage}`);
  }
  return values;
}

function formatIssues(issues: readonly Issue[]): string {
  return issues
    .map((i) => {
      const where = i.line !== undefined ? ` (line ${i.line}, col ${i.column})` : i.path !== undefined ? ` (${i.path})` : '';
      return `  ${i.severity === 'error' ? 'ERROR' : 'warn '} ${i.code}${where}: ${i.message}\n`;
    })
    .join('');
}

const checkLine = (ok: boolean, issues: readonly Issue[]): string =>
  `check: ${ok ? 'passed' : 'failed'}${issues.length === 0 ? '' : ` (${issues.filter((i) => i.severity === 'error').length} error(s), ${issues.filter((i) => i.severity === 'warning').length} warning(s))`}\n${formatIssues(issues)}`;

/** Bounded, strict UTF-8 read of a spec file; a BOM (e.g. from PowerShell 5.1) is ignored. */
async function readSpecFile(path: string): Promise<string> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new UsageError(`Spec file not found: ${path}`);
  }
  if (info.size > MAX_SPEC_BYTES) {
    throw new UsageError('Spec file is larger than 1 MB.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)).replace(/^\uFEFF/, '');
  } catch {
    throw new UsageError('Spec file is not valid UTF-8.');
  }
}

/** New files only (wx); `replace` writes a sibling temp file and renames it over the original. */
async function writeSpecFile(path: string, value: unknown, replace: boolean): Promise<void> {
  const target = replace ? `${path}.${randomBytes(4).toString('hex')}.tmp` : path;
  try {
    const handle = await open(target, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    if (replace) {
      await rename(target, path);
    }
  } catch (error) {
    if (replace) {
      await rm(target, { force: true });
    }
    throw new UsageError((error as NodeJS.ErrnoException).code === 'EEXIST' ? `${path} already exists; use set to change it.` : `Could not write ${path}.`);
  }
}

function describeSpec(spec: Record<string, unknown>): string {
  const solution = isPlainObject(spec['solution']) ? spec['solution'] : {};
  const publisher = isPlainObject(solution['publisher']) ? solution['publisher'] : {};
  return `${String(spec['kind'])} ${String(spec['uniqueName'])} (solution ${String(solution['uniqueName'])}, prefix ${String(publisher['prefix'])})`;
}

function formatDeploy(result: DeployResult): string {
  const lines = [`deploy: ${result.status}`];
  for (const s of result.steps) {
    lines.push(`  [${s.status}] ${s.step}: ${s.detail.replace(/\n/g, '\n      ')}`);
  }
  return `${lines.join('\n')}\n${formatIssues(result.issues)}`;
}

/** Exit codes: 0 ok, 2 blocked, 3 failed or invalid input. With --json, stdout is always exactly one JSON object. */
export async function runCommand(command: string, argv: readonly string[], io: CommandIo): Promise<number> {
  const json = argv.includes('--json');
  const emit = (value: unknown, text: string): void => io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : text);
  try {
    const values = parse(command, argv);
    const pac = new PacClient(io.pacRunner);
    const settings = new Map([...values].filter(([key]) => (SETTING_NAMES as readonly string[]).includes(key)));
    switch (command) {
      case 'new':
      case 'set': {
        let spec: Record<string, unknown>;
        let file: string;
        if (command === 'new') {
          const kind = values.get('--kind');
          if (kind !== 'instant' && kind !== 'automated') {
            throw new UsageError('--kind must be "instant" or "automated".');
          }
          file = values.get('--out')!;
          spec = starterSpec(kind) as unknown as Record<string, unknown>;
        } else {
          if (settings.size === 0) {
            throw new UsageError(`Nothing to set. Settings: ${SETTING_NAMES.join(' ')}`);
          }
          file = values.get('--spec')!;
          let parsed: unknown;
          try {
            parsed = parseStrictJson(await readSpecFile(file));
          } catch (error) {
            throw error instanceof UsageError ? error : new UsageError('Spec file is not valid JSON; fix it or create a new one.');
          }
          if (!isPlainObject(parsed)) {
            throw new UsageError('Spec file must contain a JSON object.');
          }
          spec = parsed;
        }
        await applySettings(spec, settings);
        await writeSpecFile(file, spec, command === 'set');
        const checked = checkSpecText(JSON.stringify(spec));
        emit(
          { file, written: true, check: { ok: checked.ok, issues: checked.issues } },
          `${command === 'new' ? 'Created' : 'Updated'} ${file}: ${describeSpec(spec)}\n${checkLine(checked.ok, checked.issues)}`,
        );
        return 0;
      }
      case 'check': {
        const checked = checkSpecText(await readSpecFile(values.get('--spec')!));
        emit(
          { ok: checked.ok, issues: checked.issues },
          `${checkLine(checked.ok, checked.issues)}${checked.ok ? 'Syntax only: the environment compiles the formula during deploy.\n' : ''}`,
        );
        return checked.ok ? 0 : 3;
      }
      case 'login': {
        if (!json) io.stdout('Opening pac sign-in in a browser…\n');
        const result = await pac.login();
        emit({ ok: result.code === 0, output: lastLines(result.output) }, `${lastLines(result.output)}\n`);
        return result.code === 0 ? 0 : 3;
      }
      case 'envs': {
        const select = values.get('--select');
        if (select !== undefined) {
          if (!/^\d{1,3}$/.test(select)) {
            throw new UsageError('--select must be a profile index from the list.');
          }
          const selected = await pac.selectProfile(Number(select));
          if (selected.code !== 0) {
            throw new UsageError(lastLines(selected.output));
          }
        }
        const profiles = await pac.profiles();
        const { environments, result } = await pac.environments();
        const error = result.code === 0 ? undefined : pacError(result.output);
        emit(
          { profiles, environments, ...(error === undefined ? {} : { error }) },
          [
            'Profiles:\n',
            profiles.length === 0 ? '  none — run: login\n' : profiles.map((p) => `  [${p.index}]${p.active ? '*' : ' '} ${p.user} ${p.environment}\n`).join(''),
            'Environments:\n',
            error !== undefined ? `  pac env list failed: ${error}\n` : environments.map((e) => `  ${e.active ? '*' : ' '} ${e.name.padEnd(30)} ${e.type.padEnd(11)} ${e.url}\n`).join(''),
          ].join(''),
        );
        return error === undefined ? 0 : 3;
      }
      case 'deploy': {
        const result = await deploy({ specText: await readSpecFile(values.get('--spec')!), environment: values.get('--environment')!, pac });
        emit(result, formatDeploy(result));
        return result.status === 'succeeded' ? 0 : result.status === 'blocked' ? 2 : 3;
      }
    }
    return 3;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    if (json) {
      io.stdout(`${JSON.stringify({ error: message }, null, 2)}\n`);
    } else {
      io.stderr(`${message}\n`);
    }
    return 3;
  }
}

export function commandHelp(toolName: string, command?: string): string {
  const settings = Object.entries(SETTING_OPTIONS).map(([option, text]) => `      ${option.padEnd(26)} ${text}\n`).join('');
  if (command !== undefined && isCommand(command)) {
    const c = COMMANDS[command]!;
    return `${toolName} ${c.usage}\n  ${c.summary}\n${c.usage.includes(SETTINGS_USAGE) ? `  settings:\n${settings}` : ''}`;
  }
  return [
    `${toolName} — build and deploy Dataverse low-code plug-ins (instant Functions and automated plug-ins).`,
    'Sign-in, environments and solution import use the Power Platform CLI (pac).',
    '',
    ...Object.values(COMMANDS).map((c) => `  ${toolName} ${c.usage}\n      ${c.summary}`),
    `  ${toolName} ui [--port <number>] [--open]`,
    '      The same steps in a local browser UI.',
    '',
    '  settings (new / set):',
    settings,
    'Exit codes: 0 ok, 2 blocked, 3 failed or invalid input. Use <command> --help for one command.',
    '',
  ].join('\n');
}
