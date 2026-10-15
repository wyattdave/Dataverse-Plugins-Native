import { readFile, stat } from 'node:fs/promises';
import { MAX_FORMULA_LENGTH, PARAMETER_TYPES, TRIGGER_MESSAGES, TRIGGER_STAGES, type PluginParameter } from './spec.js';

/** CLI option → what it sets. Shared by `new` and `set`; values are applied in this order. */
export const SETTING_OPTIONS = {
  '--solution': 'solution unique name',
  '--solution-display-name': 'solution display name',
  '--solution-version': 'solution version (e.g. 1.0.0.0)',
  '--publisher': 'publisher unique name',
  '--publisher-display-name': 'publisher display name',
  '--prefix': 'publisher prefix (also renames the plug-in if it used the old prefix)',
  '--option-value-prefix': 'publisher option value prefix (10000-99999)',
  '--name': 'plug-in name; the publisher prefix is added when missing',
  '--display-name': 'plug-in display name',
  '--description': 'plug-in description',
  '--params': 'instant only: Name:input|output:Type,... or none',
  '--trigger-table': 'automated only: table logical name',
  '--message': `automated only: ${TRIGGER_MESSAGES.join('|')}`,
  '--stage': `automated only: ${Object.keys(TRIGGER_STAGES).join('|')}`,
  '--tables': 'table logical names the formula uses: a,b,... or none',
  '--formula-file': 'Power Fx script file whose content becomes the formula',
} as const;
export type SettingOption = keyof typeof SETTING_OPTIONS;
export const SETTING_NAMES = Object.keys(SETTING_OPTIONS) as SettingOption[];

export class SettingsError extends Error {}

type SpecObject = Record<string, unknown>;

const child = (spec: SpecObject, key: string): SpecObject => {
  const value = spec[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as SpecObject;
  }
  const created: SpecObject = {};
  spec[key] = created;
  return created;
};

const list = (value: string): string[] =>
  value.trim().toLowerCase() === 'none' ? [] : value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);

function parseParams(value: string): PluginParameter[] {
  return list(value).map((item) => {
    const [name, direction, type, extra] = item.split(':').map((p) => p.trim());
    if (name === undefined || extra !== undefined || (direction !== 'input' && direction !== 'output') || !PARAMETER_TYPES.includes(type as never)) {
      throw new SettingsError(`--params item "${item}" must be Name:input|output:${PARAMETER_TYPES.join('|')}.`);
    }
    return { name, direction, type: type as PluginParameter['type'] };
  });
}

/** Bounded, strict UTF-8 read; strips a BOM and normalizes line endings to LF. */
export async function readFormulaFile(path: string): Promise<string> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new SettingsError('--formula-file must be an existing file.');
  }
  if (info.size > MAX_FORMULA_LENGTH * 4) {
    throw new SettingsError(`--formula-file is too large (max ${MAX_FORMULA_LENGTH} characters).`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
  } catch {
    throw new SettingsError('--formula-file is not valid UTF-8.');
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd();
}

/**
 * Applies CLI settings to a (possibly invalid) spec object in place. Only shape errors in the option values throw;
 * everything else is left to `check`, so an agent can fix a spec step by step.
 */
export async function applySettings(spec: SpecObject, settings: ReadonlyMap<string, string>): Promise<void> {
  const kind = spec['kind'];
  const only = (option: string, allowed: 'instant' | 'automated'): void => {
    if (kind !== allowed) {
      throw new SettingsError(`${option} only applies to ${allowed} plug-ins.`);
    }
  };
  const solution = (): SpecObject => child(spec, 'solution');
  const publisher = (): SpecObject => child(solution(), 'publisher');
  for (const option of SETTING_NAMES) {
    const value = settings.get(option);
    if (value === undefined) {
      continue;
    }
    switch (option) {
      case '--solution':
        solution()['uniqueName'] = value;
        break;
      case '--solution-display-name':
        solution()['displayName'] = value;
        break;
      case '--solution-version':
        solution()['version'] = value;
        break;
      case '--publisher':
        publisher()['uniqueName'] = value;
        break;
      case '--publisher-display-name':
        publisher()['displayName'] = value;
        break;
      case '--prefix': {
        const old = publisher()['prefix'];
        const name = spec['uniqueName'];
        if (typeof old === 'string' && typeof name === 'string' && name.startsWith(`${old}_`)) {
          spec['uniqueName'] = `${value}_${name.slice(old.length + 1)}`;
        }
        publisher()['prefix'] = value;
        break;
      }
      case '--option-value-prefix':
        if (!/^\d{1,9}$/.test(value)) {
          throw new SettingsError('--option-value-prefix must be a whole number (10000-99999).');
        }
        publisher()['optionValuePrefix'] = Number(value);
        break;
      case '--name': {
        const prefix = publisher()['prefix'];
        spec['uniqueName'] = typeof prefix === 'string' && !value.startsWith(`${prefix}_`) ? `${prefix}_${value}` : value;
        break;
      }
      case '--display-name':
        spec['displayName'] = value;
        break;
      case '--description':
        spec['description'] = value;
        break;
      case '--params':
        only(option, 'instant');
        spec['parameters'] = parseParams(value);
        break;
      case '--trigger-table':
        only(option, 'automated');
        child(spec, 'trigger')['table'] = value;
        break;
      case '--message':
        only(option, 'automated');
        child(spec, 'trigger')['message'] = value;
        break;
      case '--stage':
        only(option, 'automated');
        child(spec, 'trigger')['stage'] = value;
        break;
      case '--tables':
        spec['tables'] = list(value);
        break;
      case '--formula-file':
        spec['formula'] = await readFormulaFile(value);
        break;
    }
  }
}
