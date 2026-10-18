import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { installSkill, skillStatus, uninstallSkill } from '../skills/installer.js';
import { skillDestinations } from '../skills/targets.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import type { CliIo } from './run.js';

export const SKILL_HELP = `dataverse-plugins-native skill <install|status|update|uninstall> [--target shared|codex|claude|vscode|opencode|all]
  [--project <directory>] [--backup] [--json]
  Default: shared user-level ~/.agents/skills/dataverse-plugins-native.
  --project explicitly selects project scope instead of your home directory.
  install refuses existing directories unless --backup is given.
  update uses this CLI package's version, not the registry; modified installs require --backup.
  Replacements preserve the entire previous directory in a reported sibling backup.
  uninstall removes only unchanged managed files; unrelated files remain.
  status reports exact destinations, changes, running CLI version and executable discovery on PATH.
`;

async function executableOnPath(): Promise<string | undefined> {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat'] : [''];
  for (const directory of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const path = join(directory, `${TOOL_NAME}${extension}`);
      try {
        await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return path;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  }
  return undefined;
}

export async function runSkill(argv: readonly string[], io: Pick<CliIo, 'stdout' | 'stderr'>): Promise<number> {
  const json = argv.includes('--json');
  try {
    const [action, ...rest] = argv;
    if (!['install', 'status', 'update', 'uninstall'].includes(action ?? '')) throw new Error(SKILL_HELP);
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i]!;
      if (token === '--json' || token === '--backup') {
        if (flags.has(token)) throw new Error(`Duplicate argument: ${token}`);
        flags.add(token);
      } else if (token === '--target' || token === '--project') {
        const value = rest[++i];
        if (!value || value.startsWith('--') || values.has(token)) throw new Error(`${token} needs exactly one value.`);
        values.set(token, value);
      } else throw new Error(`Unknown argument "${token}".\n${SKILL_HELP}`);
    }
    if (flags.has('--backup') && action !== 'install' && action !== 'update') {
      throw new Error('--backup is only supported by skill install and skill update.');
    }
    const destinations = skillDestinations(values.get('--target'), values.get('--project'));
    const results = [];
    for (const destination of destinations) {
      if (action === 'status') results.push(await skillStatus(destination));
      else if (action === 'uninstall') results.push(await uninstallSkill(destination));
      else results.push(await installSkill(destination, { update: action === 'update', backup: flags.has('--backup') }));
    }
    const result = {
      action, results,
      ...(action === 'status' ? { cli: { version: TOOL_VERSION, entrypoint: process.argv[1], onPath: await executableOnPath() ?? null } } : {}),
    };
    io.stdout(json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = `${error instanceof Error ? error.message : 'Skill operation failed.'}${code === 'EACCES' || code === 'EPERM' ? ' Permission denied; choose a writable user/project directory. Do not run as administrator.' : ''}`;
    if (json) io.stdout(`${JSON.stringify({ error: message })}\n`);
    else io.stderr(`${message}\n`);
    return 3;
  }
}
