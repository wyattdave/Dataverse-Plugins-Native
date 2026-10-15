import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_KINDS, OPERATIONS, runOperation } from '../app/operations.js';
import { CAPABILITY_REGISTRY } from '../contracts/capability.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import type { CommandResult } from '../contracts/result.js';
import { bool, int, obj, str, validateSchema, type Schema } from '../contracts/schema.js';
import { DEFAULT_MAX_INPUT_BYTES } from '../core/documents.js';
import { buildResult } from '../core/result.js';
import { parseStrictJson, StrictJsonError } from '../core/strictJson.js';
import { checkSpecText, deploy } from '../studio/deploy.js';
import { createPacRunner, normalizeEnvironmentUrl, PacClient, PacNotFoundError, lastLines, pacError, type PacRunner } from '../studio/pac.js';
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

/** Synthetic, commit-safe examples only; the server never reads user-supplied paths. */
export const EXAMPLE_FILES = [
  'instant.plugin.json',
  'automated.plugin.json',
  'calculation.spec.json',
  'synthetic.target.json',
  'target.template.json',
  'converged.snapshot.json',
  'drifted.snapshot.json',
  'interrupted.journal.json',
] as const;

const MAX_BODY_BYTES = DOCUMENT_KINDS.length * DEFAULT_MAX_INPUT_BYTES * 2;

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

const documentText = () => str({ maxLength: DEFAULT_MAX_INPUT_BYTES });
const runRequestSchema: Schema = obj(
  {
    operation: str({ enum: Object.keys(OPERATIONS) }),
    documents: obj(Object.fromEntries(DOCUMENT_KINDS.map((k) => [k, documentText()])), DOCUMENT_KINDS),
    offline: bool(),
  },
  ['offline'],
);

const specText = () => str({ minLength: 1, maxLength: DEFAULT_MAX_INPUT_BYTES });
const checkRequestSchema: Schema = obj({ spec: specText() });
const selectRequestSchema: Schema = obj({ index: int({ min: 1, max: 999 }) });
const deployRequestSchema: Schema = obj({
  spec: specText(),
  environmentUrl: str({ maxLength: 512 }),
  confirmEnvironmentUrl: str({ maxLength: 512 }),
});

export interface UiServerOptions {
  port?: number;
  now?: () => Date;
  /** Runs the Power Platform CLI; tests inject a fake. */
  pacRunner?: PacRunner;
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
export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const now = options.now ?? (() => new Date());
  const pac = new PacClient(options.pacRunner ?? createPacRunner());
  let pacBusy = false;
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
  const sendFailure = (res: ServerResponse, status: number, code: ReasonCode, extra: Partial<CommandResult> = {}): void => {
    sendJson(res, status, { ...buildResult('ui', { status: 'failed', reasonCodes: [code] }, now()), ...extra });
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
      sendFailure(res, 421, 'UI_HOST_REJECTED');
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
      sendFailure(res, 403, 'UI_ORIGIN_REJECTED');
      return;
    }
    if (!tokenMatches(req.headers['x-dv-session'])) {
      sendFailure(res, 401, 'UI_SESSION_INVALID');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/meta') {
      sendJson(res, 200, {
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        operations: OPERATIONS,
        documentKinds: DOCUMENT_KINDS,
        capabilities: CAPABILITY_REGISTRY,
        examples: EXAMPLE_FILES,
        limits: { maxDocumentBytes: DEFAULT_MAX_INPUT_BYTES },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/examples/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/examples/'.length));
      const content = examples.get(name);
      if (content === undefined) {
        sendFailure(res, 404, 'UI_NOT_FOUND');
        return;
      }
      sendJson(res, 200, { name, content });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const parsed = await readJsonRequest(req, res, runRequestSchema);
      if (parsed === undefined) {
        return;
      }
      const request = parsed as { operation: string; documents: Record<string, string>; offline?: boolean };
      const result = await runOperation({
        operation: request.operation,
        documents: request.documents,
        ...(request.offline !== undefined ? { offline: request.offline } : {}),
        now: now(),
      });
      sendJson(res, 200, result);
      return;
    }

    if (url.pathname.startsWith('/api/studio/')) {
      await handleStudio(req, res, url.pathname.slice('/api/studio/'.length));
      return;
    }

    sendFailure(res, 404, 'UI_NOT_FOUND');
  };

  /** Reads and strictly validates a JSON body; on failure the response has already been sent. */
  const readJsonRequest = async (req: IncomingMessage, res: ServerResponse, schema: Schema): Promise<unknown> => {
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      sendFailure(res, 415, 'UI_UNSUPPORTED_MEDIA_TYPE');
      return undefined;
    }
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > MAX_BODY_BYTES) {
      res.setHeader('Connection', 'close');
      sendFailure(res, 413, 'UI_REQUEST_TOO_LARGE');
      req.resume();
      return undefined;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === undefined) {
      res.setHeader('Connection', 'close');
      sendFailure(res, 413, 'UI_REQUEST_TOO_LARGE');
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch (error) {
      const code = error instanceof StrictJsonError ? error.code : 'UI_REQUEST_INVALID';
      sendFailure(res, 400, 'UI_REQUEST_INVALID', { reasonCodes: ['UI_REQUEST_INVALID', code] });
      return undefined;
    }
    const problems = validateSchema(parsed, schema);
    if (problems.length > 0) {
      sendFailure(res, 400, 'UI_REQUEST_INVALID', { diagnostics: problems });
      return undefined;
    }
    return parsed;
  };

