import { NATIVE_PROVIDER } from '../contracts/capability.js';
import {
  diag,
  escapePointer,
  ordinalCompare,
  sortDiagnostics,
  uniqueSorted,
  type Completeness,
  type Diagnostic,
} from '../contracts/common.js';
import {
  MAX_APPROVAL_TTL_SECONDS,
  PLAN_ID_VERSION,
  PLAN_SCHEMA_VERSION,
  PLANNER_ID,
  type DesiredProjection,
  type ObservedStatus,
  type OperationEffect,
  type Plan,
  type PlanChange,
  type PlanOperation,
  type PlanOperationKind,
  type PlanPrecondition,
} from '../contracts/plan.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import type { ObservedFunction, Snapshot } from '../contracts/snapshot.js';
import { MVP_FUNCTION_PROFILE, type FunctionSpec, type LogicalNameRef } from '../contracts/spec.js';
import type { TargetConfig, TargetIdentity } from '../contracts/target.js';
import { TOOL_VERSION } from '../version.js';
import { CANONICALIZATION_VERSION, hashCanonical, normalizeFormulaSource, sha256Hex } from './canonical.js';
import {
  assessClassification,
  CAPABILITY_FINGERPRINT,
  checkIdentityMatch,
  checkOwnership,
  checkSpecPolicy,
  normalizeIdentity,
  POLICY,
  POLICY_FINGERPRINT,
} from './policy.js';

export interface PlanInputs {
  spec: FunctionSpec;
  snapshot?: { value: Snapshot; sha256: string };
  target?: TargetConfig;
}

export type PlanOutcome =
  | { kind: 'planned'; plan: Plan }
  | { kind: 'blocked'; reasonCodes: ReasonCode[]; diagnostics: Diagnostic[] };

export const VERIFICATION_CHECKS = [
  'source-sha256',
  'parameters',
  'binding',
  'registration',
  'dependencies',
  'solution-membership',
] as const;

const sortRefs = (refs: readonly LogicalNameRef[]): LogicalNameRef[] =>
  refs.map((r) => ({ logicalName: r.logicalName })).sort((a, b) => ordinalCompare(a.logicalName, b.logicalName));

export interface DesiredState {
  specSha256: string;
  sourceSha256: string;
  projection: DesiredProjection;
}

/** Normalizes only declared line endings and schema-declared sets; parameter order is retained. */
export function buildDesiredState(spec: FunctionSpec): DesiredState {
  const source = normalizeFormulaSource(spec.formula.text, spec.formula.lineEndings);
  const sourceSha256 = sha256Hex(source);
  const tableReferences = sortRefs(spec.tableReferences);
  const connectionReferences = sortRefs(spec.connectionReferences);
  const normalizedSpec = { ...spec, formula: { ...spec.formula, text: source }, tableReferences, connectionReferences };
  return {
    specSha256: hashCanonical(normalizedSpec),
    sourceSha256,
    projection: {
      kind: spec.kind,
      uniqueName: spec.identity.uniqueName,
      displayName: spec.identity.displayName,
      binding: spec.binding,
      solution: { uniqueName: spec.solution.uniqueName, publisherPrefix: spec.solution.publisherPrefix },
      parameters: spec.parameters.map((p) => ({ name: p.name, direction: p.direction, type: p.type })),
      formula: {
        sha256: sourceSha256,
        normalization: spec.formula.lineEndings === 'lf' ? 'lf' : 'none',
        dialect: spec.formula.dialect,
        locale: spec.formula.locale,
      },
      tableReferences,
      connectionReferences,
    },
  };
}

export interface ObservedState {
  status: ObservedStatus;
  projection: ObservedFunction | null;
  completeness: Completeness;
  diagnostics: Diagnostic[];
}

