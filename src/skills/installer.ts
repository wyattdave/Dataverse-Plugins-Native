import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlainObject } from '../core/schema.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { SKILL_NAME } from './targets.js';

export const SKILL_SOURCE = fileURLToPath(new URL('../../../.github/skills/dataverse-plugins-native', import.meta.url));
const MANIFEST = '.dataverse-plugins-native-install.json';
type Files = Record<string, string>;

interface Manifest {
  schema: 1;
  package: string;
  skill: string;
  version: string;
  destination: string;
  installedAt: string;
  files: Files;
}

async function info(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertSafePath(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const entry = await info(current);
    if (entry !== undefined && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error(`Refusing non-directory or symbolic-link destination: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function inventory(root: string, sub = ''): Promise<Files> {
  const files: Files = Object.create(null);
  for (const entry of await readdir(join(root, sub), { withFileTypes: true })) {
    const name = sub === '' ? entry.name : `${sub}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in skill: ${join(root, name)}`);
    if (entry.isDirectory()) Object.assign(files, await inventory(root, name));
    else if (entry.isFile()) {
      if (name !== MANIFEST) files[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    } else throw new Error(`Unsupported skill file: ${join(root, name)}`);
  }
  return files;
}

function safeFile(name: string): boolean {
  return name !== MANIFEST && !isAbsolute(name) && !name.includes('\\') &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes(':'));
}

async function readManifest(destination: string): Promise<Manifest | undefined> {
  const path = join(destination, MANIFEST);
  const entry = await info(path);
  if (entry === undefined) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Invalid installation manifest: ${path}`);
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isPlainObject(value) || value['schema'] !== 1 || value['package'] !== TOOL_NAME || value['skill'] !== SKILL_NAME ||
      typeof value['version'] !== 'string' || typeof value['installedAt'] !== 'string' ||
      value['destination'] !== resolve(destination) || !isPlainObject(value['files']) ||
      !Object.hasOwn(value['files'], 'SKILL.md') ||
      !Object.entries(value['files']).every(([name, hash]) => safeFile(name) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error(`Invalid installation manifest: ${path}. Preserve this directory manually before reinstalling.`);
  }
  const files: Files = Object.create(null);
  for (const [name, hash] of Object.entries(value['files'])) {
    if (typeof hash !== 'string') throw new Error(`Invalid file hash in ${path}`);
    files[name] = hash;
  }
  return {
    schema: 1, package: TOOL_NAME, skill: SKILL_NAME, version: value['version'],
    destination: resolve(destination), installedAt: value['installedAt'], files,
  };
}

export interface SkillStatus {
  destination: string;
  state: 'missing' | 'unmanaged' | 'installed' | 'modified';
  version?: string;
  changed?: string[];
  extra?: string[];
}

export async function skillStatus(destination: string): Promise<SkillStatus> {
  await assertSafePath(destination);
  if (await info(destination) === undefined) return { destination, state: 'missing' };
  const manifest = await readManifest(destination);
  if (manifest === undefined) return { destination, state: 'unmanaged' };
  const files = await inventory(destination);
  const changed = Object.keys(manifest.files).filter((name) => files[name] !== manifest.files[name]);
  const extra = Object.keys(files).filter((name) => !Object.hasOwn(manifest.files, name));
  return { destination, state: changed.length === 0 && extra.length === 0 ? 'installed' : 'modified', version: manifest.version, changed, extra };
}

export async function installSkill(destination: string, options: { update?: boolean; backup?: boolean; source?: string } = {}) {
  const status = await skillStatus(destination);
  if (options.update && status.state === 'missing') throw new Error(`No skill installed at ${destination}; run skill install first.`);
  if (status.state !== 'missing' && (!options.update || status.state !== 'installed') && !options.backup) {
    throw new Error(`Skill at ${destination} is ${status.state}. Use skill update for an unmodified managed install, or --backup to preserve the entire existing directory before replacement.`);
  }
  const source = options.source ?? SKILL_SOURCE;
  const files = await inventory(source);
  if (!Object.hasOwn(files, 'SKILL.md') || Object.keys(files).some((name) => !safeFile(name))) {
    throw new Error('Packaged skill is incomplete or contains invalid paths; reinstall the dataverse-plugins-native package.');
  }
  await mkdir(dirname(destination), { recursive: true });
  await assertSafePath(destination);
  const stage = `${destination}.staging-${randomUUID()}`;
  await mkdir(stage);
  let backup: string | undefined;
  try {
    for (const name of Object.keys(files)) {
      const path = join(stage, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await readFile(join(source, name)), { flag: 'wx' });
    }
    const copied = await inventory(stage);
    if (Object.keys(files).some((name) => files[name] !== copied[name])) throw new Error('Skill copy validation failed.');
    const manifest: Manifest = {
      schema: 1, package: TOOL_NAME, skill: SKILL_NAME, version: TOOL_VERSION,
      destination: resolve(destination), installedAt: new Date().toISOString(), files,
    };
    await writeFile(join(stage, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    if (status.state !== 'missing') {
      backup = `${destination}.backup-${randomUUID()}`;
      await rename(destination, backup);
    }
    try {
      await rename(stage, destination);
    } catch (error) {
      if (backup !== undefined) await rename(backup, destination);
      throw error;
    }
  } finally {
    if (await info(stage) !== undefined) {
      await removeFiles(stage, [...Object.keys(await inventory(stage)), ...(await info(join(stage, MANIFEST)) === undefined ? [] : [MANIFEST])]);
    }
  }
  return { destination, version: TOOL_VERSION, ...(backup === undefined ? {} : { backup }) };
}

async function removeFiles(destination: string, files: string[]): Promise<void> {
  for (const name of files) await unlink(join(destination, name));
  const directories = new Set<string>([destination]);
  for (const name of files) {
    let parent = dirname(join(destination, name));
    while (parent !== destination && relative(destination, parent) !== '..' && !relative(destination, parent).startsWith(`..${sep}`)) {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
}

export async function uninstallSkill(destination: string) {
  const status = await skillStatus(destination);
  if (status.state === 'missing') return { destination, removed: false };
  const manifest = await readManifest(destination);
  if (manifest === undefined) throw new Error(`Refusing to uninstall unmanaged skill: ${destination}`);
  if (status.changed!.length > 0) throw new Error(`Skill has modified or missing managed files at ${destination}; preserve your changes manually before uninstalling.`);
  await removeFiles(destination, [...Object.keys(manifest.files), MANIFEST]);
  return { destination, removed: true, preserved: status.extra };
}
