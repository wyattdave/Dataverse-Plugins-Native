import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APPROVAL_SCHEMA_VERSION, approvalSchema, type ApprovalEnvelope } from '../../src/contracts/approval.js';
import { validateSchema } from '../../src/contracts/schema.js';
import type { Plan } from '../../src/contracts/plan.js';
import { computeApprovalHash, verifyApproval, verifyPlanIntegrity } from '../../src/core/approval.js';
import { hashCanonical } from '../../src/core/canonical.js';
import { computePlanHash } from '../../src/core/planner.js';
import { clone, driftedSnapshot, exampleSpec, exampleTarget, planFor } from '../helpers.js';

const NOW = new Date('2026-10-15T10:00:00Z');
const PRINCIPAL = hashCanonical({ tenantId: 't', userId: 'synthetic-user' });

async function draftPlan(): Promise<Plan> {
  return planFor(await exampleSpec(), await driftedSnapshot(), await exampleTarget());
}

function envelopeFor(plan: Plan, overrides: Partial<Omit<ApprovalEnvelope, 'approvalHash'>> = {}): ApprovalEnvelope {
  const unsigned: Omit<ApprovalEnvelope, 'approvalHash'> = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    planId: plan.planId,
    planHash: plan.planHash,
    target: plan.target.expected,
    operations: plan.operations.map((o) => ({ id: o.id, kind: o.kind, effects: [...o.effects] })),
    approver: { fingerprint: hashCanonical({ approver: 'synthetic-reviewer' }) },
    principal: { fingerprint: PRINCIPAL },
    issuedAt: '2026-10-15T09:50:00Z',
    expiresAt: '2026-10-15T10:20:00Z',
    ...overrides,
  };
  return { ...unsigned, approvalHash: computeApprovalHash(unsigned) };
}

const ctx = { now: NOW, currentPrincipalFingerprint: PRINCIPAL };

describe('plan integrity (T06)', () => {
  it('accepts an untampered plan', async () => {
    assert.deepEqual(verifyPlanIntegrity(await draftPlan()), []);
  });

  it('detects semantic tampering through both planId and planHash', async () => {
    const plan = clone(await draftPlan());
    plan.operations[0]!.effects = ['metadata-persisted'];
    assert.deepEqual(verifyPlanIntegrity(plan), ['PLAN_HASH_MISMATCH', 'PLAN_ID_MISMATCH']);
  });

  it('detects non-semantic tampering through planHash only', async () => {
    const plan = clone(await draftPlan());
    plan.diagnostics = [];
    assert.deepEqual(verifyPlanIntegrity(plan), ['PLAN_HASH_MISMATCH']);
  });

  it('detects changed policy, capability, and provider fingerprints even when rehashed', async () => {
    const plan = clone(await draftPlan());
    plan.policy.fingerprint = '0'.repeat(64);
    plan.capabilities.fingerprint = '1'.repeat(64);
    plan.provider.version = '9.9.9';
    plan.planHash = computePlanHash(plan);
    const reasons = verifyPlanIntegrity(plan);
    assert.ok(reasons.includes('POLICY_FINGERPRINT_CHANGED'));
    assert.ok(reasons.includes('CAPABILITY_FINGERPRINT_CHANGED'));
    assert.ok(reasons.includes('PROVIDER_CHANGED'));
  });
});

