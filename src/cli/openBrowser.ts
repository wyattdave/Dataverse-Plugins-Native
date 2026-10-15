import { spawn } from 'node:child_process';

/** Opens a URL in the default browser without a shell, so the URL is never interpreted by cmd/sh. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is printed to the terminal; opening a browser is a convenience only.
  }
}
