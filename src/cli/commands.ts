import { open } from 'node:fs/promises';
import { diag, type JsonValue } from '../contracts/common.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import type { CommandResult } from '../contracts/result.js';
import { inputFailure, OPERATIONS, runOperation, type DocumentKind, type OperationName } from '../app/operations.js';
import { readTextFile } from '../core/documents.js';
import { buildResult } from '../core/result.js';

export interface CommandContext {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
  now: Date;
}

const OPTION_DOCUMENTS: Readonly<Record<string, DocumentKind>> = {
  '--spec': 'spec',
  '--target': 'target',
  '--snapshot': 'snapshot',
  '--plan': 'plan',
  '--approval': 'approval',
  '--journal': 'journal',
};

async function writeNewPrivateFile(path: string, content: string): Promise<ReasonCode | undefined> {
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'OUTPUT_FILE_EXISTS' : 'OUTPUT_FILE_UNWRITABLE';
  }
}

/** Thin file adapter over runOperation. Blocked stubs read no files at all. */
export async function runCommand(ctx: CommandContext): Promise<CommandResult> {
  const operation = ctx.command as OperationName;
  const spec = OPERATIONS[operation];
  const documents: Partial<Record<DocumentKind, string>> = {};
  if (spec.blockedCapabilities.length === 0) {
    for (const [option, kind] of Object.entries(OPTION_DOCUMENTS)) {
      const path = ctx.values.get(option);
      if (path === undefined) {
        continue;
      }
      const loaded = await readTextFile(path, kind);
      if (loaded.text === undefined) {
        return inputFailure(ctx.command, loaded.diagnostics, ctx.now);
      }
      documents[kind] = loaded.text;
    }
  }
  const result = await runOperation({ operation, documents, offline: ctx.flags.has('--offline'), now: ctx.now });

  const out = ctx.values.get('--out');
  if (operation === 'plan' && out !== undefined && result.status === 'succeeded' && result.data !== null) {
    const plan = (result.data as { plan: JsonValue }).plan;
    const failure = await writeNewPrivateFile(out, `${JSON.stringify(plan, null, 2)}\n`);
    if (failure !== undefined) {
      return buildResult(
        ctx.command,
        {
          status: 'failed',
          reasonCodes: [failure],
          planId: result.planId,
          planHash: result.planHash,
          diagnostics: [diag(failure, 'error', 'preflight', 'Plan output must be a new file; existing files are never overwritten.')],
        },
        ctx.now,
      );
    }
    return { ...result, data: { plan, planFile: out } };
  }
  return result;
}
