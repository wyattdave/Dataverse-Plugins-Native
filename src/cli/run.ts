import type { CommandResult } from '../contracts/result.js';
import { buildResult } from '../core/result.js';
import { createLogger, redactText } from '../core/redact.js';
import { startUiServer, type UiServer } from '../ui/server.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { helpText, parseArgs } from './args.js';
import { runCommand, type CommandContext } from './commands.js';
import { openInBrowser } from './openBrowser.js';
import { isStudioCommand, runStudioCommand, studioHelp } from './studio.js';
import { createPacRunner, type PacRunner } from '../studio/pac.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => Date;
  /** Resolves when the long-running UI should stop (defaults to SIGINT/SIGTERM). */
  waitForShutdown?: () => Promise<void>;
  /** Runs the Power Platform CLI; tests inject a fake. */
  pacRunner?: PacRunner;
}

function formatText(result: CommandResult): string {
  const lines = [
    `${result.command}: ${result.status} (exit ${result.exitCode}); execution readiness: ${result.executionReadiness}`,
  ];
  if (result.planId !== null) {
    lines.push(`planId:   ${result.planId}`, `planHash: ${result.planHash ?? '-'}`);
  }
  for (const phase of result.validation) {
    lines.push(`  [${phase.phase}] ${phase.status}${phase.reason !== undefined ? ` (${phase.reason})` : ''}`);
  }
  for (const op of result.operations) {
    lines.push(`  ${op.operationId} ${op.kind}: ${op.status}, dispatched=${op.dispatched}`);
  }
  if (result.reasonCodes.length > 0) {
    lines.push(`reasons: ${result.reasonCodes.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Runs one CLI invocation. JSON mode writes exactly one result object to stdout; diagnostics go to redacted stderr. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const pacRunner = io.pacRunner ?? createPacRunner();
  if (isStudioCommand(argv[0]) && !argv.includes('--help')) {
    return runStudioCommand(argv[0]!, argv.slice(1), { stdout: io.stdout, stderr: io.stderr, pacRunner });
  }
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.stdout(helpText(TOOL_NAME, studioHelp(TOOL_NAME)));
    return 0;
  }
  if (parsed.kind === 'version') {
    io.stdout(`${TOOL_NAME} ${TOOL_VERSION}\n`);
    return 0;
  }
  const json = parsed.kind === 'error' ? parsed.json : parsed.flags.has('--json');
  const log = createLogger((line) => io.stderr(`${line}\n`));
  let result: CommandResult;
  if (parsed.kind === 'error') {
    result = buildResult(
      parsed.command,
      { status: 'failed', reasonCodes: [parsed.reasonCode], validation: [{ phase: 'schema', status: 'failed', reason: parsed.reasonCode }] },
      io.now(),
    );
    log({ level: 'error', code: parsed.reasonCode, message: parsed.message });
  } else {
    const ctx: CommandContext = { command: parsed.command, values: parsed.values, flags: parsed.flags, now: io.now() };
    if (ctx.command === 'ui') {
      return runUi(ctx, io, log);
    }
    try {
      result = await runCommand(ctx);
    } catch (error) {
      log({ level: 'error', code: 'INTERNAL_ERROR', message: redactText(error instanceof Error ? error.message : 'Unexpected error.') });
      result = buildResult(ctx.command, { status: 'failed', reasonCodes: ['INTERNAL_ERROR'] }, io.now());
    }
    for (const d of result.diagnostics) {
      if (d.severity !== 'info') {
        log({ level: d.severity, code: d.code, message: d.message, ...(d.path === undefined ? {} : { fields: { path: d.path } }) });
      }
    }
  }
  io.stdout(json ? `${JSON.stringify(result, null, 2)}\n` : formatText(result));
  return result.exitCode;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

/** Long-running local UI. It hosts the same operations as the CLI; nothing it exposes can dispatch a write. */
async function runUi(ctx: CommandContext, io: CliIo, log: ReturnType<typeof createLogger>): Promise<number> {
  let server: UiServer;
  try {
    server = await startUiServer({
      port: Number(ctx.values.get('--port') ?? '0'),
      now: io.now,
      ...(io.pacRunner !== undefined ? { pacRunner: io.pacRunner } : {}),
    });
  } catch (error) {
    log({ level: 'error', code: 'UI_START_FAILED', message: redactText(error instanceof Error ? error.message : 'UI server failed to start.') });
    io.stdout(formatText(buildResult('ui', { status: 'failed', reasonCodes: ['UI_START_FAILED'] }, io.now())));
    return 3;
  }
  io.stdout(
    [
      `${TOOL_NAME} UI running at ${server.launchUrl}`,
      'Local only (127.0.0.1). The session link is secret for this run. Deploys only happen when you confirm them.',
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );
  if (ctx.flags.has('--open')) {
    openInBrowser(server.launchUrl);
  }
  await (io.waitForShutdown ?? waitForSignal)();
  await server.close();
  io.stdout('UI stopped.\n');
  return 0;
}
