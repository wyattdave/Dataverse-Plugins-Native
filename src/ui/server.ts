import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bool, obj, str, validateSchema, type Schema } from '../core/schema.js';
import { parseStrictJson } from '../core/strictJson.js';
import { SignInRequiredError, type Auth } from '../studio/auth.js';
import { DataverseClient, normalizeEnvironmentUrl } from '../studio/dataverse.js';
import { checkSpecText, deploy, type DeployResult, type DeployStep } from '../studio/deploy.js';
import { PARAMETER_TYPES, TRIGGER_MESSAGES, TRIGGER_STAGES } from '../studio/spec.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Compiled to dist/src/ui/server.js, so the package root is three levels up. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

/** Commit-safe example specs only; the server never reads user-supplied paths. */
export const EXAMPLE_FILES = ['instant.plugin.json', 'automated.plugin.json'] as const;

const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = MAX_SPEC_BYTES * 2;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const specText = () => str({ minLength: 1, maxLength: MAX_SPEC_BYTES });
const checkRequestSchema: Schema = obj({ spec: specText() });
const loginRequestSchema: Schema = obj({ selectAccount: bool(), reconnect: bool() }, ['selectAccount', 'reconnect']);
const profileRequestSchema: Schema = obj({ id: str({ minLength: 1, maxLength: 200 }) });
const emptyRequestSchema: Schema = obj({});
const deployRequestSchema: Schema = obj({
  spec: specText(),
  environmentUrl: str({ maxLength: 512 }),
  confirmEnvironmentUrl: str({ maxLength: 512 }),
});

export interface UiServerOptions {
  port?: number;
  /** Our own sign-in; tokens stay in this process. */
  auth: Auth;
  /** Dataverse calls; defaults to a client using `auth`. Tests inject one with a fake transport. */
  dataverse?: DataverseClient;
}

export interface UiServer {
  port: number;
  origin: string;
  /** URL to open in a browser; carries the per-session token, which the page moves into sessionStorage. */
  launchUrl: string;
  close(): Promise<void>;
}

