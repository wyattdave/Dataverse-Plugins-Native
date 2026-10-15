import type { ReasonCode } from './reasonCodes.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Severity = 'error' | 'warning' | 'info';

export type ValidationPhaseName =
  | 'schema'
  | 'policy'
  | 'metadata-bindings'
  | 'host'
  | 'preflight'
  | 'read-back'
  | 'integrity'
  | 'approval';

export type PhaseStatus = 'passed' | 'failed' | 'skipped' | 'unknown';

export type ResultStatus = 'succeeded' | 'blocked' | 'failed' | 'partial' | 'outcome_unknown';

export type Completeness = 'complete' | 'partial' | 'unknown';

export interface Diagnostic {
  code: ReasonCode;
  severity: Severity;
  phase: ValidationPhaseName;
  path?: string;
  message: string;
}

export interface ValidationPhase {
  phase: ValidationPhaseName;
  status: PhaseStatus;
  reason?: ReasonCode;
}

export const EXIT_CODES = {
  succeeded: 0,
  blocked: 2,
  failed: 3,
  partial: 4,
  outcome_unknown: 5,
} as const satisfies Record<ResultStatus, number>;

const STATUS_PRECEDENCE: readonly ResultStatus[] = ['outcome_unknown', 'partial', 'failed', 'blocked', 'succeeded'];

/** Overall precedence: outcome_unknown, partial, failed, blocked, then succeeded. */
export function worstStatus(...statuses: readonly ResultStatus[]): ResultStatus {
  for (const status of STATUS_PRECEDENCE) {
    if (statuses.includes(status)) {
      return status;
    }
  }
  return 'succeeded';
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function uniqueSorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort(ordinalCompare);
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const d of diagnostics) {
    const key = `${d.severity}|${d.phase}|${d.code}|${d.path ?? ''}|${d.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(d);
    }
  }
  return unique.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      ordinalCompare(a.code, b.code) ||
      ordinalCompare(a.path ?? '', b.path ?? '') ||
      ordinalCompare(a.phase, b.phase) ||
      ordinalCompare(a.message, b.message),
  );
}

export function diag(
  code: ReasonCode,
  severity: Severity,
  phase: ValidationPhaseName,
  message: string,
  path?: string,
): Diagnostic {
  return path === undefined ? { code, severity, phase, message } : { code, severity, phase, path, message };
}

export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
