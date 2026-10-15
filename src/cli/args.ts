import type { ReasonCode } from '../contracts/reasonCodes.js';

export interface CommandSpec {
  valueOptions: readonly string[];
  flagOptions: readonly string[];
  required: readonly string[];
  summary: string;
}

export const COMMAND_SPECS: Readonly<Record<string, CommandSpec>> = {
  inspect: {
    valueOptions: ['--target', '--snapshot'],
    flagOptions: ['--json'],
    required: [],
    summary: 'Inspect a snapshot offline (--snapshot) or request live target inspection (--target alone; blocked until a token provider is configured).',
  },
  validate: {
    valueOptions: ['--spec', '--target'],
    flagOptions: ['--offline', '--json'],
    required: ['--spec'],
    summary: 'Strict schema and policy checks. --offline limits scope explicitly; without it, live metadata checks are requested and blocked.',
  },
  plan: {
    valueOptions: ['--spec', '--snapshot', '--target', '--out'],
    flagOptions: ['--json'],
    required: ['--spec'],
    summary: 'Build a deterministic draft, non-executable, non-approvable plan. --out writes the plan to a new private file.',
  },
  verify: {
    valueOptions: ['--spec', '--snapshot', '--target'],
    flagOptions: ['--json'],
    required: ['--spec'],
    summary: 'Compare desired state with a snapshot projection; read-back stays unknown without live graph reads.',
  },
  apply: {
    valueOptions: ['--plan', '--approval'],
    flagOptions: ['--json'],
    required: ['--plan'],
    summary: 'Check plan integrity and approval gates; always blocked in Phase 1. Nothing is dispatched.',
  },
  approve: {
    valueOptions: ['--plan'],
    flagOptions: ['--json'],
    required: ['--plan'],
    summary: 'Refuses draft or ineligible plans; Phase 1 plans are never approval-eligible.',
  },
  reconcile: {
    valueOptions: ['--journal', '--snapshot'],
    flagOptions: ['--json'],
    required: ['--journal'],
    summary: 'Read-only comparison of a local journal against an optional snapshot; never retries or repairs.',
  },
  test: {
    valueOptions: ['--plan', '--spec', '--target'],
    flagOptions: ['--json'],
    required: [],
    summary: 'Blocked: invocation requires a separate test gate (Phase 3+).',
  },
  'package export': {
    valueOptions: ['--target', '--out'],
    flagOptions: ['--json'],
    required: [],
    summary: 'Blocked: native package export is not enabled (Phase 5).',
  },
  'package import': {
    valueOptions: ['--target', '--package'],
    flagOptions: ['--json'],
    required: [],
    summary: 'Blocked: native package import is not enabled (Phase 5).',
  },
  recover: {
    valueOptions: ['--journal', '--plan'],
    flagOptions: ['--json'],
    required: [],
    summary: 'Blocked: compensating recovery protocol is unverified.',
  },
  retire: {
    valueOptions: ['--spec', '--target'],
    flagOptions: ['--json'],
    required: [],
    summary: 'Blocked: generic delete is disabled until the native teardown lifecycle is proven.',
  },
  ui: {
    valueOptions: ['--port'],
    flagOptions: ['--open'],
    required: [],
    summary: 'Start the local browser UI on 127.0.0.1 (random port unless --port). Ctrl+C stops it.',
  },
};

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'command'; command: string; values: Map<string, string>; flags: Set<string> }
  | { kind: 'error'; command: string; reasonCode: ReasonCode; message: string; json: boolean };

/** Strict parser: unknown options, duplicates, stray arguments, and missing values are all errors. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const json = argv.includes('--json');
  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    return { kind: 'help' };
  }
  if (first === '--version') {
    return argv.length === 1 ? { kind: 'version' } : { kind: 'error', command: 'cli', reasonCode: 'CLI_UNEXPECTED_ARGUMENT', message: '--version takes no arguments.', json };
  }
  let command = first;
  let index = 1;
  if (first === 'package') {
    const sub = argv[1];
    if (sub !== 'export' && sub !== 'import') {
      return { kind: 'error', command: 'package', reasonCode: 'CLI_UNKNOWN_COMMAND', message: 'Use "package export" or "package import".', json };
    }
    command = `package ${sub}`;
    index = 2;
  }
  const spec = Object.hasOwn(COMMAND_SPECS, command) ? COMMAND_SPECS[command] : undefined;
  if (spec === undefined) {
    return { kind: 'error', command: 'cli', reasonCode: 'CLI_UNKNOWN_COMMAND', message: 'Unknown command.', json };
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const error = (reasonCode: ReasonCode, message: string): ParsedArgs => ({ kind: 'error', command, reasonCode, message, json });

  while (index < argv.length) {
    const token = argv[index]!;
    index++;
    if (token === '--help' || token === '-h') {
      return { kind: 'help' };
    }
    if (!token.startsWith('--')) {
      return error('CLI_UNEXPECTED_ARGUMENT', 'Unexpected positional argument.');
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (spec.flagOptions.includes(name)) {
      if (inline !== undefined) {
        return error('CLI_UNEXPECTED_ARGUMENT', `${name} does not take a value.`);
      }
      if (flags.has(name)) {
        return error('CLI_DUPLICATE_OPTION', `${name} was given more than once.`);
      }
      flags.add(name);
      continue;
    }
    if (spec.valueOptions.includes(name)) {
      if (values.has(name)) {
        return error('CLI_DUPLICATE_OPTION', `${name} was given more than once.`);
      }
      let value = inline;
      if (value === undefined) {
        const next = argv[index];
        if (next === undefined || next.startsWith('--')) {
          return error('CLI_OPTION_VALUE_MISSING', `${name} requires a value.`);
        }
        value = next;
        index++;
      }
      if (value === '') {
        return error('CLI_OPTION_VALUE_MISSING', `${name} requires a non-empty value.`);
      }
      values.set(name, value);
      continue;
    }
    return error('CLI_UNKNOWN_OPTION', `Unknown option ${name} for "${command}". There are no override or force options.`);
  }
  for (const required of spec.required) {
    if (!values.has(required)) {
      return error('CLI_MISSING_OPTION', `${required} is required.`);
    }
  }
  if (command === 'inspect' && !values.has('--target') && !values.has('--snapshot')) {
    return error('CLI_MODE_REQUIRED', 'inspect needs --snapshot (offline) and/or --target (live, blocked).');
  }
  const port = values.get('--port');
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) > 65535)) {
    return error('CLI_OPTION_VALUE_INVALID', '--port must be an integer between 0 and 65535.');
  }
  return { kind: 'command', command, values, flags };
}

export function helpText(toolName: string, intro = ''): string {
  const lines = [
    intro,
    'Advanced: offline spec/snapshot planning (adapter.spec/v1, read-only; these never write):',
  ];
  for (const [name, spec] of Object.entries(COMMAND_SPECS)) {
    if (name === 'ui') {
      continue;
    }
    const options = [
      ...spec.valueOptions.map((o) => {
        const placeholder = o === '--port' ? '<number>' : '<file>';
        return spec.required.includes(o) ? `${o} ${placeholder}` : `[${o} ${placeholder}]`;
      }),
      ...spec.flagOptions.map((o) => `[${o}]`),
    ].join(' ');
    lines.push(`  ${toolName} ${name} ${options}`, `      ${spec.summary}`);
  }
  lines.push('', 'Exit codes: 0 succeeded, 2 blocked, 3 failed/invalid input, 4 partial, 5 outcome_unknown.');
  return `${lines.join('\n')}\n`;
}
