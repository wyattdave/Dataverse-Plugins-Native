import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { promisify } from 'node:util';
import { TOOL_VERSION } from '../src/version.js';
import { ROOT } from './helpers.js';

const exec = promisify(execFile);

it('uses the full package name for the only executable and local npm command', async () => {
  const metadata = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'dataverse-plugins-native');
  assert.deepEqual(metadata.bin, { 'dataverse-plugins-native': 'dist/src/cli/main.js' });
  assert.equal(metadata.scripts['dataverse-plugins-native'], 'node dist/src/cli/main.js');
});

it('packs and runs offline via npm exec and a temporary global install, including skill assets and UI', { timeout: 120_000 }, async (t) => {
  const npmCli = process.env['npm_execpath'];
  assert.ok(npmCli, 'Run package integration tests through npm test.');
  const root = await mkdtemp(join(tmpdir(), 'dataverse-plugins-native-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npm = async (args: string[]) => exec(process.execPath, [npmCli, ...args], { cwd: ROOT, timeout: 60_000 });
  const packed = JSON.parse((await npm(['pack', '--ignore-scripts', '--pack-destination', root, '--json'])).stdout)[0];
  const files: string[] = packed.files.map((file: { path: string }) => file.path);
  for (const file of ['dist/src/cli/main.js', 'ui/index.html', 'examples/instant.plugin.json',
    '.github/skills/dataverse-plugins-native/SKILL.md', '.github/skills/dataverse-plugins-native/references/runtime.json', 'LICENSE', 'README.md', 'docs/commands.md']) {
    assert.ok(files.includes(file), `Missing packed asset: ${file}`);
  }
  assert.ok(!files.some((file) => /^(tests|dist\/tests|private|node_modules)\//.test(file)));
  const archive = join(root, packed.filename);
  const cache = join(root, 'cache');
  const npx = await npm(['exec', '--offline', '--yes', '--cache', cache, '--package', archive, '--', 'dataverse-plugins-native', '--version']);
  assert.equal(npx.stdout.trim(), `dataverse-plugins-native ${TOOL_VERSION}`);
  const checked = await npm(['exec', '--offline', '--yes', '--cache', cache, '--package', archive, '--',
    'dataverse-plugins-native', 'check', '--spec', join(ROOT, 'examples', 'instant.plugin.json'), '--json']);
  assert.equal(JSON.parse(checked.stdout).ok, true);
  const project = join(root, 'project');
  const install = await npm(['exec', '--offline', '--yes', '--cache', cache, '--package', archive, '--',
    'dataverse-plugins-native', 'skill', 'install', '--project', project, '--json']);
  const destination = JSON.parse(install.stdout).results[0].destination;
  assert.ok((await readFile(join(destination, 'SKILL.md'), 'utf8')).includes('dataverse-plugins-native --version'));
  await npm(['install', '--global', '--prefix', join(root, 'global'), '--cache', cache, '--offline', '--ignore-scripts', '--no-audit', archive]);
  const bin = process.platform === 'win32' ? join(root, 'global', 'dataverse-plugins-native.cmd') : join(root, 'global', 'bin', 'dataverse-plugins-native');
  const globalVersion = process.platform === 'win32'
    ? await exec(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `""${bin}" --version"`], { windowsVerbatimArguments: true })
    : await exec(bin, ['--version']);
  assert.equal(globalVersion.stdout.trim(), `dataverse-plugins-native ${TOOL_VERSION}`);
  const modules = (await npm(['root', '--global', '--prefix', join(root, 'global')])).stdout.trim();
  const server = spawn(process.execPath, [join(modules, 'dataverse-plugins-native', 'dist', 'src', 'cli', 'main.js'), 'ui'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    let diagnostics = '';
    server.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
    const launchUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Packed UI did not become ready: ${diagnostics}`)), 10_000);
      server.once('error', (error) => { clearTimeout(timer); reject(error); });
      server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Packed UI exited ${code}: ${diagnostics}`)); });
      server.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+\/\?session=[a-f0-9]+/.exec(output);
        if (match !== null) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    const url = new URL(launchUrl);
    assert.ok((await (await fetch(url)).text()).includes('Dataverse Plug-ins Native'));
    const meta = await fetch(new URL('/api/studio/meta', url), { headers: { 'X-Dataverse-Plugins-Native-Session': url.searchParams.get('session')! } });
    assert.equal(meta.status, 200);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
  }
});
