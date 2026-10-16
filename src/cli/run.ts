import { startUiServer } from '../ui/server.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { commandHelp, isCommand, runCommand } from './commands.js';
import { openInBrowser } from './openBrowser.js';
import { Auth } from '../studio/auth.js';
import { DataverseClient } from '../studio/dataverse.js';
import { defaultProfileStore } from '../studio/profileStore.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Resolves when the long-running UI should stop (defaults to SIGINT/SIGTERM). */
  waitForShutdown?: () => Promise<void>;
  /** Sign-in and Dataverse client; tests inject ones with a fake transport and an in-memory profile store. */
  auth?: Auth;
  dataverse?: DataverseClient;
}

/** Runs one CLI invocation and returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === 'help' || rest.includes('--help')) {
    io.stdout(commandHelp(TOOL_NAME, command === 'help' ? rest[0] : command));
    return 0;
  }
  if (command === '--version') {
    io.stdout(`${TOOL_NAME} ${TOOL_VERSION}\n`);
    return 0;
  }
  if (command === 'ui') {
    const auth = io.auth ?? new Auth({ store: defaultProfileStore(), openUrl: openInBrowser });
    return runUi(rest, io, auth);
  }
  if (isCommand(command)) {
    const auth =
      io.auth ??
      new Auth({
        store: defaultProfileStore(),
        openUrl: (url) => {
          io.stderr(`Complete the sign-in in your browser. If it did not open, go to:\n${url}\n`);
          openInBrowser(url);
        },
      });
    const dataverse = io.dataverse ?? new DataverseClient(auth);
    return runCommand(command, rest, { stdout: io.stdout, stderr: io.stderr, auth, dataverse });
  }
  io.stderr(`Unknown command "${command}". Run ${TOOL_NAME} --help.\n`);
  return 3;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

/** Long-running local UI with the same steps as the CLI. */
async function runUi(argv: readonly string[], io: CliIo, auth: Auth): Promise<number> {
  let port = 0;
  let open = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--open') {
      open = true;
    } else if (argv[i] === '--port' && /^\d{1,5}$/.test(argv[i + 1] ?? '') && Number(argv[i + 1]) <= 65535) {
      port = Number(argv[++i]);
    } else {
      io.stderr('Usage: ui [--port <0-65535>] [--open]\n');
      return 3;
    }
  }
  let server;
  try {
    server = await startUiServer({ port, auth, ...(io.dataverse === undefined ? {} : { dataverse: io.dataverse }) });
  } catch (error) {
    io.stderr(`UI server failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
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
  if (open) {
    openInBrowser(server.launchUrl);
  }
  await (io.waitForShutdown ?? waitForSignal)();
  await server.close();
  io.stdout('UI stopped.\n');
  return 0;
}
