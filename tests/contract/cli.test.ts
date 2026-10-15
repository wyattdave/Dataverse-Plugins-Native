import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { APPROVAL_SCHEMA_VERSION } from '../../src/contracts/approval.js';
import { validateSchema } from '../../src/contracts/schema.js';
import { JOURNAL_SCHEMA_VERSION } from '../../src/contracts/journal.js';
import type { Plan } from '../../src/contracts/plan.js';
import { resultSchema, type CommandResult } from '../../src/contracts/result.js';
import { computeApprovalHash } from '../../src/core/approval.js';
import { hashCanonical } from '../../src/core/canonical.js';
import { writeJournal } from '../../src/core/journalStore.js';
import { runCli } from '../../src/cli/run.js';
import { TOOL_VERSION } from '../../src/version.js';
import { cli, clone, convergedSnapshot, driftedSnapshot, examplePath, exampleSpec, ROOT, tempDir, writeJson } from '../helpers.js';

const SPEC = examplePath('calculation.spec.json');
const TARGET = examplePath('synthetic.target.json');
const DRIFTED = examplePath('drifted.snapshot.json');
const CONVERGED = examplePath('converged.snapshot.json');

function assertValidResult(result: CommandResult | undefined): CommandResult {
  assert.ok(result);
  assert.deepEqual(validateSchema(result, resultSchema), []);
  assert.equal(result.executionReadiness, 'blocked');
  return result;
}

