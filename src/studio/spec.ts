import { arr, int, lit, obj, str, validateSchema, type Schema } from '../core/schema.js';
import { parseStrictJson, StrictJsonError } from '../core/strictJson.js';

export const PUBLISHER_PREFIX_PATTERN = /^[a-z][a-z0-9]{1,7}$/;
export const SOLUTION_UNIQUE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
export const LOGICAL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Microsoft-owned publisher prefixes. */
const isReservedPrefix = (prefix: string): boolean => /^ms/.test(prefix) || prefix === 'adx';

export const PLUGIN_SCHEMA_VERSION = 'dv-native.plugin/v1';

/** Custom API parameter type codes (documented Custom API `type` choice values). */
export const PARAMETER_TYPE_CODES = {
  Boolean: 0,
  DateTime: 1,
  Decimal: 2,
  Float: 6,
  Integer: 7,
  String: 10,
} as const;
export type ParameterType = keyof typeof PARAMETER_TYPE_CODES;
export const PARAMETER_TYPES = Object.keys(PARAMETER_TYPE_CODES) as ParameterType[];

export const TRIGGER_MESSAGES = ['Create', 'Update', 'Delete'] as const;
export type TriggerMessage = (typeof TRIGGER_MESSAGES)[number];

/** Stages offered by the Dataverse accelerator for automated plug-ins (sdkmessageprocessingstep.stage). */
export const TRIGGER_STAGES = { preOperation: 20, postOperation: 40 } as const;
export type TriggerStage = keyof typeof TRIGGER_STAGES;

export const MAX_FORMULA_LENGTH = 100_000;

export interface PluginParameter {
  name: string;
  direction: 'input' | 'output';
  type: ParameterType;
}

export interface PluginSpec {
  schemaVersion: typeof PLUGIN_SCHEMA_VERSION;
  kind: 'instant' | 'automated';
  uniqueName: string;
  displayName: string;
  description?: string;
  solution: {
    uniqueName: string;
    displayName?: string;
    version?: string;
    publisher: { uniqueName: string; displayName?: string; prefix: string; optionValuePrefix: number };
  };
  parameters?: PluginParameter[];
  trigger?: { table: string; message: TriggerMessage; stage: TriggerStage };
  tables: string[];
  formula: string;
}

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** JSON pointer into the spec, when the issue is about a field. */
  path?: string;
  /** 1-based position inside the formula, when the issue is about the formula. */
  line?: number;
  column?: number;
}

const NAME_PART = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const VERSION_PATTERN = /^\d{1,9}(\.\d{1,9}){1,3}$/;
const TEXT_PATTERN = /^[^\u0000-\u001F\u007F]+$/;

const schema: Schema = obj(
  {
    schemaVersion: lit(PLUGIN_SCHEMA_VERSION),
    kind: str({ enum: ['instant', 'automated'] }),
    uniqueName: str({ minLength: 4, maxLength: 128 }),
    displayName: str({ minLength: 1, maxLength: 100, pattern: TEXT_PATTERN }),
    description: str({ maxLength: 2000 }),
    solution: obj(
      {
        uniqueName: str({ pattern: SOLUTION_UNIQUE_NAME_PATTERN }),
        displayName: str({ minLength: 1, maxLength: 100, pattern: TEXT_PATTERN }),
        version: str({ pattern: VERSION_PATTERN }),
        publisher: obj(
          {
            uniqueName: str({ pattern: SOLUTION_UNIQUE_NAME_PATTERN }),
            displayName: str({ minLength: 1, maxLength: 100, pattern: TEXT_PATTERN }),
            prefix: str({ pattern: PUBLISHER_PREFIX_PATTERN }),
            optionValuePrefix: int({ min: 10000, max: 99999 }),
          },
          ['displayName'],
        ),
      },
      ['displayName', 'version'],
    ),
    parameters: arr(
      obj({
        name: str({ pattern: PARAMETER_NAME_PATTERN }),
        direction: str({ enum: ['input', 'output'] }),
        type: str({ enum: PARAMETER_TYPES }),
      }),
      { maxItems: 32 },
    ),
    trigger: obj({
      table: str({ pattern: LOGICAL_NAME_PATTERN }),
      message: str({ enum: TRIGGER_MESSAGES }),
      stage: str({ enum: Object.keys(TRIGGER_STAGES) }),
    }),
    tables: arr(str({ pattern: LOGICAL_NAME_PATTERN }), { maxItems: 50 }),
    formula: str({ minLength: 1, maxLength: MAX_FORMULA_LENGTH }),
  },
  ['description', 'parameters', 'trigger'],
);

export interface SpecParse {
  spec: PluginSpec | undefined;
  issues: Issue[];
}

