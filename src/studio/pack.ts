import { crc32, deflateRawSync } from 'node:zlib';
import type { SolutionFiles } from './solution.js';

/**
 * Packs an unpacked solution folder layout into an importable solution zip, the way SolutionPackager (`pac solution pack`)
 * does for the components dv-native generates: Other/Solution.xml → solution.xml, Other/Customizations.xml →
 * customizations.xml with SdkMessageProcessingSteps/*.xml inlined, [Content_Types].xml, and component folders unchanged.
 */

const BOM = '\uFEFF';
/** SolutionPackager writes root XML with a BOM, CRLF line endings and no trailing newline. */
const rootXml = (text: string): Buffer => Buffer.from(BOM + text.trimEnd().replace(/\r?\n/g, '\r\n'), 'utf8');
const STEPS_FOLDER = 'SdkMessageProcessingSteps/';

function inlineSteps(customizations: string, files: SolutionFiles): string {
  const steps = [...files.entries()]
    .filter(([path]) => path.startsWith(STEPS_FOLDER))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, xml]) =>
      xml
        .replace(/^\uFEFF?<\?xml[^>]*\?>\s*/, '')
        .replace(/\s+xmlns:xsi="[^"]*"/, '')
        .trimEnd()
        .split(/\r?\n/)
        .map((line) => `    ${line}`)
        .join('\n'),
    );
  if (steps.length === 0) {
    return customizations;
  }
  if (!customizations.includes('<SdkMessageProcessingSteps />')) {
    throw new Error('customizations.xml has no SdkMessageProcessingSteps element to fill.');
  }
  return customizations.replace('<SdkMessageProcessingSteps />', () => `<SdkMessageProcessingSteps>\n${steps.join('\n')}\n  </SdkMessageProcessingSteps>`);
}

/** Zip entry name → content, in the order SolutionPackager writes them. */
export function packedSolutionEntries(files: SolutionFiles): Map<string, Buffer> {
  const solution = files.get('Other/Solution.xml');
  const customizations = files.get('Other/Customizations.xml');
  if (solution === undefined || customizations === undefined) {
    throw new Error('The solution needs Other/Solution.xml and Other/Customizations.xml.');
  }
  const entries = new Map<string, Buffer>();
  entries.set('customizations.xml', rootXml(inlineSteps(customizations, files)));
  entries.set('solution.xml', rootXml(solution));
  const components = [...files.keys()].filter((path) => !path.startsWith('Other/') && !path.startsWith(STEPS_FOLDER)).sort();
  for (const path of components) {
    if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`Unsafe solution path: ${path}`);
    }
    entries.set(path, Buffer.from(files.get(path)!, 'utf8'));
  }
  const extensions = [...new Set([...entries.keys()].map((name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()))];
  const types = extensions.map((extension) => `<Default Extension="${extension}" ContentType="application/octet-stream" />`).join('');
  entries.set(
    '[Content_Types].xml',
    Buffer.from(`${BOM}<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types}</Types>`, 'utf8'),
  );
  return entries;
}

/** Minimal deflate zip writer (no zip64; solution sizes here are tiny). Fixed timestamp keeps output deterministic. */
export function createZip(entries: ReadonlyMap<string, Buffer>): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(content);
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function packSolution(files: SolutionFiles): Buffer {
  return createZip(packedSolutionEntries(files));
}