describe('CLI contract', () => {
  it('validate --offline succeeds for the offline scope while host validation stays unknown', async () => {
    const run = await cli(['validate', '--spec', SPEC, '--offline', '--json']);
    const result = assertValidResult(run.result);
    assert.equal(run.code, 0);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(
      result.validation.map((v) => [v.phase, v.status]),
      [
        ['schema', 'passed'],
        ['policy', 'passed'],
        ['metadata-bindings', 'skipped'],
        ['host', 'unknown'],
      ],
    );
  });

  it('validate without --offline requests live metadata and is blocked', async () => {
    const run = await cli(['validate', '--spec', SPEC, '--json']);
    assert.equal(run.code, 2);
    assert.ok(assertValidResult(run.result).reasonCodes.includes('LIVE_TRANSPORT_NOT_CONFIGURED'));
  });

  it('validate with the placeholder template fails as invalid input', async () => {
    const run = await cli(['validate', '--spec', SPEC, '--target', examplePath('target.template.json'), '--offline', '--json']);
    assert.equal(run.code, 3);
    assert.ok(assertValidResult(run.result).reasonCodes.includes('TARGET_PLACEHOLDER_UNRESOLVED'));
  });

  it('plan is reproducible, writes a new private file, and refuses to overwrite it', async () => {
    const dir = await tempDir();
    const out = join(dir, 'plan.json');
    const first = await cli(['plan', '--spec', SPEC, '--snapshot', DRIFTED, '--target', TARGET, '--out', out, '--json']);
    const second = await cli(['plan', '--spec', SPEC, '--snapshot', DRIFTED, '--target', TARGET, '--json'], new Date('2027-01-01T00:00:00Z'));
    assert.equal(first.code, 0);
    const r1 = assertValidResult(first.result);
    const r2 = assertValidResult(second.result);
    assert.equal(r1.planId, r2.planId);
    assert.equal(r1.planHash, r2.planHash);
    assert.notEqual(r1.runId, r2.runId);
    const written = JSON.parse(await readFile(out, 'utf8')) as Plan;
    assert.equal(written.planHash, r1.planHash);
    assert.ok(r1.operations.every((o) => o.status === 'blocked' && !o.dispatched));

    const again = await cli(['plan', '--spec', SPEC, '--out', out, '--json']);
    assert.equal(again.code, 3);
    assert.deepEqual(assertValidResult(again.result).reasonCodes, ['OUTPUT_FILE_EXISTS']);
  });

  it('never prints formula source to stdout or stderr', async () => {
    const dir = await tempDir();
    const spec = await exampleSpec();
    spec.formula.text = 'FORMULA_BODY_MARKER * Rate';
    const specPath = await writeJson(dir, 'spec.json', spec);
    for (const argv of [
      ['plan', '--spec', specPath, '--snapshot', DRIFTED, '--json'],
      ['validate', '--spec', specPath, '--offline'],
      ['verify', '--spec', specPath, '--snapshot', DRIFTED, '--json'],
    ]) {
      const run = await cli(argv);
      assert.equal(run.stdout.includes('FORMULA_BODY_MARKER'), false);
      assert.equal(run.stderr.includes('FORMULA_BODY_MARKER'), false);
    }
  });

  it('apply is always blocked and dispatches nothing, with or without approval', async () => {
    const dir = await tempDir();
    const planPath = join(dir, 'plan.json');
    await cli(['plan', '--spec', SPEC, '--snapshot', DRIFTED, '--target', TARGET, '--out', planPath]);
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;

    const noApproval = await cli(['apply', '--plan', planPath, '--json']);
    assert.equal(noApproval.code, 2);
    const r = assertValidResult(noApproval.result);
    assert.ok(r.reasonCodes.includes('APPROVAL_MISSING'));
    assert.ok(r.operations.length > 0 && r.operations.every((o) => o.status === 'blocked' && o.dispatched === false));

    const unsigned = {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      planId: plan.planId,
      planHash: plan.planHash,
      target: plan.target.expected,
      operations: plan.operations.map((o) => ({ id: o.id, kind: o.kind, effects: o.effects })),
      approver: { fingerprint: hashCanonical({ approver: 'synthetic' }) },
      principal: { fingerprint: hashCanonical({ principal: 'synthetic' }) },
      issuedAt: '2026-10-15T09:55:00Z',
      expiresAt: '2026-10-15T10:20:00Z',
    };
    const approvalPath = await writeJson(dir, 'approval.json', { ...unsigned, approvalHash: computeApprovalHash(unsigned as never) });
    const withApproval = await cli(['apply', '--plan', planPath, '--approval', approvalPath, '--json']);
    assert.equal(withApproval.code, 2);
    const ra = assertValidResult(withApproval.result);
    assert.ok(ra.reasonCodes.includes('PLAN_NOT_APPROVAL_ELIGIBLE'));
    assert.equal(ra.reasonCodes.includes('APPROVAL_HASH_MISMATCH'), false);
  });

  it('apply detects a tampered plan before anything else', async () => {
    const dir = await tempDir();
    const planPath = join(dir, 'plan.json');
    await cli(['plan', '--spec', SPEC, '--snapshot', DRIFTED, '--out', planPath]);
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as Plan;
    const tampered = clone(plan);
    tampered.operations[0]!.effects = ['metadata-persisted'];
    const tamperedPath = await writeJson(dir, 'tampered.json', tampered);
    const run = await cli(['apply', '--plan', tamperedPath, '--json']);
    assert.equal(run.code, 2);
    const r = assertValidResult(run.result);
    assert.ok(r.reasonCodes.includes('PLAN_HASH_MISMATCH'));
    assert.ok(r.reasonCodes.includes('PLAN_ID_MISMATCH'));
    assert.deepEqual(r.validation.find((v) => v.phase === 'integrity')?.status, 'failed');
  });

  it('apply rejects a plan that is not a strict adapter.plan/v1 document', async () => {
    const dir = await tempDir();
    const plan = JSON.parse(await readFile(examplePath('calculation.spec.json'), 'utf8'));
    const run = await cli(['apply', '--plan', await writeJson(dir, 'p.json', plan), '--json']);
    assert.equal(run.code, 3);
    assert.deepEqual(assertValidResult(run.result).reasonCodes, ['SCHEMA_VERSION_UNSUPPORTED']);
  });

  it('approve refuses draft plans', async () => {
    const dir = await tempDir();
    const planPath = join(dir, 'plan.json');
    await cli(['plan', '--spec', SPEC, '--out', planPath]);
    const run = await cli(['approve', '--plan', planPath, '--json']);
    assert.equal(run.code, 2);
    assert.ok(assertValidResult(run.result).reasonCodes.includes('PLAN_NOT_APPROVAL_ELIGIBLE'));
  });

  it('rejects unknown, duplicate, missing, and positional arguments; there is no force/override', async () => {
    const cases: [string[], string][] = [
      [['apply', '--plan', 'x.json', '--force', '--json'], 'CLI_UNKNOWN_OPTION'],
      [['apply', '--plan', 'x.json', '--allow-production', '--json'], 'CLI_UNKNOWN_OPTION'],
      [['plan', '--spec', 'a', '--spec', 'b', '--json'], 'CLI_DUPLICATE_OPTION'],
      [['plan', '--json'], 'CLI_MISSING_OPTION'],
      [['plan', '--spec', '--json'], 'CLI_OPTION_VALUE_MISSING'],
      [['plan', 'spec.json', '--json'], 'CLI_UNEXPECTED_ARGUMENT'],
      [['publish', '--json'], 'CLI_UNKNOWN_COMMAND'],
      [['package', 'publish', '--json'], 'CLI_UNKNOWN_COMMAND'],
      [['inspect', '--json'], 'CLI_MODE_REQUIRED'],
      [['validate', '--spec', SPEC, '--offline=yes', '--json'], 'CLI_UNEXPECTED_ARGUMENT'],
    ];
    for (const [argv, code] of cases) {
      const run = await cli(argv);
      assert.equal(run.code, 3, argv.join(' '));
      assert.deepEqual(assertValidResult(run.result).reasonCodes, [code], argv.join(' '));
    }
    const uiCases: [string[], string][] = [
      [['ui', '--port', '99999'], 'CLI_OPTION_VALUE_INVALID'],
      [['ui', '--port', 'abc'], 'CLI_OPTION_VALUE_INVALID'],
      [['ui', '--port', '-1'], 'CLI_OPTION_VALUE_INVALID'],
      [['ui', '--host', '0.0.0.0'], 'CLI_UNKNOWN_OPTION'],
      [['ui', '--json'], 'CLI_UNKNOWN_OPTION'],
    ];
    for (const [argv, code] of uiCases) {
      const run = await cli(argv);
      assert.equal(run.code, 3, argv.join(' '));
      assert.ok(run.stdout.includes(code), argv.join(' '));
    }
  });

  it('mutation and invocation stubs are explicitly blocked', async () => {
    const expected: [string[], string[]][] = [
      [['test'], ['INVOCATION_REQUIRES_SEPARATE_TEST_GATE']],
      [['package', 'export'], ['PACKAGE_EXPORT_NOT_ENABLED']],
      [['package', 'import'], ['PACKAGE_IMPORT_NOT_ENABLED']],
      [['recover'], ['RECOVERY_PROTOCOL_UNVERIFIED']],
      [['retire'], ['DEACTIVATION_PROFILE_UNVERIFIED', 'GENERIC_DELETE_DISABLED']],
    ];
    for (const [argv, codes] of expected) {
      const run = await cli([...argv, '--json']);
      assert.equal(run.code, 2);
      const r = assertValidResult(run.result);
      assert.equal(r.status, 'blocked');
      assert.deepEqual(r.reasonCodes, codes);
    }
  });

  it('inspect: live target inspection is blocked; snapshot inspection is offline-only', async () => {
    const live = await cli(['inspect', '--target', TARGET, '--json']);
    assert.equal(live.code, 2);
    assert.deepEqual(assertValidResult(live.result).reasonCodes, ['LIVE_TRANSPORT_NOT_CONFIGURED']);

    const offline = await cli(['inspect', '--snapshot', CONVERGED, '--target', TARGET, '--json']);
    assert.equal(offline.code, 0);
    const r = assertValidResult(offline.result);
    assert.ok(r.reasonCodes.includes('OFFLINE_SCOPE_ONLY'));
    assert.ok(r.reasonCodes.includes('OFFLINE_CLASSIFICATION_NOT_TRUSTED'));
    assert.equal(r.target.effectiveEnvironmentClass, 'unknown');

    const dir = await tempDir();
    const other = await convergedSnapshot();
    other.target.tenantId = '00000000-0000-4000-8000-000000000099';
    const mismatch = await cli(['inspect', '--snapshot', await writeJson(dir, 's.json', other), '--target', TARGET, '--json']);
    assert.equal(mismatch.code, 2);
    assert.deepEqual(assertValidResult(mismatch.result).reasonCodes, ['TARGET_IDENTITY_MISMATCH']);
  });

  it('verify never succeeds without live read-back', async () => {
    const run = await cli(['verify', '--spec', SPEC, '--snapshot', CONVERGED, '--json']);
    assert.equal(run.code, 2);
    const r = assertValidResult(run.result);
    assert.ok(r.reasonCodes.includes('READ_BACK_REQUIRES_LIVE_READS'));
    assert.equal(r.validation.find((v) => v.phase === 'read-back')?.status, 'unknown');
  });

  it('production snapshots are hard-blocked in plans', async () => {
    const dir = await tempDir();
    const production = await driftedSnapshot();
    production.target.environmentClass = 'production';
    const run = await cli(['plan', '--spec', SPEC, '--snapshot', await writeJson(dir, 's.json', production), '--json']);
    assert.equal(run.code, 0);
    assert.ok(assertValidResult(run.result).reasonCodes.includes('PRODUCTION_WRITE_BLOCKED'));
  });

  it('reconcile reports outcome_unknown for an interrupted dispatch', async () => {
    const dir = await tempDir();
    const path = join(dir, 'run.journal.json');
    const base = { requestSha256: null, recordIds: [], concurrencyToken: null, recordedAt: '2026-10-15T10:00:00Z' };
    await writeJournal(path, {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: '00000000-0000-4000-8000-0000000000f1',
      target: {
        tenantId: '00000000-0000-4000-8000-000000000001',
        environmentId: '00000000-0000-4000-8000-000000000002',
        organizationId: '00000000-0000-4000-8000-000000000003',
      },
      planHash: 'a'.repeat(64),
      entries: [
        { ...base, sequence: 1, operationId: 'op-001', state: 'prepared' },
        { ...base, sequence: 2, operationId: 'op-001', state: 'dispatching' },
      ],
    });
    const run = await cli(['reconcile', '--journal', path, '--snapshot', CONVERGED, '--json']);
    assert.equal(run.code, 5);
    const r = assertValidResult(run.result);
    assert.equal(r.status, 'outcome_unknown');
    assert.equal(r.journalReference, 'journal:00000000-0000-4000-8000-0000000000f1');
  });

  it('help and version exit 0, and the version matches package.json', async () => {
    assert.equal((await cli(['--help'])).code, 0);
    const version = await cli(['--version']);
    assert.equal(version.stdout.trim(), `dv-native ${TOOL_VERSION}`);
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    assert.equal(pkg.version, TOOL_VERSION);
  });

  it('ui starts on 127.0.0.1, prints a session link, and stops cleanly', async () => {
    let stdout = '';
    const code = await runCli(['ui', '--port', '0'], {
      stdout: (t) => (stdout += t),
      stderr: () => undefined,
      now: () => new Date('2026-10-15T10:00:00Z'),
      waitForShutdown: () => new Promise((resolve) => setTimeout(resolve, 50)),
    });
    assert.equal(code, 0);
    assert.match(stdout, /UI running at http:\/\/127\.0\.0\.1:\d+\/\?session=[0-9a-f]{64}/);
    assert.match(stdout, /UI stopped/);
  });

  it('the real process emits exactly one JSON object on stdout and the stable exit code', () => {
    const run = spawnSync(process.execPath, [join(ROOT, 'dist', 'src', 'cli', 'main.js'), 'retire', '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    const parsed = JSON.parse(run.stdout) as CommandResult;
    assert.equal(parsed.status, 'blocked');
    assert.ok(run.stderr.split('\n').filter(Boolean).every((line) => JSON.parse(line).level !== undefined));
  });
});
