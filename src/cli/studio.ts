import { mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextFile } from '../core/documents.js';
import { checkSpecText, deploy, offlineBinding, writeSolutionFolder, type DeployResult } from '../studio/deploy.js';
import { lastLines, pacError, PacClient, PacNotFoundError, type PacRunner } from '../studio/pac.js';
import { buildSolutionFiles } from '../studio/solution.js';
import { starterSpec, type Issue } from '../studio/spec.js';

/** The simple four-step flow: new/load → check → envs/login → deploy (plus an offline build). */
export const STUDIO_COMMANDS: Readonly<Record<string, { values: readonly string[]; flags: readonly string[]; required: readonly string[]; usage: string; summary: string }>> = {
  new: { values: ['--kind', '--out'], flags: [], required: ['--kind', '--out'], usage: 'new --kind instant|automated --out <file>', summary: '1. Create a starter plug-in spec (never overwrites).' },
  check: { values: ['--spec'], flags: ['--json'], required: ['--spec'], usage: 'check --spec <file> [--json]', summary: '2. Check the spec and the Power Fx syntax offline.' },
  login: { values: [], flags: [], required: [], usage: 'login', summary: '3. Sign in through pac (opens your browser).' },
  envs: { values: ['--select'], flags: ['--json'], required: [], usage: 'envs [--select <profile index>] [--json]', summary: '3. List pac profiles and the environments you can deploy to.' },
  deploy: { values: ['--spec', '--environment'], flags: ['--json'], required: ['--spec', '--environment'], usage: 'deploy --spec <file> --environment <url> [--json]', summary: '4. Check, build, pack and import the plug-in into the environment.' },
  build: { values: ['--spec', '--out'], flags: [], required: ['--spec', '--out'], usage: 'build --spec <file> --out <new folder>', summary: '   Build the solution offline without importing it (for review).' },
};

export const isStudioCommand = (command: string | undefined): boolean => command !== undefined && Object.hasOwn(STUDIO_COMMANDS, command);

export interface StudioIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  pacRunner: PacRunner;
}

type Parsed = { values: Map<string, string>; flags: Set<string> } | { error: string };

function parse(command: string, argv: readonly string[]): Parsed {
  const spec = STUDIO_COMMANDS[command]!;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (spec.flags.includes(token)) {
      flags.add(token);
    } else if (spec.values.includes(token)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--') || values.has(token)) {
        return { error: `${token} needs exactly one value.` };
      }
      values.set(token, value);
      i++;
    } else {
      return { error: `Unknown argument "${token}". Usage: ${spec.usage}` };
    }
  }
  const missing = spec.required.find((r) => !values.has(r));
  return missing === undefined ? { values, flags } : { error: `${missing} is required. Usage: ${spec.usage}` };
}

function formatIssues(issues: readonly Issue[]): string {
  return issues
    .map((i) => {
      const where = i.line !== undefined ? ` (line ${i.line}, col ${i.column})` : i.path !== undefined ? ` (${i.path})` : '';
      return `  ${i.severity === 'error' ? 'ERROR' : 'warn '} ${i.code}${where}: ${i.message}`;
    })
    .join('\n');
}

async function writeNewFile(path: string, content: string): Promise<string | undefined> {
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'File already exists; choose a new name.' : 'File could not be written.';
  }
}

async function loadSpec(path: string): Promise<string | { error: string }> {
  const loaded = await readTextFile(path, 'spec');
  return loaded.text ?? { error: loaded.diagnostics[0]?.message ?? 'Spec could not be read.' };
}

function formatDeploy(result: DeployResult): string {
  const lines = [`deploy: ${result.status}`];
  for (const s of result.steps) {
    lines.push(`  [${s.status}] ${s.step}: ${s.detail.replace(/\n/g, '\n      ')}`);
  }
  if (result.issues.length > 0) {
    lines.push(formatIssues(result.issues));
  }
  return `${lines.join('\n')}\n`;
}