/**
 * Starts the local UI on 127.0.0.1 only. Every API call needs the per-session token, an allowed Host header
 * (DNS-rebinding defence), and a same-origin Origin when present. Request bodies are never logged or persisted.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const { auth } = options;
  const dataverse = options.dataverse ?? new DataverseClient(auth);
  /** The current or last deploy; only one runs at a time. */
  let job: { running: boolean; steps: DeployStep[]; result?: DeployResult; error?: string } | undefined;
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token, 'utf8');

  const statics = new Map<string, Buffer>();
  for (const { file } of Object.values(STATIC_FILES)) {
    if (!statics.has(file)) {
      statics.set(file, await readFile(join(PACKAGE_ROOT, 'ui', file)));
    }
  }
  const examples = new Map<string, string>();
  for (const name of EXAMPLE_FILES) {
    examples.set(name, await readFile(join(PACKAGE_ROOT, 'examples', name), 'utf8'));
  }

  let port = 0;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const tokenMatches = (header: string | string[] | undefined): boolean => {
    if (typeof header !== 'string') {
      return false;
    }
    const candidate = Buffer.from(header, 'utf8');
    return candidate.length === tokenBytes.length && timingSafeEqual(candidate, tokenBytes);
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const sendFailure = (res: ServerResponse, status: number, error: string, extra: Record<string, unknown> = {}): void => {
    sendJson(res, status, { error, ...extra });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');

    if (!allowedHosts().has(req.headers.host ?? '')) {
      sendFailure(res, 421, 'Host not allowed.');
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (!url.pathname.startsWith('/api/')) {
      const entry = Object.hasOwn(STATIC_FILES, url.pathname) ? STATIC_FILES[url.pathname] : undefined;
      if (entry === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': entry.type });
      res.end(req.method === 'HEAD' ? undefined : statics.get(entry.file));
      return;
    }

    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(origin)) {
      sendFailure(res, 403, 'Origin not allowed.');
      return;
    }
    if (!tokenMatches(req.headers['x-dv-session'])) {
      sendFailure(res, 401, 'Session token missing or invalid.');
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/examples/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/examples/'.length));
      const content = examples.get(name);
      if (content === undefined) {
        sendFailure(res, 404, 'Not found.');
        return;
      }
      sendJson(res, 200, { name, content });
      return;
    }

    if (url.pathname.startsWith('/api/studio/')) {
      await handleStudio(req, res, url.pathname.slice('/api/studio/'.length));
      return;
    }

    sendFailure(res, 404, 'Not found.');
  };

  /** Reads and strictly validates a JSON body; on failure the response has already been sent. */
  const readJsonRequest = async (req: IncomingMessage, res: ServerResponse, schema: Schema): Promise<unknown> => {
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      sendFailure(res, 415, 'Content-Type must be application/json.');
      return undefined;
    }
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > MAX_BODY_BYTES) {
      res.setHeader('Connection', 'close');
      sendFailure(res, 413, 'Request too large.');
      req.resume();
      return undefined;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === undefined) {
      res.setHeader('Connection', 'close');
      sendFailure(res, 413, 'Request too large.');
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      sendFailure(res, 400, 'Request is not valid JSON.');
      return undefined;
    }
    const problems = validateSchema(parsed, schema);
    if (problems.length > 0) {
      sendFailure(res, 400, 'Request is invalid.', { problems });
      return undefined;
    }
    return parsed;
  };

  const handleStudio = async (req: IncomingMessage, res: ServerResponse, route: string): Promise<void> => {
    if (req.method === 'GET' && route === 'meta') {
      sendJson(res, 200, {
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        parameterTypes: PARAMETER_TYPES,
        messages: TRIGGER_MESSAGES,
        stages: Object.keys(TRIGGER_STAGES),
        examples: EXAMPLE_FILES,
      });
      return;
    }
    if (req.method === 'POST' && route === 'check') {
      const body = (await readJsonRequest(req, res, checkRequestSchema)) as { spec: string } | undefined;
      if (body !== undefined) {
        const checked = checkSpecText(body.spec);
        sendJson(res, 200, { ok: checked.ok, issues: checked.issues });
      }
      return;
    }
    if (req.method === 'GET' && route === 'session') {
      sendJson(res, 200, await auth.status());
      return;
    }
    if (req.method === 'POST' && route === 'login') {
      const body = (await readJsonRequest(req, res, loginRequestSchema)) as { selectAccount?: boolean; reconnect?: boolean } | undefined;
      if (body === undefined) {
        return;
      }
      try {
        await auth.startLogin(body);
        sendJson(res, 200, await auth.status());
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'Sign-in failed.' });
      }
      return;
    }
    if (req.method === 'POST' && route === 'login/cancel') {
      if ((await readJsonRequest(req, res, emptyRequestSchema)) !== undefined) {
        auth.cancelLogin();
        sendJson(res, 200, await auth.status());
      }
      return;
    }
    if (req.method === 'POST' && (route === 'profiles/select' || route === 'profiles/remove')) {
      const body = (await readJsonRequest(req, res, profileRequestSchema)) as { id: string } | undefined;
      if (body === undefined) {
        return;
      }
      try {
        await (route === 'profiles/select' ? auth.useProfile(body.id) : auth.removeProfile(body.id));
        sendJson(res, 200, await auth.status());
      } catch (error) {
        sendJson(res, error instanceof SignInRequiredError ? 404 : 500, { error: error instanceof Error ? error.message : 'Profile update failed.' });
      }
      return;
    }
    if (req.method === 'GET' && route === 'environments') {
      try {
        sendJson(res, 200, { environments: await dataverse.environments() });
      } catch (error) {
        const signInRequired = error instanceof SignInRequiredError;
        sendJson(res, 200, { environments: [], error: error instanceof Error ? error.message : 'Could not list environments.', signInRequired });
      }
      return;
    }
    if (req.method === 'GET' && route === 'deploy') {
      sendJson(res, 200, job ?? { running: false, steps: [] });
      return;
    }
    if (req.method === 'POST' && route === 'deploy') {
      const body = (await readJsonRequest(req, res, deployRequestSchema)) as
        | { spec: string; environmentUrl: string; confirmEnvironmentUrl: string }
        | undefined;
      if (body === undefined) {
        return;
      }
      const target = normalizeEnvironmentUrl(body.environmentUrl);
      if (target === undefined || target !== normalizeEnvironmentUrl(body.confirmEnvironmentUrl)) {
        sendJson(res, 400, { error: 'Deploy needs the environment URL confirmed exactly.' });
        return;
      }
      if (job?.running === true) {
        sendJson(res, 409, { error: 'Another deploy is still running.' });
        return;
      }
      const current: NonNullable<typeof job> = { running: true, steps: [] };
      job = current;
      deploy({ specText: body.spec, environment: target, dataverse, onProgress: (steps) => (current.steps = steps) })
        .then((result) => {
          current.steps = result.steps;
          current.result = result;
        })
        .catch(() => {
          current.error = 'Deploy failed unexpectedly.';
        })
        .finally(() => {
          current.running = false;
        });
      sendJson(res, 202, current);
      return;
    }
    sendFailure(res, 404, 'Not found.');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        sendFailure(res, 500, 'Internal error.');
      } else {
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const originUrl = `http://127.0.0.1:${port}`;
  return {
    port,
    origin: originUrl,
    launchUrl: `${originUrl}/?session=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        auth.cancelLogin();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) {
      exceeded = true;
      continue;
    }
    chunks.push(buffer);
  }
  return exceeded ? undefined : Buffer.concat(chunks);
}
