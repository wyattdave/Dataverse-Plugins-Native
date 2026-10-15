const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Whole-line header values (cookies can contain ';', so redact to end of line).
  [/\b(authorization|proxy-authorization|cookie|set-cookie)(\s*["']?\s*:\s*)[^\r\n]*/gi, '$1$2[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]'],
  [
    /\b(client_secret|client_assertion|access_token|refresh_token|id_token|password|pwd|code_verifier|x-ms-client-secret|sig)(\s*["']?\s*[:=]\s*["']?)[^\s"',;&]*/gi,
    '$1$2[REDACTED]',
  ],
];

export const DEFAULT_MAX_LOG_LENGTH = 2000;

/** Removes tokens, cookies, and secrets from free text and bounds its length. */
export function redactText(text: string, maxLength = DEFAULT_MAX_LOG_LENGTH): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.length > maxLength ? `${out.slice(0, maxLength)}…[TRUNCATED]` : out;
}

/** Field names whose values are never logged: code bodies, payloads, business data, and credentials. */
const SENSITIVE_FIELD = /^(formula|expression|compiledexpression|text|source|body|payload|request|response|record|records|data|value|token|accesstoken|secret|password|cookie|authorization|headers)$/i;

export type LogFieldValue = string | number | boolean | null;

export function redactFields(fields: Record<string, unknown>): Record<string, LogFieldValue> {
  const out: Record<string, LogFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_FIELD.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      out[key] = redactText(value, 256);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else {
      out[key] = '[REDACTED_STRUCTURED]';
    }
  }
  return out;
}

export interface LogEvent {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  fields?: Record<string, unknown>;
}

export type LineWriter = (line: string) => void;

/** Structured, redacted diagnostics writer used for standard error. */
export function createLogger(write: LineWriter): (event: LogEvent) => void {
  return (event) => {
    const record: Record<string, unknown> = {
      level: event.level,
      code: redactText(event.code, 64),
      message: redactText(event.message),
    };
    if (event.fields !== undefined) {
      record['fields'] = redactFields(event.fields);
    }
    write(JSON.stringify(record));
  };
}