/** Exit codes match the rest of the tool: 0 ok, 2 blocked, 3 failed or invalid input. */
export async function runStudioCommand(command: string, argv: readonly string[], io: StudioIo): Promise<number> {
  const parsed = parse(command, argv);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n`);
    return 3;
  }
  const { values, flags } = parsed;
  const json = flags.has('--json');
  const pac = new PacClient(io.pacRunner);
  try {
    switch (command) {
      case 'new': {
        const kind = values.get('--kind');
        if (kind !== 'instant' && kind !== 'automated') {
          io.stderr('--kind must be "instant" or "automated".\n');
          return 3;
        }
        const failure = await writeNewFile(values.get('--out')!, `${JSON.stringify(starterSpec(kind), null, 2)}\n`);
        if (failure !== undefined) {
          io.stderr(`${failure}\n`);
          return 3;
        }
        io.stdout(`Created ${values.get('--out')}. Edit it, then run: check --spec ${values.get('--out')}\n`);
        return 0;
      }
      case 'check': {
        const text = await loadSpec(values.get('--spec')!);
        if (typeof text !== 'string') {
          io.stderr(`${text.error}\n`);
          return 3;
        }
        const checked = checkSpecText(text);
        if (json) {
          io.stdout(`${JSON.stringify({ ok: checked.ok, issues: checked.issues }, null, 2)}\n`);
        } else {
          io.stdout(`check: ${checked.ok ? 'passed' : 'failed'}${checked.issues.length === 0 ? '' : `\n${formatIssues(checked.issues)}`}\n`);
          if (checked.ok) io.stdout('Syntax only: the environment compiles the formula during deploy.\n');
        }
        return checked.ok ? 0 : 3;
      }
      case 'login': {
        io.stdout('Opening pac sign-in in your browser…\n');
        const result = await pac.login();
        io.stdout(`${lastLines(result.output)}\n`);
        return result.code === 0 ? 0 : 3;
      }
      case 'envs': {
        const select = values.get('--select');
        if (select !== undefined) {
          if (!/^\d{1,3}$/.test(select)) {
            io.stderr('--select must be a profile index from the list.\n');
            return 3;
          }
          const selected = await pac.selectProfile(Number(select));
          if (selected.code !== 0) {
            io.stderr(`${lastLines(selected.output)}\n`);
            return 3;
          }
        }
        const profiles = await pac.profiles();
        const { environments, result } = await pac.environments();
        if (json) {
          io.stdout(`${JSON.stringify({ profiles, environments }, null, 2)}\n`);
        } else {
          io.stdout('Profiles:\n');
          io.stdout(profiles.length === 0 ? '  none — run: login\n' : profiles.map((p) => `  [${p.index}]${p.active ? '*' : ' '} ${p.user} ${p.environment}\n`).join(''));
          io.stdout('Environments:\n');
          io.stdout(
            result.code !== 0
              ? `  pac env list failed: ${pacError(result.output)}\n`
              : environments.map((e) => `  ${e.active ? '*' : ' '} ${e.name.padEnd(30)} ${e.type.padEnd(11)} ${e.url}\n`).join(''),
          );
        }
        return result.code === 0 ? 0 : 3;
      }
      case 'build': {
        const text = await loadSpec(values.get('--spec')!);
        if (typeof text !== 'string') {
          io.stderr(`${text.error}\n`);
          return 3;
        }
        const checked = checkSpecText(text);
        if (!checked.ok || checked.spec === undefined) {
          io.stdout(`build: blocked by check errors\n${formatIssues(checked.issues)}\n`);
          return 2;
        }
        const out = values.get('--out')!;
        const existing = await readdir(out).catch(() => undefined);
        if (existing !== undefined && existing.length > 0) {
          io.stderr('--out must be a new or empty folder.\n');
          return 3;
        }
        await mkdir(out, { recursive: true });
        const folder = join(out, 'solution');
        await writeSolutionFolder(buildSolutionFiles(checked.spec, offlineBinding(checked.spec)), folder);
        io.stdout(`Solution folder: ${folder}\n`);
        const zip = join(out, `${checked.spec.solution.uniqueName}.zip`);
        try {
          const packed = await pac.pack(folder, zip);
          io.stdout(packed.code === 0 ? `Packed: ${zip}\n` : `pac solution pack failed:\n${lastLines(packed.output)}\n`);
          return packed.code === 0 ? 0 : 3;
        } catch (error) {
          if (error instanceof PacNotFoundError) {
            io.stdout('pac not found; skipped packing.\n');
            return 0;
          }
          throw error;
        }
      }
      case 'deploy': {
        const text = await loadSpec(values.get('--spec')!);
        if (typeof text !== 'string') {
          io.stderr(`${text.error}\n`);
          return 3;
        }
        const result = await deploy({ specText: text, environmentUrl: values.get('--environment')!, pac });
        io.stdout(json ? `${JSON.stringify(result, null, 2)}\n` : formatDeploy(result));
        return result.status === 'succeeded' ? 0 : result.status === 'blocked' ? 2 : 3;
      }
    }
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : 'Unexpected error.'}\n`);
    return 3;
  }
  return 3;
}

export function studioHelp(toolName: string): string {
  return [
    `${toolName} — build and deploy Dataverse low-code plug-ins (instant Functions and automated plug-ins).`,
    'Sign-in, environments and solution import use the Power Platform CLI (pac).',
    '',
    ...Object.values(STUDIO_COMMANDS).map((c) => `  ${toolName} ${c.usage}\n      ${c.summary}`),
    `  ${toolName} ui [--port <number>] [--open]`,
    '      Same four steps in a local browser UI.',
    '',
  ].join('\n');
}
