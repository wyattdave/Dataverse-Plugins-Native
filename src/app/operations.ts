import { APPROVAL_SCHEMA_VERSION, approvalSchema, type ApprovalEnvelope } from '../contracts/approval.js';
import { capabilityFor, type CapabilityOperation } from '../contracts/capability.js';
import { diag, hasErrors, uniqueSorted, type Diagnostic, type JsonValue, type ValidationPhase } from '../contracts/common.js';
import { PLAN_SCHEMA_VERSION, planSchema, type Plan } from '../contracts/plan.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import type { CommandResult, OperationOutcome } from '../contracts/result.js';
import type { Snapshot } from '../contracts/snapshot.js';
import { MVP_FUNCTION_PROFILE, type FunctionSpec } from '../contracts/spec.js';
import type { TargetConfig } from '../contracts/target.js';
import { verifyApproval, verifyPlanIntegrity } from '../core/approval.js';
import { hashCanonical } from '../core/canonical.js';
import { DEFAULT_MAX_INPUT_BYTES, parseDocument } from '../core/documents.js';
import { parseJournalText } from '../core/journalStore.js';
import { buildDesiredState, buildPlan } from '../core/planner.js';
import { assessClassification, checkIdentityMatch, checkOwnership, normalizeIdentity, writeGateReasons } from '../core/policy.js';
import { reconcileJournal } from '../core/reconcile.js';
import { buildResult } from '../core/result.js';
import { validateSnapshotText, validateSpecText, validateTargetText } from '../core/validators.js';
import { verifyAgainstSnapshot } from '../core/verifier.js';
import { BlockedNativeProvider, type NativeProvider } from '../dataverse/nativeProvider.js';

/**
 * Host-neutral operations. The CLI and the local UI both call runOperation with document *text*; neither
 * has its own policy or gate logic, so every caller gets identical contracts and blocked mutations.
 */