  /** pac calls are serialized: sign-in and import must never overlap. */
  const withPac = async (res: ServerResponse, work: () => Promise<unknown>): Promise<void> => {
    if (pacBusy) {
      sendJson(res, 409, { error: 'Another pac operation is still running.' });
      return;
    }
    pacBusy = true;
    try {
      sendJson(res, 200, await work());
    } catch (error) {
      const message = error instanceof PacNotFoundError ? error.message : 'pac failed unexpectedly.';
      sendJson(res, error instanceof PacNotFoundError ? 503 : 500, { error: message });
    } finally {
      pacBusy = false;
    }
  };

  const handleStudio = async (req: IncomingMessage, res: ServerResponse, route: string): Promise<void> => {
    if (req.method === 'GET' && route === 'meta') {
      sendJson(res, 200, {
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        parameterTypes: PARAMETER_TYPES,
        messages: TRIGGER_MESSAGES,
        stages: Object.keys(TRIGGER_STAGES),
        examples: EXAMPLE_FILES.filter((name) => name.endsWith('.plugin.json')),
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
    if (req.method === 'GET' && route === 'profiles') {
      await withPac(res, async () => ({ profiles: await pac.profiles() }));
      return;
    }
    if (req.method === 'POST' && route === 'login') {
      await withPac(res, async () => {
        const result = await pac.login();
        return { ok: result.code === 0, output: lastLines(result.output), profiles: await pac.profiles() };
      });
      return;
    }
    if (req.method === 'POST' && route === 'select') {
      const body = (await readJsonRequest(req, res, selectRequestSchema)) as { index: number } | undefined;
      if (body !== undefined) {
        await withPac(res, async () => {
          const result = await pac.selectProfile(body.index);
          return { ok: result.code === 0, output: lastLines(result.output), profiles: await pac.profiles() };
        });
      }
      return;
    }
    if (req.method === 'GET' && route === 'environments') {
      await withPac(res, async () => {
        const { environments, result } = await pac.environments();
        return result.code === 0 ? { environments } : { environments, error: pacError(result.output) };
      });
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
      await withPac(res, () => deploy({ specText: body.spec, environmentUrl: target, pac }));
      return;
    }
    sendFailure(res, 404, 'UI_NOT_FOUND');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        sendFailure(res, 500, 'INTERNAL_ERROR');
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