/** Strictly parses and validates a plug-in spec. Returns the spec only when there are no errors. */
export function parsePluginSpec(text: string): SpecParse {
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (error) {
    const reason = error instanceof StrictJsonError ? error.code : 'JSON_INVALID';
    return { spec: undefined, issues: [{ severity: 'error', code: reason, message: 'The spec is not valid JSON.' }] };
  }
  const issues: Issue[] = validateSchema(value, schema).map((d) => ({ severity: 'error', code: d.code, message: d.message, path: d.path }));
  if (issues.length > 0) {
    return { spec: undefined, issues };
  }
  const spec = value as PluginSpec;
  issues.push(...checkRules(spec));
  return { spec: issues.some((i) => i.severity === 'error') ? undefined : spec, issues };
}

function checkRules(spec: PluginSpec): Issue[] {
  const issues: Issue[] = [];
  const error = (code: string, message: string, path: string): void => {
    issues.push({ severity: 'error', code, message, path });
  };
  const prefix = spec.solution.publisher.prefix;
  if (isReservedPrefix(prefix)) {
    error('PREFIX_RESERVED', 'Microsoft-reserved publisher prefixes cannot be used.', '/solution/publisher/prefix');
  }
  const namePart = spec.uniqueName.startsWith(`${prefix}_`) ? spec.uniqueName.slice(prefix.length + 1) : undefined;
  if (namePart === undefined || !NAME_PART.test(namePart)) {
    error('UNIQUE_NAME_INVALID', `Unique name must be "${prefix}_" followed by letters, digits or underscores.`, '/uniqueName');
  }
  if (spec.kind === 'instant') {
    if (spec.trigger !== undefined) {
      error('TRIGGER_NOT_ALLOWED', 'Instant plug-ins have no trigger; use kind "automated" for table events.', '/trigger');
    }
    if (spec.parameters === undefined) {
      error('PARAMETERS_REQUIRED', 'Instant plug-ins need a parameters array (it may be empty).', '/parameters');
    } else {
      const seen = new Set<string>();
      spec.parameters.forEach((p, index) => {
        const key = p.name.toLowerCase();
        if (seen.has(key)) {
          error('PARAMETER_DUPLICATE', 'Parameter names must be unique (case-insensitive).', `/parameters/${index}/name`);
        }
        seen.add(key);
      });
    }
  } else {
    if (spec.trigger === undefined) {
      error('TRIGGER_REQUIRED', 'Automated plug-ins need a trigger (table, message, stage).', '/trigger');
    }
    if (spec.parameters !== undefined && spec.parameters.length > 0) {
      error('PARAMETERS_NOT_ALLOWED', 'Automated plug-ins do not take parameters.', '/parameters');
    }
  }
  const tables = new Set<string>();
  spec.tables.forEach((t, index) => {
    if (tables.has(t)) {
      error('TABLE_DUPLICATE', 'Table names must be unique.', `/tables/${index}`);
    }
    tables.add(t);
  });
  return issues;
}

/** Tables the expression may touch; the trigger table is always included for automated plug-ins. */
export function contextTables(spec: PluginSpec): string[] {
  const all = [...spec.tables];
  if (spec.trigger !== undefined && !all.includes(spec.trigger.table)) {
    all.unshift(spec.trigger.table);
  }
  return all;
}

export function starterSpec(kind: PluginSpec['kind']): PluginSpec {
  const solution: PluginSpec['solution'] = {
    uniqueName: 'SampleLowCodePlugins',
    displayName: 'Sample low-code plug-ins',
    version: '1.0.0.0',
    publisher: { uniqueName: 'SamplePublisher', displayName: 'Sample publisher', prefix: 'sample', optionValuePrefix: 10000 },
  };
  if (kind === 'instant') {
    return {
      schemaVersion: PLUGIN_SCHEMA_VERSION,
      kind,
      uniqueName: 'sample_CalculateFee',
      displayName: 'Calculate fee',
      description: 'Returns Amount multiplied by Rate.',
      solution,
      parameters: [
        { name: 'Amount', direction: 'input', type: 'Decimal' },
        { name: 'Rate', direction: 'input', type: 'Decimal' },
        { name: 'Fee', direction: 'output', type: 'Decimal' },
      ],
      tables: [],
      formula: '{ Fee: Amount * Rate }',
    };
  }
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    kind,
    uniqueName: 'sample_AccountNameRequired',
    displayName: 'Account name required',
    description: 'Blocks account creation without a name.',
    solution,
    trigger: { table: 'account', message: 'Create', stage: 'preOperation' },
    tables: ['account'],
    formula: 'If(IsBlank(NewRecord.name), Error({ Kind: ErrorKind.Validation, Message: "Account name is required." }))',
  };
}
