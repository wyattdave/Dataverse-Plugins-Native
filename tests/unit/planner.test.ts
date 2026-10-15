import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PLAN_SCHEMA_VERSION, planSchema } from '../../src/contracts/plan.js';
import { buildPlan } from '../../src/core/planner.js';
import { parseDocument } from '../../src/core/documents.js';
import { hashCanonical } from '../../src/core/canonical.js';
import { verifyAgainstSnapshot } from '../../src/core/verifier.js';
import { clone, convergedSnapshot, driftedSnapshot, exampleSpec, exampleTarget, planFor } from '../helpers.js';

describe('deterministic planning (G1, T03)', () => {
  it('produces a reproducible draft, blocked, non-approvable plan', async () => {
    const [spec, snapshot, target] = [await exampleSpec(), await driftedSnapshot(), await exampleTarget()];
    const a = planFor(spec, snapshot, target);
    const b = planFor(clone(spec), clone(snapshot), clone(target));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.planState, 'draft');
    assert.equal(a.executionReadiness, 'blocked');
    assert.equal(a.approvalEligible, false);
    assert.equal(a.maxApprovalTtlSeconds, 1800);
    assert.ok(a.blockingReasons.includes('PLAN_DRAFT_NOT_EXECUTABLE'));
    assert.ok(a.blockingReasons.includes('PLAN_NOT_APPROVAL_ELIGIBLE'));
  });

  it('keeps planId stable across a refreshed but semantically identical snapshot; planHash still changes', async () => {
    const spec = await exampleSpec();
    const earlier = await driftedSnapshot();
    const later = clone(earlier);
    later.acquiredAt = '2026-10-15T09:45:00Z';
    const a = planFor(spec, earlier);
    const b = planFor(spec, later);
    assert.equal(a.planId, b.planId);
    assert.notEqual(a.planHash, b.planHash);
    const drift = clone(later);
    drift.components[0]!.formula!.sha256 = 'e'.repeat(64);
    assert.notEqual(planFor(spec, drift).planId, a.planId);
  });

  it('round-trips through JSON and validates against the strict plan schema', async () => {
    const plan = planFor(await exampleSpec(), await driftedSnapshot(), await exampleTarget());
    const parsed = parseDocument(JSON.stringify(plan, null, 2), planSchema, PLAN_SCHEMA_VERSION, 'plan');
    assert.deepEqual(parsed.diagnostics, []);
  });

  it('gives equivalent specs the same planId and different sources different planIds', async () => {
    const spec = await exampleSpec();
    const crlf = clone(spec);
    crlf.formula.text = 'Amount * Rate\r\n';
    const lf = clone(spec);
    lf.formula.text = 'Amount * Rate\n';
    assert.equal(planFor(crlf).planId, planFor(lf).planId);
    const changed = clone(spec);
    changed.formula.text = 'Amount * Rate ';
    assert.notEqual(planFor(spec).planId, planFor(changed).planId);
  });

  it('never embeds formula source text in plans', async () => {
    const spec = await exampleSpec();
    spec.formula.text = 'SECRET_FORMULA_MARKER * Rate';
    const plan = planFor(spec, await driftedSnapshot());
    assert.equal(JSON.stringify(plan).includes('SECRET_FORMULA_MARKER'), false);
  });

  it('reports unknown observed state without a snapshot and plans no operations', async () => {
    const plan = planFor(await exampleSpec());
    assert.equal(plan.observed.status, 'unknown');
    assert.deepEqual(plan.operations, []);
    assert.equal(plan.evidence.completeness, 'unknown');
    assert.ok(plan.diagnostics.some((d) => d.code === 'SNAPSHOT_NOT_PROVIDED'));
    assert.ok(plan.preconditions.some((p) => p.id === 'host-validation' && p.reasonCode === 'NO_PROVEN_NON_EXECUTING_VALIDATOR'));
  });

  it('plans a blocked create only when a complete, in-scope snapshot shows absence', async () => {
    const snapshot = await convergedSnapshot();
    snapshot.components = [];
    const plan = planFor(await exampleSpec(), snapshot);
    assert.equal(plan.observed.status, 'absent');
    assert.deepEqual(
      plan.operations.map((o) => o.kind),
      ['function.create'],
    );
    assert.ok(plan.operations[0]!.reasonCodes.includes('NATIVE_CREATE_PROTOCOL_UNVERIFIED'));
    assert.equal(plan.operations[0]!.status, 'blocked');
  });

  it('never infers create from an incomplete or out-of-scope snapshot (T03)', async () => {
    const partial = await convergedSnapshot();
    partial.components = [];
    partial.completeness = { status: 'partial', gaps: [{ code: 'TRANSPORT_PAGE_LIMIT_REACHED', detail: 'Pagination stopped.' }] };
    const p1 = planFor(await exampleSpec(), partial);
    assert.equal(p1.observed.status, 'unknown');
    assert.deepEqual(p1.operations, []);
    assert.equal(p1.evidence.completeness, 'partial');

    const outOfScope = await convergedSnapshot();
    outOfScope.scope.uniqueNames = ['sample_Other'];
    outOfScope.components = [];
    const p2 = planFor(await exampleSpec(), outOfScope);
    assert.equal(p2.observed.status, 'unknown');
    assert.ok(p2.diagnostics.some((d) => d.code === 'SNAPSHOT_SCOPE_MISMATCH'));
  });

  it('blocks on duplicate or case-variant identities', async () => {
    const snapshot = await convergedSnapshot();
    const twin = clone(snapshot.components[0]!);
    twin.uniqueName = 'sample_calculatefee';
    snapshot.components.push(twin);
    const plan = planFor(await exampleSpec(), snapshot);
    assert.equal(plan.observed.status, 'ambiguous');
    assert.deepEqual(plan.operations, []);
    assert.ok(plan.blockingReasons.includes('SNAPSHOT_AMBIGUOUS_IDENTITY'));
  });

  it('plans a no-op for converged state but marks convergence unverified', async () => {
    const plan = planFor(await exampleSpec(), await convergedSnapshot(), await exampleTarget());
    assert.equal(plan.observed.status, 'present');
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.operations, []);
    assert.ok(plan.diagnostics.some((d) => d.code === 'CONVERGENCE_UNVERIFIED'));
  });

  it('plans blocked source and metadata updates for drift and discloses save side effects', async () => {
    const plan = planFor(await exampleSpec(), await driftedSnapshot(), await exampleTarget());
    assert.deepEqual(
      plan.changes.map((c) => [c.path, c.impact]),
      [
        ['/displayName', 'non-breaking'],
        ['/formula/sha256', 'non-breaking'],
      ],
    );
    assert.deepEqual(
      plan.operations.map((o) => [o.id, o.kind, o.dependsOn]),
      [
        ['op-001', 'function.update.source', []],
        ['op-002', 'function.update.metadata', ['op-001']],
      ],
    );
    const source = plan.operations[0]!;
    assert.ok(source.effects.includes('may-initialize-connector-authentication'));
    assert.ok(source.effects.includes('server-derived-state-recomputed'));
    assert.ok(source.reasonCodes.includes('NATIVE_UPDATE_PROTOCOL_UNVERIFIED'));
    assert.ok(source.reasonCodes.includes('CONCURRENCY_MECHANISM_UNPROVEN'));
    assert.ok(source.reasonCodes.includes('OFFLINE_CLASSIFICATION_NOT_TRUSTED'));
  });

  it('classifies signature and binding changes as breaking and never as delete/recreate', async () => {
    const snapshot = await driftedSnapshot();
    snapshot.components[0]!.parameters[0]!.type = 'Float';
    snapshot.components[0]!.parameters.push({ name: 'Legacy', direction: 'input', type: 'Decimal' });
    snapshot.components[0]!.binding = 'bound';
    const plan = planFor(await exampleSpec(), snapshot);
    const signature = plan.operations.find((o) => o.kind === 'function.signature.change');
    assert.ok(signature);
    assert.ok(signature.reasonCodes.includes('BREAKING_CHANGE_REQUIRES_REVIEW'));
    assert.ok(signature.reasonCodes.includes('SIGNATURE_CHANGE_BREAKING'));
    assert.ok(signature.reasonCodes.includes('BINDING_CHANGE_BREAKING'));
    assert.ok(signature.effects.includes('callers-may-break'));
    assert.ok(plan.changes.some((c) => c.path === '/parameters/Legacy' && c.change === 'removed' && c.impact === 'breaking'));
    assert.equal(plan.operations.some((o) => (o.kind as string).includes('delete')), false);
  });

  it('flags parameter reordering for review with unknown impact', async () => {
    const snapshot = await convergedSnapshot();
    snapshot.components[0]!.parameters.reverse();
    const plan = planFor(await exampleSpec(), snapshot);
    assert.ok(plan.changes.some((c) => c.path === '/parameters' && c.impact === 'unknown'));
  });

  it('treats normalization mismatches and unknown observed source as unknown, not equal', async () => {
    const snapshot = await convergedSnapshot();
    snapshot.components[0]!.formula!.normalization = 'none';
    const p1 = planFor(await exampleSpec(), snapshot);
    assert.ok(p1.changes.some((c) => c.reasonCode === 'SOURCE_NORMALIZATION_MISMATCH' && c.impact === 'unknown'));

    const unknownSource = await convergedSnapshot();
    unknownSource.components[0]!.formula = null;
    const p2 = planFor(await exampleSpec(), unknownSource);
    assert.ok(p2.operations.some((o) => o.kind === 'function.update.source' && o.reasonCodes.includes('OBSERVED_SOURCE_UNKNOWN')));
  });

  it('blocks managed components and production claims', async () => {
    const managed = await driftedSnapshot();
    managed.components[0]!.managedState = 'managed';
    const p1 = planFor(await exampleSpec(), managed);
    assert.ok(p1.operations.every((o) => o.reasonCodes.includes('MANAGED_COMPONENT_BLOCKED')));

    const production = await driftedSnapshot();
    production.target.environmentClass = 'production';
    const p2 = planFor(await exampleSpec(), production);
    assert.ok(p2.blockingReasons.includes('PRODUCTION_WRITE_BLOCKED'));
    assert.ok(p2.operations.every((o) => o.reasonCodes.includes('PRODUCTION_WRITE_BLOCKED')));
    assert.equal(p2.target.effectiveEnvironmentClass, 'unknown');
  });

  it('refuses to plan when the snapshot identity differs from the expected target', async () => {
    const snapshot = await convergedSnapshot();
    snapshot.target.organizationId = '00000000-0000-4000-8000-000000000099';
    const outcome = buildPlan({ spec: await exampleSpec(), snapshot: { value: snapshot, sha256: hashCanonical(snapshot) }, target: await exampleTarget() });
    assert.equal(outcome.kind, 'blocked');
  });

  it('records ownership mismatches as policy blockers', async () => {
    const target = await exampleTarget();
    target.ownership.solutionUniqueName = 'sample_Other';
    const plan = planFor(await exampleSpec(), await driftedSnapshot(), target);
    assert.ok(plan.blockingReasons.includes('OWNERSHIP_MISMATCH'));
    assert.ok(plan.operations.every((o) => o.reasonCodes.includes('OWNERSHIP_MISMATCH')));
  });
});

describe('verification against snapshots (T03)', () => {
  it('reports matches but keeps registration/dependency read-back unknown', async () => {
    const report = verifyAgainstSnapshot(await exampleSpec(), await convergedSnapshot());
    const byCheck = Object.fromEntries(report.checks.map((c) => [c.check, c.observation]));
    assert.equal(byCheck['source-sha256'], 'matches');
    assert.equal(byCheck['registration'], 'unknown');
    assert.equal(byCheck['dependencies'], 'unknown');
    assert.ok(report.diagnostics.some((d) => d.code === 'READ_BACK_REQUIRES_LIVE_READS'));
  });

  it('reports differences and unknowns without claiming success', async () => {
    const drift = verifyAgainstSnapshot(await exampleSpec(), await driftedSnapshot());
    assert.equal(drift.checks.find((c) => c.check === 'source-sha256')!.observation, 'differs');
    const none = verifyAgainstSnapshot(await exampleSpec(), undefined);
    assert.ok(none.checks.every((c) => c.observation === 'unknown'));
  });
});
