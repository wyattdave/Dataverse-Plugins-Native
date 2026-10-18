import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { installSkill, SKILL_SOURCE, skillStatus, uninstallSkill } from '../src/skills/installer.js';
import { SKILL_NAME, skillDestinations } from '../src/skills/targets.js';
import { TOOL_VERSION } from '../src/version.js';
import { cli } from './helpers.js';

describe('skill distribution', () => {
  async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
    const root = await mkdtemp(join(tmpdir(), 'dataverse-plugins-native-skills-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'source');
    await mkdir(join(source, 'references', 'nested'), { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '---\nname: dataverse-plugins-native\ndescription: Test fixture\n---\n');
    await writeFile(join(source, 'references', 'nested', 'example.txt'), 'asset');
    return { root, source, destination: join(root, 'home', '.agents', 'skills', SKILL_NAME) };
  }

  it('resolves home/project paths and deduplicates shared targets using native paths on every OS', () => {
    const home = join(tmpdir(), 'home');
    const project = join(tmpdir(), 'project');
    assert.deepEqual(skillDestinations(undefined, undefined, home), [join(home, '.agents', 'skills', SKILL_NAME)]);
    assert.deepEqual(skillDestinations('claude', undefined, home), [join(home, '.claude', 'skills', SKILL_NAME)]);
    assert.deepEqual(skillDestinations('vscode', project, home), [join(project, '.github', 'skills', SKILL_NAME)]);
    assert.deepEqual(skillDestinations('all', undefined, home), [
      join(home, '.agents', 'skills', SKILL_NAME), join(home, '.claude', 'skills', SKILL_NAME), join(home, '.copilot', 'skills', SKILL_NAME),
    ]);
    for (const target of ['codex', 'opencode', 'shared']) {
      assert.deepEqual(skillDestinations(target, project, home), [join(project, '.agents', 'skills', SKILL_NAME)]);
    }
    assert.throws(() => skillDestinations('../../escape', undefined, home), /Unsupported target/);
  });

  it('copies all nested assets and records validated identity, hashes and version', async (t) => {
    const { source, destination } = await fixture(t);
    assert.equal((await skillStatus(destination)).state, 'missing');
    await installSkill(destination, { source });
    assert.equal(await readFile(join(destination, 'references', 'nested', 'example.txt'), 'utf8'), 'asset');
    const status = await skillStatus(destination);
    assert.equal(status.state, 'installed');
    assert.equal(status.version, TOOL_VERSION);
    const manifest = JSON.parse(await readFile(join(destination, '.dataverse-plugins-native-install.json'), 'utf8'));
    assert.equal(manifest.package, 'dataverse-plugins-native');
    assert.equal(manifest.destination, destination);
    assert.ok(!Number.isNaN(Date.parse(manifest.installedAt)));
  });

  it('refuses overwrite and protects modifications; explicit backup preserves everything', async (t) => {
    const { source, destination } = await fixture(t);
    await installSkill(destination, { source });
    await assert.rejects(installSkill(destination, { source }), /--backup/);
    await writeFile(join(destination, 'SKILL.md'), 'user changes');
    await writeFile(join(destination, 'notes.txt'), 'unrelated');
    assert.equal((await skillStatus(destination)).state, 'modified');
    await assert.rejects(installSkill(destination, { source, update: true }), /--backup/);
    await assert.rejects(uninstallSkill(destination), /modified/);
    const result = await installSkill(destination, { source, update: true, backup: true });
    assert.ok(result.backup);
    assert.equal(await readFile(join(result.backup, 'SKILL.md'), 'utf8'), 'user changes');
    assert.equal(await readFile(join(result.backup, 'notes.txt'), 'utf8'), 'unrelated');
    assert.equal((await skillStatus(destination)).state, 'installed');
  });

  it('updates a clean install to the current package and keeps a rollback copy', async (t) => {
    const { source, destination } = await fixture(t);
    await installSkill(destination, { source });
    await writeFile(join(source, 'references', 'nested', 'example.txt'), 'new asset');
    const result = await installSkill(destination, { source, update: true });
    assert.ok(result.backup);
    assert.equal(await readFile(join(result.backup, 'references', 'nested', 'example.txt'), 'utf8'), 'asset');
    assert.equal(await readFile(join(destination, 'references', 'nested', 'example.txt'), 'utf8'), 'new asset');
  });

  it('uninstalls only unchanged managed files and keeps unrelated files and siblings', async (t) => {
    const { source, destination } = await fixture(t);
    await installSkill(destination, { source });
    await writeFile(join(destination, 'notes.txt'), 'keep');
    await writeFile(join(destination, '..', 'sibling.txt'), 'keep too');
    assert.deepEqual((await uninstallSkill(destination)).preserved, ['notes.txt']);
    assert.deepEqual(await readdir(destination), ['notes.txt']);
    assert.equal(await readFile(join(destination, '..', 'sibling.txt'), 'utf8'), 'keep too');
    assert.equal((await skillStatus(destination)).state, 'unmanaged');
    await assert.rejects(uninstallSkill(destination), /unmanaged/);
  });

  it('removes clean installs and leaves missing installs alone', async (t) => {
    const { source, destination } = await fixture(t);
    await assert.rejects(installSkill(destination, { source, update: true }), /install first/);
    assert.equal((await uninstallSkill(destination)).removed, false);
    await installSkill(destination, { source });
    assert.equal((await uninstallSkill(destination)).removed, true);
    assert.equal((await skillStatus(destination)).state, 'missing');
  });

  it('rejects traversal in manifests, invalid packaged sources and symlinked destinations', async (t) => {
    const { root, source, destination } = await fixture(t);
    await installSkill(destination, { source });
    const manifestPath = join(destination, '.dataverse-plugins-native-install.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files['../victim.txt'] = 'a'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(uninstallSkill(destination), /Invalid installation manifest/);
    await assert.rejects(installSkill(join(root, 'invalid'), { source: join(source, 'references') }), /incomplete/);
    const link = join(root, 'link');
    await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installSkill(join(link, 'child'), { source }), /symbolic-link/);
    await assert.rejects(skillStatus(link), /symbolic-link/);
  });

  it('keeps JSON stdout clean on success, usage and operational errors without starting a server', async (t) => {
    const { root } = await fixture(t);
    const args = ['--project', root, '--json'];
    const installed = await cli(['skill', 'install', ...args]);
    assert.equal(installed.code, 0);
    assert.equal(installed.stderr, '');
    assert.equal(JSON.parse(installed.stdout).results[0].version, TOOL_VERSION);
    const status = await cli(['skill', 'status', ...args]);
    assert.equal(JSON.parse(status.stdout).cli.version, TOOL_VERSION);
    for (const argv of [
      ['skill', 'install', ...args],
      ['skill', 'bad', '--json'],
      ['skill', 'status', '--target', 'unknown', '--json'],
      ['skill', 'install', '--project', '--json'],
      ['skill', 'uninstall', '--backup', '--json'],
      ['not-a-command', '--json'],
    ]) {
      const result = await cli(argv);
      assert.equal(result.code, 3);
      assert.equal(result.stderr, '');
      assert.equal(typeof JSON.parse(result.stdout).error, 'string');
    }
    const removed = await cli(['skill', 'uninstall', ...args]);
    assert.equal(removed.code, 0);
    assert.equal((await cli(['skill', '--help'])).code, 0);
  });

  it('ships local-first instructions and an exact package-version npx fallback', async () => {
    const runtime = JSON.parse(await readFile(join(SKILL_SOURCE, 'references', 'runtime.json'), 'utf8'));
    assert.equal(runtime.version, TOOL_VERSION);
    assert.equal(runtime.fallback, `npx -y dataverse-plugins-native@${TOOL_VERSION}`);
    const skill = await readFile(join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
    assert.ok(skill.indexOf('dataverse-plugins-native --version') < skill.indexOf('npm run dataverse-plugins-native -- --version'));
    assert.ok(skill.indexOf('npm run dataverse-plugins-native -- --version') < skill.indexOf('Otherwise read'));
    assert.ok(skill.includes('./references/runtime.json'));
    assert.ok(!skill.includes('npx -y dataverse-plugins-native <'));
  });
});