export const DOCUMENT_KINDS = ['spec', 'target', 'snapshot', 'plan', 'approval', 'journal'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface OperationSpec {
  required: readonly DocumentKind[];
  optional: readonly DocumentKind[];
  acceptsOffline: boolean;
  group: 'check' | 'compare' | 'gated' | 'recovery';
  blockedCapabilities: readonly CapabilityOperation[];
  summary: string;
}

export const OPERATIONS = {
  validate: {
    required: ['spec'],
    optional: ['target'],
    acceptsOffline: true,
    group: 'check',
    blockedCapabilities: [],
    summary: 'Strict schema and policy checks. Offline scope skips metadata; host validation is always unknown.',
  },
  inspect: {
    required: [],
    optional: ['snapshot', 'target'],
    acceptsOffline: false,
    group: 'compare',
    blockedCapabilities: [],
    summary: 'Summarize a snapshot offline, or request live target inspection (blocked: no token provider).',
  },
  plan: {
    required: ['spec'],
    optional: ['snapshot', 'target'],
    acceptsOffline: false,
    group: 'compare',
    blockedCapabilities: [],
    summary: 'Deterministic draft plan: desired vs observed diff with blocked intent operations.',
  },
  verify: {
    required: ['spec'],
    optional: ['snapshot', 'target'],
    acceptsOffline: false,
    group: 'compare',
    blockedCapabilities: [],
    summary: 'Compare desired state with a snapshot; read-back stays unknown without live graph reads.',
  },
  approve: {
    required: ['plan'],
    optional: [],
    acceptsOffline: false,
    group: 'gated',
    blockedCapabilities: [],
    summary: 'Refuses draft plans; Phase 1 never issues approvals.',
  },
  apply: {
    required: ['plan'],
    optional: ['approval'],
    acceptsOffline: false,
    group: 'gated',
    blockedCapabilities: [],
    summary: 'Checks plan integrity and approval gates; always blocked, dispatches nothing.',
  },
  test: {
    required: [],
    optional: [],
    acceptsOffline: false,
    group: 'gated',
    blockedCapabilities: ['function.invoke'],
    summary: 'Function invocation requires a separate test gate (Phase 3+).',
  },
  'package export': {
    required: [],
    optional: [],
    acceptsOffline: false,
    group: 'gated',
    blockedCapabilities: ['package.export'],
    summary: 'Native package export is not enabled (Phase 5).',
  },
  'package import': {
    required: [],
    optional: [],
    acceptsOffline: false,
    group: 'gated',
    blockedCapabilities: ['package.import'],
    summary: 'Native package import is not enabled (Phase 5).',
  },
  retire: {
    required: [],
    optional: [],
    acceptsOffline: false,
    group: 'gated',
    blockedCapabilities: ['component.retire', 'component.deactivate'],
    summary: 'Generic delete is disabled until native teardown is proven.',
  },
  reconcile: {
    required: ['journal'],
    optional: ['snapshot'],
    acceptsOffline: false,
    group: 'recovery',
    blockedCapabilities: [],
    summary: 'Read-only journal analysis against an optional snapshot; never retries or repairs.',
  },
  recover: {
    required: [],
    optional: [],
    acceptsOffline: false,
    group: 'recovery',
    blockedCapabilities: ['configuration.recover'],
    summary: 'Compensating recovery protocol is unverified.',
  },
} as const satisfies Record<string, OperationSpec>;

export type OperationName = keyof typeof OPERATIONS;

export function isOperationName(value: string): value is OperationName {
  return Object.hasOwn(OPERATIONS, value);
}

export interface OperationRequest {
  operation: string;
  documents: Partial<Record<DocumentKind, string>>;
  offline?: boolean;
  now: Date;
}

const asJson = (value: unknown): JsonValue => value as JsonValue;
const errorCodes = (diagnostics: readonly Diagnostic[]): ReasonCode[] => diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const HOST_PHASE: ValidationPhase = { phase: 'host', status: 'unknown', reason: 'NO_PROVEN_NON_EXECUTING_VALIDATOR' };

export function inputFailure(command: string, diagnostics: readonly Diagnostic[], now: Date): CommandResult {
  const codes = errorCodes(diagnostics);
  return buildResult(
    command,
    { status: 'failed', reasonCodes: codes, validation: [{ phase: 'schema', status: 'failed', reason: codes[0] ?? 'INTERNAL_ERROR' }], diagnostics },
    now,
  );
}

function identityFailure(command: string, diagnostics: Diagnostic[], now: Date): CommandResult {
  return buildResult(
    command,
    {
      status: 'blocked',
      reasonCodes: ['TARGET_IDENTITY_MISMATCH'],
      validation: [{ phase: 'policy', status: 'failed', reason: 'TARGET_IDENTITY_MISMATCH' }],
      diagnostics,
    },
    now,
  );
}

type Loaded<T> = { ok: true; value: T; sha256?: string; diagnostics?: Diagnostic[] } | { ok: false; result: CommandResult };

class Documents {
  constructor(
    private readonly command: string,
    private readonly docs: Partial<Record<DocumentKind, string>>,
    private readonly now: Date,
  ) {}

  has(kind: DocumentKind): boolean {
    return this.docs[kind] !== undefined;
  }

  spec(): Loaded<FunctionSpec> {
    const validated = validateSpecText(this.docs.spec!);
    if (validated.value === undefined) {
      return { ok: false, result: inputFailure(this.command, validated.diagnostics, this.now) };
    }
    return { ok: true, value: validated.value, diagnostics: validated.diagnostics };
  }

  target(): Loaded<TargetConfig> | undefined {
    if (!this.has('target')) {
      return undefined;
    }
    const validated = validateTargetText(this.docs.target!);
    if (validated.value === undefined) {
      return { ok: false, result: inputFailure(this.command, validated.diagnostics, this.now) };
    }
    if (!validated.policyPassed) {
      const codes = errorCodes(validated.diagnostics);
      return {
        ok: false,
        result: buildResult(
          this.command,
          {
            status: 'blocked',
            reasonCodes: codes,
            validation: [
              { phase: 'schema', status: 'passed' },
              { phase: 'policy', status: 'failed', reason: codes[0]! },
            ],
            diagnostics: validated.diagnostics,
          },
          this.now,
        ),
      };
    }
    return { ok: true, value: validated.value };
  }

  snapshot(): Loaded<Snapshot> | undefined {
    if (!this.has('snapshot')) {
      return undefined;
    }
    const validated = validateSnapshotText(this.docs.snapshot!);
    if (validated.value === undefined || !validated.policyPassed) {
      return { ok: false, result: inputFailure(this.command, validated.diagnostics, this.now) };
    }
    return { ok: true, value: validated.value, sha256: validated.sha256! };
  }

  plan(): Loaded<Plan> {
    const parsed = parseDocument<Plan>(this.docs.plan!, planSchema, PLAN_SCHEMA_VERSION, 'plan');
    if (parsed.value === undefined) {
      return { ok: false, result: inputFailure(this.command, parsed.diagnostics, this.now) };
    }
    return { ok: true, value: parsed.value };
  }

  approval(): Loaded<ApprovalEnvelope> | undefined {
    if (!this.has('approval')) {
      return undefined;
    }
    const parsed = parseDocument<ApprovalEnvelope>(this.docs.approval!, approvalSchema, APPROVAL_SCHEMA_VERSION, 'approval');
    if (parsed.value === undefined) {
      return { ok: false, result: inputFailure(this.command, parsed.diagnostics, this.now) };
    }
    return { ok: true, value: parsed.value };
  }
}

/** Single entry point for every host. Unknown operations, unexpected documents, and oversize inputs fail closed. */
export async function runOperation(request: OperationRequest, provider: NativeProvider = new BlockedNativeProvider()): Promise<CommandResult> {
  const { operation, now } = request;
  if (!isOperationName(operation)) {
    return buildResult('cli', { status: 'failed', reasonCodes: ['CLI_UNKNOWN_COMMAND'] }, now);
  }
  const spec: OperationSpec = OPERATIONS[operation];
  const fail = (code: ReasonCode, message: string, path?: string): CommandResult =>
    inputFailure(operation, [diag(code, 'error', 'schema', message, path)], now);

  for (const [kind, text] of Object.entries(request.documents) as [DocumentKind, string | undefined][]) {
    if (text === undefined) {
      continue;
    }
    if (!(DOCUMENT_KINDS as readonly string[]).includes(kind) || (!spec.required.includes(kind) && !spec.optional.includes(kind))) {
      return fail('INPUT_DOCUMENT_UNEXPECTED', `"${operation}" does not accept a ${kind} document.`, `/documents/${kind}`);
    }
    if (Buffer.byteLength(text, 'utf8') > DEFAULT_MAX_INPUT_BYTES) {
      return fail('INPUT_TOO_LARGE', `${kind}: document exceeds ${DEFAULT_MAX_INPUT_BYTES} bytes.`, `/documents/${kind}`);
    }
  }
  for (const kind of spec.required) {
    if (request.documents[kind] === undefined) {
      return fail('INPUT_DOCUMENT_MISSING', `"${operation}" requires a ${kind} document.`, `/documents/${kind}`);
    }
  }
  if (request.offline === true && !spec.acceptsOffline) {
    return fail('INPUT_OPTION_UNEXPECTED', `"${operation}" does not accept the offline option.`);
  }

  const docs = new Documents(operation, request.documents, now);
  switch (operation) {
    case 'validate':
      return runValidate(docs, request.offline === true, now);
    case 'plan':
      return runPlan(docs, now);
    case 'inspect':
      if (!docs.has('snapshot') && !docs.has('target')) {
        return fail('CLI_MODE_REQUIRED', 'inspect needs a snapshot (offline) and/or a target (live, blocked).');
      }
      return runInspect(docs, now);
    case 'verify':
      return runVerify(docs, now);
    case 'apply':
      return runApply(docs, now, provider);
    case 'approve':
      return runApprove(docs, now);
    case 'reconcile':
      return runReconcile(request.documents.journal!, docs, now);
    default:
      return runBlockedStub(operation, now);
  }
}

function runValidate(docs: Documents, offline: boolean, now: Date): CommandResult {
  const spec = docs.spec();
  if (!spec.ok) {
    return spec.result;
  }
  const target = docs.target();
  if (target !== undefined && !target.ok) {
    return target.result;
  }
  const diagnostics = [...(spec.diagnostics ?? [])];
  if (target?.ok) {
    diagnostics.push(...checkOwnership(spec.value, target.value));
  }
  const policyFailed = hasErrors(diagnostics);
  const desired = buildDesiredState(spec.value);
  return buildResult(
    'validate',
    {
      status: policyFailed || !offline ? 'blocked' : 'succeeded',
      reasonCodes: [...errorCodes(diagnostics), offline ? 'OFFLINE_SCOPE_ONLY' : 'LIVE_TRANSPORT_NOT_CONFIGURED'],
      validation: [
        { phase: 'schema', status: 'passed' },
        policyFailed ? { phase: 'policy', status: 'failed', reason: errorCodes(diagnostics)[0]! } : { phase: 'policy', status: 'passed' },
        offline
          ? { phase: 'metadata-bindings', status: 'skipped', reason: 'OFFLINE_SCOPE_ONLY' }
          : { phase: 'metadata-bindings', status: 'unknown', reason: 'LIVE_TRANSPORT_NOT_CONFIGURED' },
        HOST_PHASE,
      ],
      diagnostics,
      targetFingerprint: target?.ok ? hashCanonical(normalizeIdentity(target.value.expectedTarget)) : null,
      data: asJson({
        scope: offline ? 'offline' : 'offline+live-metadata',
        specSha256: desired.specSha256,
        sourceSha256: desired.sourceSha256,
        profileId: MVP_FUNCTION_PROFILE.id,
      }),
    },
    now,
  );
}

function runPlan(docs: Documents, now: Date): CommandResult {
  const spec = docs.spec();
  if (!spec.ok) {
    return spec.result;
  }
  const target = docs.target();
  if (target !== undefined && !target.ok) {
    return target.result;
  }
  const snapshot = docs.snapshot();
  if (snapshot !== undefined && !snapshot.ok) {
    return snapshot.result;
  }
  const outcome = buildPlan({
    spec: spec.value,
    ...(target?.ok ? { target: target.value } : {}),
    ...(snapshot?.ok ? { snapshot: { value: snapshot.value, sha256: snapshot.sha256! } } : {}),
  });
  if (outcome.kind === 'blocked') {
    return identityFailure('plan', outcome.diagnostics, now);
  }
  const plan = outcome.plan;
  const policyErrors = errorCodes(plan.diagnostics.filter((d) => d.phase === 'policy'));
  return buildResult(
    'plan',
    {
      status: 'succeeded',
      reasonCodes: plan.blockingReasons,
      planId: plan.planId,
      planHash: plan.planHash,
      validation: [
        { phase: 'schema', status: 'passed' },
        policyErrors.length > 0 ? { phase: 'policy', status: 'failed', reason: policyErrors[0]! } : { phase: 'policy', status: 'passed' },
        snapshot?.ok
          ? { phase: 'metadata-bindings', status: 'unknown', reason: 'SNAPSHOT_MAPPING_UNVERIFIED' }
          : { phase: 'metadata-bindings', status: 'skipped', reason: 'SNAPSHOT_NOT_PROVIDED' },
        HOST_PHASE,
        { phase: 'preflight', status: 'unknown', reason: 'PREFLIGHT_REQUIRES_LIVE_READS' },
      ],
      operations: plan.operations.map((op) => ({ operationId: op.id, kind: op.kind, status: 'blocked', dispatched: false, reasonCodes: op.reasonCodes })),
      targetFingerprint: plan.target.fingerprint,
      completeness: plan.evidence.completeness,
      diagnostics: plan.diagnostics,
      data: asJson({ plan }),
    },
    now,
  );
}

function runInspect(docs: Documents, now: Date): CommandResult {
  const target = docs.target();
  if (target !== undefined && !target.ok) {
    return target.result;
  }
  const snapshot = docs.snapshot();
  if (snapshot !== undefined && !snapshot.ok) {
    return snapshot.result;
  }
  const targetFingerprint = target?.ok ? hashCanonical(normalizeIdentity(target.value.expectedTarget)) : null;
  if (snapshot === undefined) {
    return buildResult(
      'inspect',
      {
        status: 'blocked',
        reasonCodes: ['LIVE_TRANSPORT_NOT_CONFIGURED'],
        validation: [
          { phase: 'schema', status: 'passed' },
          { phase: 'policy', status: 'passed' },
          { phase: 'metadata-bindings', status: 'unknown', reason: 'LIVE_TRANSPORT_NOT_CONFIGURED' },
        ],
        targetFingerprint,
        completeness: 'unknown',
        diagnostics: [
          diag('LIVE_TRANSPORT_NOT_CONFIGURED', 'error', 'metadata-bindings', 'Live inspection needs an approved public client ID and token provider; none is configured.'),
        ],
        data: asJson({ live: 'blocked', expectedEnvironmentClass: target?.ok ? target.value.expectedEnvironmentClass : null }),
      },
      now,
    );
  }
  const snap = snapshot.value;
  if (target?.ok) {
    const mismatch = checkIdentityMatch(target.value.expectedTarget, snap.target);
    if (mismatch.length > 0) {
      return identityFailure('inspect', mismatch, now);
    }
  }
  const classification = assessClassification(snap.target.environmentClass);
  const diagnostics: Diagnostic[] = [...classification.diagnostics];
  if (snap.completeness.status !== 'complete') {
    diagnostics.push(diag('SNAPSHOT_INCOMPLETE', 'warning', 'metadata-bindings', `Snapshot completeness is ${snap.completeness.status}.`));
  }
  if (snap.source.kind === 'synthetic') {
    diagnostics.push(diag('SNAPSHOT_SYNTHETIC', 'info', 'metadata-bindings', 'Snapshot is synthetic; it is not evidence about any tenant.'));
  }
  diagnostics.push(diag('SNAPSHOT_MAPPING_UNVERIFIED', 'warning', 'metadata-bindings', 'Platform-to-projection mapping is unverified (U03).'));
  const counts = new Map<string, number>();
  for (const c of snap.components) {
    counts.set(c.uniqueName.toLowerCase(), (counts.get(c.uniqueName.toLowerCase()) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  if (duplicates.length > 0) {
    diagnostics.push(diag('SNAPSHOT_AMBIGUOUS_IDENTITY', 'warning', 'metadata-bindings', 'Snapshot contains duplicate or case-variant identities.'));
  }
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(snap.acquiredAt)) / 1000));
  return buildResult(
    'inspect',
    {
      status: 'succeeded',
      reasonCodes: ['OFFLINE_SCOPE_ONLY', classification.reason],
      validation: [
        { phase: 'schema', status: 'passed' },
        { phase: 'policy', status: 'passed' },
        { phase: 'metadata-bindings', status: 'skipped', reason: 'OFFLINE_SCOPE_ONLY' },
      ],
      targetFingerprint: targetFingerprint ?? hashCanonical(normalizeIdentity(snap.target)),
      completeness: snap.completeness.status,
      diagnostics,
      data: asJson({
        snapshotSha256: snapshot.sha256,
        source: snap.source,
        acquiredAt: snap.acquiredAt,
        ageSeconds,
        completeness: snap.completeness,
        claimedEnvironmentClass: snap.target.environmentClass,
        effectiveEnvironmentClass: 'unknown',
        duplicateIdentities: duplicates,
        components: snap.components.map((c) => ({
          uniqueName: c.uniqueName,
          displayName: c.displayName,
          binding: c.binding,
          managedState: c.managedState,
          solutions: c.solutions,
          parameterCount: c.parameters.length,
          formulaSha256: c.formula?.sha256 ?? null,
        })),
      }),
    },
    now,
  );
}

function runVerify(docs: Documents, now: Date): CommandResult {
  const spec = docs.spec();
  if (!spec.ok) {
    return spec.result;
  }
  const target = docs.target();
  if (target !== undefined && !target.ok) {
    return target.result;
  }
  const snapshot = docs.snapshot();
  if (snapshot !== undefined && !snapshot.ok) {
    return snapshot.result;
  }
  if (target?.ok && snapshot?.ok) {
    const mismatch = checkIdentityMatch(target.value.expectedTarget, snapshot.value.target);
    if (mismatch.length > 0) {
      return identityFailure('verify', mismatch, now);
    }
  }
  const report = verifyAgainstSnapshot(spec.value, snapshot?.ok ? snapshot.value : undefined);
  return buildResult(
    'verify',
    {
      status: 'blocked',
      reasonCodes: ['READ_BACK_REQUIRES_LIVE_READS', 'GRAPH_READ_BACK_UNAVAILABLE', ...errorCodes(report.diagnostics)],
      validation: [
        { phase: 'schema', status: 'passed' },
        { phase: 'read-back', status: 'unknown', reason: 'READ_BACK_REQUIRES_LIVE_READS' },
      ],
      completeness: snapshot?.ok ? snapshot.value.completeness.status : 'unknown',
      diagnostics: report.diagnostics,
      data: asJson({ observedStatus: report.observedStatus, invokesFunction: false, checks: report.checks }),
    },
    now,
  );
}

async function runApply(docs: Documents, now: Date, provider: NativeProvider): Promise<CommandResult> {
  const loaded = docs.plan();
  if (!loaded.ok) {
    return loaded.result;
  }
  const plan = loaded.value;
  const integrity = verifyPlanIntegrity(plan);
  let approvalReasons: ReasonCode[] = ['APPROVAL_MISSING'];
  const approval = docs.approval();
  if (approval !== undefined) {
    if (!approval.ok) {
      return approval.result;
    }
    approvalReasons = verifyApproval(plan, approval.value, { now, currentPrincipalFingerprint: null });
  }
  const gateReasons = uniqueSorted<ReasonCode>([
    'PLAN_DRAFT_NOT_EXECUTABLE',
    'PREFLIGHT_REQUIRES_LIVE_READS',
    ...integrity,
    ...approvalReasons,
    ...writeGateReasons('unknown', 'offline'),
  ]);
  const operations: OperationOutcome[] = [];
  for (const op of plan.operations) {
    // Gates always fail in Phase 1; the provider is reachable only when every gate passes, and it is blocked too.
    operations.push(
      gateReasons.length === 0
        ? await provider.execute(op)
        : { operationId: op.id, kind: op.kind, status: 'blocked', dispatched: false, reasonCodes: uniqueSorted([...op.reasonCodes, ...gateReasons]) },
    );
  }
  return buildResult(
    'apply',
    {
      status: 'blocked',
      reasonCodes: [...gateReasons, ...operations.flatMap((o) => o.reasonCodes)],
      planId: plan.planId,
      planHash: plan.planHash,
      validation: [
        { phase: 'schema', status: 'passed' },
        integrity.length > 0 ? { phase: 'integrity', status: 'failed', reason: integrity[0]! } : { phase: 'integrity', status: 'passed' },
        { phase: 'approval', status: 'failed', reason: approvalReasons[0] ?? 'PLAN_NOT_APPROVAL_ELIGIBLE' },
        { phase: 'preflight', status: 'unknown', reason: 'PREFLIGHT_REQUIRES_LIVE_READS' },
      ],
      operations,
      targetFingerprint: plan.target.fingerprint,
      data: asJson({ dispatched: 0, provider: { id: provider.id, version: provider.version } }),
    },
    now,
  );
}

function runApprove(docs: Documents, now: Date): CommandResult {
  const loaded = docs.plan();
  if (!loaded.ok) {
    return loaded.result;
  }
  const plan = loaded.value;
  const integrity = verifyPlanIntegrity(plan);
  return buildResult(
    'approve',
    {
      status: 'blocked',
      reasonCodes: ['PLAN_NOT_APPROVAL_ELIGIBLE', 'PLAN_DRAFT_NOT_EXECUTABLE', ...integrity],
      planId: plan.planId,
      planHash: plan.planHash,
      validation: [
        integrity.length > 0 ? { phase: 'integrity', status: 'failed', reason: integrity[0]! } : { phase: 'integrity', status: 'passed' },
        { phase: 'approval', status: 'failed', reason: 'PLAN_NOT_APPROVAL_ELIGIBLE' },
      ],
      targetFingerprint: plan.target.fingerprint,
      data: asJson({ approvalIssued: false }),
    },
    now,
  );
}

function runReconcile(journalText: string, docs: Documents, now: Date): CommandResult {
  const read = parseJournalText(journalText);
  if (read.journal === undefined) {
    return inputFailure('reconcile', read.diagnostics, now);
  }
  const snapshot = docs.snapshot();
  if (snapshot !== undefined && !snapshot.ok) {
    return snapshot.result;
  }
  const report = reconcileJournal(read.journal, snapshot?.ok ? snapshot.value : undefined);
  return buildResult(
    'reconcile',
    {
      status: report.status,
      reasonCodes: report.reasonCodes,
      validation: [
        { phase: 'integrity', status: hasErrors(report.diagnostics.filter((d) => d.phase === 'integrity')) ? 'failed' : 'passed' },
        { phase: 'read-back', status: 'unknown', reason: snapshot?.ok ? 'SNAPSHOT_MAPPING_UNVERIFIED' : 'READ_BACK_REQUIRES_LIVE_READS' },
      ],
      operations: report.operations.map(({ operationId, kind, status, dispatched, reasonCodes }) => ({ operationId, kind, status, dispatched, reasonCodes })),
      journalReference: `journal:${read.journal.runId}`,
      completeness: snapshot?.ok ? snapshot.value.completeness.status : 'unknown',
      diagnostics: report.diagnostics,
      data: asJson({ planHash: read.journal.planHash, operations: report.operations }),
    },
    now,
  );
}

/** Explicit blocked stubs: no documents are read and nothing is dispatched. */
function runBlockedStub(operation: OperationName, now: Date): CommandResult {
  const capabilities = OPERATIONS[operation].blockedCapabilities.map(capabilityFor);
  return buildResult(
    operation,
    {
      status: 'blocked',
      reasonCodes: capabilities.map((c) => c.reasonCode),
      diagnostics: capabilities.map((c) => diag(c.reasonCode, 'error', 'policy', `Blocked until: ${c.unblockingProof}`)),
      data: asJson({ capabilities }),
    },
    now,
  );
}