/** "Not found" on an incomplete or out-of-scope read is unknown, never permission to create. */
export function resolveObserved(uniqueName: string, snapshot: Snapshot | undefined): ObservedState {
  if (snapshot === undefined) {
    return {
      status: 'unknown',
      projection: null,
      completeness: 'unknown',
      diagnostics: [
        diag('SNAPSHOT_NOT_PROVIDED', 'warning', 'metadata-bindings', 'No snapshot was supplied; observed state is unknown.'),
        diag('OBSERVED_STATE_UNKNOWN', 'warning', 'metadata-bindings', 'Observed state is unknown; no create or update can be inferred.'),
      ],
    };
  }
  const diagnostics: Diagnostic[] = [];
  const completeness = snapshot.completeness.status;
  if (snapshot.source.kind === 'synthetic') {
    diagnostics.push(diag('SNAPSHOT_SYNTHETIC', 'info', 'metadata-bindings', 'Snapshot is synthetic; it is not evidence about any tenant.'));
  }
  diagnostics.push(
    diag('SNAPSHOT_MAPPING_UNVERIFIED', 'warning', 'metadata-bindings', 'Platform-to-projection mapping is unverified (U03); equality is provisional.'),
  );
  if (completeness !== 'complete') {
    diagnostics.push(diag('SNAPSHOT_INCOMPLETE', 'warning', 'metadata-bindings', `Snapshot completeness is ${completeness}.`, '/completeness'));
  }
  const lower = uniqueName.toLowerCase();
  if (!snapshot.scope.uniqueNames.some((n) => n.toLowerCase() === lower)) {
    diagnostics.push(diag('SNAPSHOT_SCOPE_MISMATCH', 'warning', 'metadata-bindings', 'The spec component is outside the snapshot scope.', '/scope'));
    diagnostics.push(diag('OBSERVED_STATE_UNKNOWN', 'warning', 'metadata-bindings', 'Observed state is unknown for this component.'));
    return { status: 'unknown', projection: null, completeness, diagnostics };
  }
  const matches = snapshot.components.filter((c) => c.uniqueName.toLowerCase() === lower);
  if (matches.length > 1 || (matches.length === 1 && matches[0]!.uniqueName !== uniqueName)) {
    diagnostics.push(
      diag('SNAPSHOT_AMBIGUOUS_IDENTITY', 'error', 'metadata-bindings', 'Duplicate or case-variant identities block planning for this component.', '/components'),
    );
    return { status: 'ambiguous', projection: null, completeness, diagnostics };
  }
  if (matches.length === 1) {
    return { status: 'present', projection: matches[0]!, completeness, diagnostics };
  }
  if (completeness === 'complete') {
    return { status: 'absent', projection: null, completeness, diagnostics };
  }
  diagnostics.push(diag('OBSERVED_STATE_UNKNOWN', 'warning', 'metadata-bindings', 'Component not found in an incomplete snapshot; absence is unproven.'));
  return { status: 'unknown', projection: null, completeness, diagnostics };
}

