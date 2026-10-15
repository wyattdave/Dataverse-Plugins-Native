import { randomUUID } from 'node:crypto';
import {
  EXIT_CODES,
  sortDiagnostics,
  uniqueSorted,
  type Completeness,
  type Diagnostic,
  type JsonValue,
  type ResultStatus,
  type ValidationPhase,
} from '../contracts/common.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import { RESULT_SCHEMA_VERSION, type CommandResult, type OperationOutcome } from '../contracts/result.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { CAPABILITY_FINGERPRINT } from './policy.js';

export interface ResultInit {
  status: ResultStatus;
  reasonCodes?: readonly ReasonCode[];
  validation?: readonly ValidationPhase[];
  operations?: readonly OperationOutcome[];
  planId?: string | null;
  planHash?: string | null;
  journalReference?: string | null;
  targetFingerprint?: string | null;
  completeness?: Completeness | 'not-applicable';
  diagnostics?: readonly Diagnostic[];
  data?: JsonValue | null;
}

/** Builds the stable adapter.result/v1 envelope. Execution readiness is always blocked in Phase 1. */
export function buildResult(command: string, init: ResultInit, now: Date = new Date()): CommandResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    command,
    status: init.status,
    exitCode: EXIT_CODES[init.status],
    reasonCodes: uniqueSorted(init.reasonCodes ?? []),
    executionReadiness: 'blocked',
    planId: init.planId ?? null,
    planHash: init.planHash ?? null,
    validation: [...(init.validation ?? [])],
    operations: [...(init.operations ?? [])],
    journalReference: init.journalReference ?? null,
    runId: randomUUID(),
    generatedAt: now.toISOString(),
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    target: { fingerprint: init.targetFingerprint ?? null, effectiveEnvironmentClass: 'unknown' },
    principal: { fingerprint: null, status: 'unresolved' },
    completeness: init.completeness ?? 'not-applicable',
    capabilityFingerprint: CAPABILITY_FINGERPRINT,
    diagnostics: sortDiagnostics(init.diagnostics ?? []),
    data: init.data ?? null,
  };
}
