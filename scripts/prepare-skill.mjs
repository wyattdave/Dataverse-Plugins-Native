import { mkdir, readFile, writeFile } from 'node:fs/promises';

const oPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const oReferences = new URL('../.github/skills/dataverse-plugins-native/references/', import.meta.url);
await mkdir(oReferences, { recursive: true });
await writeFile(new URL('runtime.json', oReferences), `${JSON.stringify({
  package: oPackage.name,
  version: oPackage.version,
  executable: 'dataverse-plugins-native',
  fallback: `npx -y ${oPackage.name}@${oPackage.version}`,
}, null, 2)}\n`);