function sameRefs(a: readonly LogicalNameRef[], b: readonly LogicalNameRef[]): boolean {
  const left = sortRefs(a).map((r) => r.logicalName.toLowerCase());
  const right = sortRefs(b).map((r) => r.logicalName.toLowerCase());
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** Compares desired and observed projections; paths are logical (parameters keyed by name). */
export function diffProjection(desired: DesiredProjection, observed: ObservedFunction): PlanChange[] {
  const changes: PlanChange[] = [];
  if (observed.binding !== desired.binding) {
    changes.push({ path: '/binding', change: 'modified', impact: observed.binding === 'unknown' ? 'unknown' : 'breaking', reasonCode: 'BINDING_CHANGE_BREAKING' });
  }
  const observedByName = new Map(observed.parameters.map((p) => [p.name.toLowerCase(), p]));
  const desiredByName = new Map(desired.parameters.map((p) => [p.name.toLowerCase(), p]));
  for (const p of desired.parameters) {
    const base = `/parameters/${escapePointer(p.name)}`;
    const o = observedByName.get(p.name.toLowerCase());
    if (o === undefined) {
      changes.push({ path: base, change: 'added', impact: 'breaking', reasonCode: 'SIGNATURE_CHANGE_BREAKING' });
      continue;
    }
    if (o.name !== p.name) {
      changes.push({ path: `${base}/name`, change: 'modified', impact: 'breaking', reasonCode: 'SIGNATURE_CHANGE_BREAKING' });
    }
    if (o.type !== p.type) {
      changes.push({ path: `${base}/type`, change: 'modified', impact: 'breaking', reasonCode: 'SIGNATURE_CHANGE_BREAKING' });
    }
    if (o.direction !== p.direction) {
      changes.push({ path: `${base}/direction`, change: 'modified', impact: 'breaking', reasonCode: 'SIGNATURE_CHANGE_BREAKING' });
    }
  }
  for (const o of observed.parameters) {
    if (!desiredByName.has(o.name.toLowerCase())) {
      changes.push({ path: `/parameters/${escapePointer(o.name)}`, change: 'removed', impact: 'breaking', reasonCode: 'SIGNATURE_CHANGE_BREAKING' });
    }
  }
  const sameSet =
    desired.parameters.length === observed.parameters.length &&
    desired.parameters.every((p) => observedByName.has(p.name.toLowerCase()));
  if (sameSet && desired.parameters.some((p, i) => observed.parameters[i]!.name.toLowerCase() !== p.name.toLowerCase())) {
    changes.push({ path: '/parameters', change: 'modified', impact: 'unknown', reasonCode: 'BREAKING_CHANGE_REQUIRES_REVIEW' });
  }
  if (observed.displayName !== desired.displayName) {
    changes.push({ path: '/displayName', change: 'modified', impact: 'non-breaking', reasonCode: null });
  }
  if (observed.formula === null) {
    changes.push({ path: '/formula', change: 'modified', impact: 'unknown', reasonCode: 'OBSERVED_SOURCE_UNKNOWN' });
  } else {
    if (observed.formula.normalization !== desired.formula.normalization) {
      changes.push({ path: '/formula/sha256', change: 'modified', impact: 'unknown', reasonCode: 'SOURCE_NORMALIZATION_MISMATCH' });
    } else if (observed.formula.sha256 !== desired.formula.sha256) {
      changes.push({ path: '/formula/sha256', change: 'modified', impact: 'non-breaking', reasonCode: null });
    }
    if (observed.formula.dialect !== desired.formula.dialect) {
      changes.push({ path: '/formula/dialect', change: 'modified', impact: 'unknown', reasonCode: null });
    }
    if (observed.formula.locale !== desired.formula.locale) {
      changes.push({ path: '/formula/locale', change: 'modified', impact: 'unknown', reasonCode: null });
    }
  }
  for (const key of ['tableReferences', 'connectionReferences'] as const) {
    const o = observed[key];
    if (o === null) {
      changes.push({ path: `/${key}`, change: 'modified', impact: 'unknown', reasonCode: 'OBSERVED_STATE_UNKNOWN' });
    } else if (!sameRefs(o, desired[key])) {
      changes.push({ path: `/${key}`, change: 'modified', impact: 'unknown', reasonCode: null });
    }
  }
  if (!observed.solutions.some((s) => s.toLowerCase() === desired.solution.uniqueName.toLowerCase())) {
    changes.push({ path: '/solution/uniqueName', change: 'added', impact: 'non-breaking', reasonCode: null });
  }
  return changes.sort((a, b) => ordinalCompare(a.path, b.path) || ordinalCompare(a.change, b.change));
}

interface OperationTemplate {
  kind: PlanOperationKind;
  reasons: ReasonCode[];
  effects: OperationEffect[];
}

const CREATE_EFFECTS: OperationEffect[] = [
  'definition-created',
  'server-derived-state-recomputed',
  'solution-membership-changed',
  'may-initialize-connector-authentication',
  'may-activate-behavior',
];
// Saving can initialize authentication and activate behavior even without a test run [S11].
const SOURCE_EFFECTS: OperationEffect[] = [
  'definition-persisted',
  'server-derived-state-recomputed',
  'may-initialize-connector-authentication',
  'may-activate-behavior',
];

function operationTemplates(observed: ObservedState, changes: readonly PlanChange[]): OperationTemplate[] {
  if (observed.status === 'absent') {
    return [{ kind: 'function.create', reasons: ['NATIVE_CREATE_PROTOCOL_UNVERIFIED'], effects: CREATE_EFFECTS }];
  }
  if (observed.status !== 'present') {
    return [];
  }
  const templates: OperationTemplate[] = [];
  const pick = (predicate: (c: PlanChange) => boolean) => changes.filter(predicate);
  const signature = pick((c) => c.path === '/binding' || c.path.startsWith('/parameters'));
  if (signature.length > 0) {
    templates.push({
      kind: 'function.signature.change',
      reasons: [
        'BREAKING_CHANGE_REQUIRES_REVIEW',
        ...signature.map((c) => c.reasonCode).filter((r): r is ReasonCode => r !== null),
      ],
      effects: ['signature-changed', 'callers-may-break', 'definition-persisted', 'server-derived-state-recomputed'],
    });
  }
  const source = pick((c) => c.path.startsWith('/formula') || c.path === '/tableReferences' || c.path === '/connectionReferences');
  if (source.length > 0) {
    templates.push({
      kind: 'function.update.source',
      reasons: ['NATIVE_UPDATE_PROTOCOL_UNVERIFIED', ...source.map((c) => c.reasonCode).filter((r): r is ReasonCode => r !== null)],
      effects: SOURCE_EFFECTS,
    });
  }
  if (pick((c) => c.path === '/displayName').length > 0) {
    templates.push({ kind: 'function.update.metadata', reasons: ['NATIVE_METADATA_UPDATE_PROTOCOL_UNVERIFIED'], effects: ['metadata-persisted'] });
  }
  if (pick((c) => c.path.startsWith('/solution')).length > 0) {
    templates.push({
      kind: 'function.solution.associate',
      reasons: ['SOLUTION_ASSOCIATION_PROTOCOL_UNVERIFIED'],
      effects: ['solution-membership-changed'],
    });
  }
  return templates;
}

export function computePlanId(plan: Omit<Plan, 'planId' | 'planHash'> | Plan): string {
  // Semantic evidence only: the snapshot timestamp and the whole-snapshot hash (which covers it) are
  // excluded so a refreshed but semantically identical snapshot keeps the same planId. planHash binds them.
  const semanticEvidence = {
    specSha256: plan.evidence.specSha256,
    snapshotSource: plan.evidence.snapshotSource,
    completeness: plan.evidence.completeness,
    evidenceFingerprints: plan.evidence.evidenceFingerprints,
  };
  return hashCanonical({
    planIdVersion: PLAN_ID_VERSION,
    schemaVersion: plan.schemaVersion,
    canonicalizationVersion: plan.canonicalizationVersion,
    planner: plan.planner,
    target: plan.target,
    principal: plan.principal,
    policy: plan.policy,
    provider: plan.provider,
    capabilities: plan.capabilities,
    evidence: semanticEvidence,
    desired: plan.desired,
    observed: plan.observed,
    changes: plan.changes,
    operations: plan.operations,
    preconditions: plan.preconditions,
    verification: plan.verification,
  });
}

/** Hash of the complete immutable plan excluding only its own planHash field. */
export function computePlanHash(plan: Omit<Plan, 'planHash'> | Plan): string {
  const { planHash: _ignored, ...rest } = plan as Plan;
  return hashCanonical(rest);
}

export function buildPlan(inputs: PlanInputs): PlanOutcome {
  const { spec, snapshot, target } = inputs;
  const diagnostics: Diagnostic[] = [];

  if (snapshot !== undefined && target !== undefined) {
    const mismatch = checkIdentityMatch(target.expectedTarget, snapshot.value.target);
    if (mismatch.length > 0) {
      return { kind: 'blocked', reasonCodes: ['TARGET_IDENTITY_MISMATCH'], diagnostics: sortDiagnostics(mismatch) };
    }
  }

  diagnostics.push(...checkSpecPolicy(spec));
  if (target !== undefined) {
    diagnostics.push(...checkOwnership(spec, target));
  }

  const desired = buildDesiredState(spec);
  const observed = resolveObserved(spec.identity.uniqueName, snapshot?.value);
  diagnostics.push(...observed.diagnostics);

  const changes = observed.status === 'present' && observed.projection !== null ? diffProjection(desired.projection, observed.projection) : [];
  if (observed.status === 'present' && changes.length === 0) {
    diagnostics.push(
      diag('CONVERGENCE_UNVERIFIED', 'info', 'read-back', 'Desired state matches the snapshot projection; convergence is unverified without live read-back.'),
    );
  }
  if (observed.projection?.formula === null) {
    diagnostics.push(diag('OBSERVED_SOURCE_UNKNOWN', 'warning', 'metadata-bindings', 'Observed formula source is unknown.', '/formula'));
  }

  const ownershipReasons: ReasonCode[] = [];
  if (observed.projection !== null) {
    if (observed.projection.managedState === 'managed') {
      ownershipReasons.push('MANAGED_COMPONENT_BLOCKED');
      diagnostics.push(diag('MANAGED_COMPONENT_BLOCKED', 'error', 'policy', 'Managed components change only through verified normal ALM.'));
    } else if (observed.projection.managedState === 'unknown') {
      ownershipReasons.push('OWNERSHIP_UNKNOWN');
      diagnostics.push(diag('OWNERSHIP_UNKNOWN', 'warning', 'policy', 'Managed state is unknown; ownership is unproven.'));
    }
  }

  const claimedClass = snapshot?.value.target.environmentClass ?? null;
  const classification = assessClassification(claimedClass);
  diagnostics.push(...classification.diagnostics);

  const policyErrorCodes = diagnostics.filter((d) => d.severity === 'error' && d.phase === 'policy').map((d) => d.code);
  const templates = operationTemplates(observed, changes);
  const commonReasons: ReasonCode[] = [
    'PLAN_DRAFT_NOT_EXECUTABLE',
    'SUPPORTABILITY_UNVERIFIED',
    'CONCURRENCY_MECHANISM_UNPROVEN',
    classification.reason,
    ...ownershipReasons,
    ...policyErrorCodes,
  ];

  const preconditions: PlanPrecondition[] = [
    { id: 'authenticated-target-identity', status: 'unmet', reasonCode: 'LIVE_TRANSPORT_NOT_CONFIGURED' },
    { id: 'fresh-live-preflight', status: 'unmet', reasonCode: 'PREFLIGHT_REQUIRES_LIVE_READS' },
    { id: 'host-validation', status: 'unknown', reasonCode: 'NO_PROVEN_NON_EXECUTING_VALIDATOR' },
    { id: 'ownership-verified', status: 'unknown', reasonCode: ownershipReasons[0] ?? 'OWNERSHIP_UNKNOWN' },
    { id: 'principal-privileges', status: 'unknown', reasonCode: 'PRINCIPAL_UNRESOLVED' },
    { id: 'sandbox-classification', status: 'unmet', reasonCode: classification.reason },
    { id: 'supportability', status: 'unknown', reasonCode: 'SUPPORTABILITY_UNVERIFIED' },
  ];

  const operations: PlanOperation[] = templates.map((t, i) => {
    const id = `op-${String(i + 1).padStart(3, '0')}`;
    preconditions.push({ id: `concurrency:${id}`, status: 'unknown', reasonCode: 'CONCURRENCY_MECHANISM_UNPROVEN' });
    return {
      id,
      kind: t.kind,
      status: 'blocked',
      reasonCodes: uniqueSorted([...t.reasons, ...commonReasons]),
      effects: uniqueSorted(t.effects),
      preconditions: uniqueSorted([
        'authenticated-target-identity',
        'fresh-live-preflight',
        'host-validation',
        'ownership-verified',
        'principal-privileges',
        'sandbox-classification',
        'supportability',
        `concurrency:${id}`,
      ]),
      dependsOn: i === 0 ? [] : [`op-${String(i).padStart(3, '0')}`],
    };
  });
  preconditions.sort((a, b) => ordinalCompare(a.id, b.id));

  const expectedIdentity: TargetIdentity | null = target !== undefined ? normalizeIdentity(target.expectedTarget) : null;
  const observedIdentity: TargetIdentity | null =
    snapshot !== undefined
      ? normalizeIdentity({
          tenantId: snapshot.value.target.tenantId,
          environmentId: snapshot.value.target.environmentId,
          organizationId: snapshot.value.target.organizationId,
          organizationUrl: snapshot.value.target.organizationUrl,
        })
      : null;
  const fingerprintSource = expectedIdentity ?? observedIdentity;

  const sortedDiagnostics = sortDiagnostics(diagnostics);
  const blockingReasons = uniqueSorted<ReasonCode>([
    'PLAN_DRAFT_NOT_EXECUTABLE',
    'PLAN_NOT_APPROVAL_ELIGIBLE',
    ...operations.flatMap((o) => o.reasonCodes),
    ...preconditions.map((p) => p.reasonCode),
    ...sortedDiagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
  ]);

  const unsigned: Omit<Plan, 'planId' | 'planHash'> = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    planner: { id: PLANNER_ID, version: TOOL_VERSION },
    planState: 'draft',
    executionReadiness: 'blocked',
    approvalEligible: false,
    maxApprovalTtlSeconds: Math.min(POLICY.maxApprovalTtlSeconds, MAX_APPROVAL_TTL_SECONDS),
    target: {
      expected: expectedIdentity,
      observed: observedIdentity,
      fingerprint: fingerprintSource === null ? null : hashCanonical(fingerprintSource),
      expectedEnvironmentClass: target?.expectedEnvironmentClass ?? null,
      claimedEnvironmentClass: claimedClass,
      effectiveEnvironmentClass: 'unknown',
      classificationReason: classification.reason,
    },
    principal: { fingerprint: null, status: 'unresolved' },
    policy: { id: POLICY.id, fingerprint: POLICY_FINGERPRINT },
    provider: { id: NATIVE_PROVIDER.id, version: NATIVE_PROVIDER.version },
    capabilities: { profileId: MVP_FUNCTION_PROFILE.id, fingerprint: CAPABILITY_FINGERPRINT },
    evidence: {
      specSha256: desired.specSha256,
      snapshotSha256: snapshot?.sha256 ?? null,
      snapshotSource: snapshot?.value.source.kind ?? null,
      snapshotAcquiredAt: snapshot?.value.acquiredAt ?? null,
      completeness: observed.completeness,
      evidenceFingerprints: uniqueSorted(snapshot?.value.evidence.map((e) => e.sha256) ?? []),
    },
    desired: { sourceSha256: desired.sourceSha256, projection: desired.projection },
    observed: { status: observed.status, projection: observed.projection },
    changes,
    operations,
    preconditions,
    verification: { strategy: 'read-back', invokesFunction: false, checks: [...VERIFICATION_CHECKS], status: 'unproven' },
    blockingReasons,
    diagnostics: sortedDiagnostics,
  };
  const withId = { ...unsigned, planId: computePlanId(unsigned) };
  const plan: Plan = { ...withId, planHash: computePlanHash(withId) };
  return { kind: 'planned', plan };
}