describe('approval envelope verification (T06)', () => {
  it('a fully consistent approval still fails: Phase 1 plans are drafts and approver attestation is unverified', async () => {
    const plan = await draftPlan();
    assert.deepEqual(verifyApproval(plan, envelopeFor(plan), ctx), ['APPROVAL_ATTESTATION_UNVERIFIED', 'PLAN_NOT_APPROVAL_ELIGIBLE']);
  });

  it('requires the approved operation set to equal the plan operation set exactly', async () => {
    const plan = await draftPlan();
    assert.ok(plan.operations.length >= 2);
    const subset = envelopeFor(plan, { operations: [{ id: plan.operations[0]!.id, kind: plan.operations[0]!.kind, effects: [...plan.operations[0]!.effects] }] });
    assert.ok(verifyApproval(plan, subset, ctx).includes('APPROVAL_OPERATIONS_INCOMPLETE'));
    const first = plan.operations[0]!;
    const duplicated = envelopeFor(plan, {
      operations: [...plan.operations.map((o) => ({ id: o.id, kind: o.kind, effects: [...o.effects] })), { id: first.id, kind: first.kind, effects: [...first.effects] }],
    });
    assert.ok(verifyApproval(plan, duplicated, ctx).includes('APPROVAL_OPERATION_NOT_IN_PLAN'));
    assert.ok(validateSchema(duplicated, approvalSchema).some((d) => d.code === 'AMBIGUOUS_IDENTIFIER'));
  });

  it('detects tampering with the approval after hashing', async () => {
    const plan = await draftPlan();
    const approval = envelopeFor(plan);
    approval.expiresAt = '2026-10-15T23:00:00Z';
    assert.ok(verifyApproval(plan, approval, ctx).includes('APPROVAL_HASH_MISMATCH'));
  });

  it('binds the exact planHash and target', async () => {
    const plan = await draftPlan();
    assert.ok(verifyApproval(plan, envelopeFor(plan, { planHash: 'f'.repeat(64) }), ctx).includes('APPROVAL_PLAN_MISMATCH'));
    const otherTarget = { ...plan.target.expected!, environmentId: '00000000-0000-4000-8000-000000000099' };
    assert.ok(verifyApproval(plan, envelopeFor(plan, { target: otherTarget }), ctx).includes('APPROVAL_TARGET_MISMATCH'));
  });

  it('binds operation identities and effects', async () => {
    const plan = await draftPlan();
    const extra = envelopeFor(plan, { operations: [{ id: 'op-009', kind: 'function.create', effects: [] }] });
    assert.ok(verifyApproval(plan, extra, ctx).includes('APPROVAL_OPERATION_NOT_IN_PLAN'));
    const fewerEffects = envelopeFor(plan, { operations: [{ id: 'op-001', kind: 'function.update.source', effects: ['definition-persisted'] }] });
    assert.ok(verifyApproval(plan, fewerEffects, ctx).includes('APPROVAL_EFFECTS_MISMATCH'));
  });

  it('enforces issuance, expiry, and the 30-minute TTL policy', async () => {
    const plan = await draftPlan();
    assert.ok(
      verifyApproval(plan, envelopeFor(plan, { issuedAt: '2026-10-15T09:00:00Z', expiresAt: '2026-10-15T09:20:00Z' }), ctx).includes('APPROVAL_EXPIRED'),
    );
    assert.ok(
      verifyApproval(plan, envelopeFor(plan, { issuedAt: '2026-10-15T10:05:00Z', expiresAt: '2026-10-15T10:20:00Z' }), ctx).includes(
        'APPROVAL_NOT_YET_VALID',
      ),
    );
    assert.ok(
      verifyApproval(plan, envelopeFor(plan, { issuedAt: '2026-10-15T09:50:00Z', expiresAt: '2026-10-15T10:21:00Z' }), ctx).includes(
        'APPROVAL_TTL_EXCEEDS_POLICY',
      ),
    );
  });

  it('requires the same resolved principal', async () => {
    const plan = await draftPlan();
    assert.ok(verifyApproval(plan, envelopeFor(plan), { now: NOW, currentPrincipalFingerprint: 'a'.repeat(64) }).includes('APPROVAL_PRINCIPAL_MISMATCH'));
    assert.ok(verifyApproval(plan, envelopeFor(plan), { now: NOW, currentPrincipalFingerprint: null }).includes('PRINCIPAL_UNRESOLVED'));
  });
});
