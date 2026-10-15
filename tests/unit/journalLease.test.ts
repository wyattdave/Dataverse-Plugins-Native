import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { JOURNAL_SCHEMA_VERSION, type Journal, type JournalEntry } from '../../src/contracts/journal.js';
import { appendJournalEntry, readJournal, writeJournal } from '../../src/core/journalStore.js';
import { acquireLease, recoverStaleLease, releaseLease } from '../../src/core/lease.js';
import { computeEntriesSha256, reconcileJournal } from '../../src/core/reconcile.js';
import { convergedSnapshot, tempDir } from '../helpers.js';

const RUN = '00000000-0000-4000-8000-0000000000f1';
const TARGET = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  environmentId: '00000000-0000-4000-8000-000000000002',
  organizationId: '00000000-0000-4000-8000-000000000003',
};

function entry(sequence: number, operationId: string, state: JournalEntry['state'], recordIds: string[] = []): JournalEntry {
  return { sequence, operationId, state, requestSha256: null, recordIds, concurrencyToken: null, recordedAt: '2026-10-15T10:00:00Z' };
}

function journal(entries: JournalEntry[]): Journal {
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, runId: RUN, target: TARGET, planHash: 'a'.repeat(64), entries, entriesSha256: computeEntriesSha256(entries) };
}

describe('journal store (T06, T10)', () => {
  it('round-trips through atomic writes and appends valid transitions', async () => {
    const path = join(await tempDir(), 'run.journal.json');
    await writeJournal(path, { schemaVersion: JOURNAL_SCHEMA_VERSION, runId: RUN, target: TARGET, planHash: 'a'.repeat(64), entries: [] });
    const base = { requestSha256: null, recordIds: [], concurrencyToken: null, recordedAt: '2026-10-15T10:00:00Z' };
    await appendJournalEntry(path, { ...base, operationId: 'op-001', state: 'prepared' });
    await appendJournalEntry(path, { ...base, operationId: 'op-001', state: 'dispatching' });
    const read = await readJournal(path);
    assert.deepEqual(read.diagnostics, []);
    assert.equal(read.journal!.entries.length, 2);
  });

  it('refuses invalid transitions instead of writing them', async () => {
    const path = join(await tempDir(), 'run.journal.json');
    await writeJournal(path, { schemaVersion: JOURNAL_SCHEMA_VERSION, runId: RUN, target: TARGET, planHash: 'a'.repeat(64), entries: [] });
    await assert.rejects(
      appendJournalEntry(path, { operationId: 'op-001', state: 'completed', requestSha256: null, recordIds: [], concurrencyToken: null, recordedAt: '2026-10-15T10:00:00Z' }),
      /JOURNAL_SEQUENCE_INVALID/,
    );
  });

  it('detects corrupted or tampered journals and refuses continuation', async () => {
    const path = join(await tempDir(), 'run.journal.json');
    await writeJournal(path, { schemaVersion: JOURNAL_SCHEMA_VERSION, runId: RUN, target: TARGET, planHash: 'a'.repeat(64), entries: [entry(1, 'op-001', 'prepared')] });
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('"prepared"', '"dispatching"'));
    const tampered = await readJournal(path);
    assert.equal(tampered.journal, undefined);
    assert.ok(tampered.diagnostics.some((d) => d.code === 'JOURNAL_CORRUPT'));
    await assert.rejects(
      appendJournalEntry(path, { operationId: 'op-001', state: 'dispatching', requestSha256: null, recordIds: [], concurrencyToken: null, recordedAt: '2026-10-15T10:00:00Z' }),
      /JOURNAL_CORRUPT/,
    );
    await writeFile(path, text.slice(0, text.length / 2));
    assert.ok((await readJournal(path)).diagnostics.some((d) => d.code === 'JOURNAL_CORRUPT'));
  });
});

describe('reconciliation (T06, T10)', () => {
  it('treats a dispatched operation without a result as outcome_unknown, even if records are observed', async () => {
    const snapshot = await convergedSnapshot();
    const report = reconcileJournal(
      journal([entry(1, 'op-001', 'prepared'), entry(2, 'op-001', 'dispatching', ['00000000-0000-4000-8000-0000000000a2'])]),
      snapshot,
    );
    assert.equal(report.status, 'outcome_unknown');
    assert.equal(report.operations[0]!.snapshotFinding, 'records-observed-ownership-unproven');
    assert.equal(report.operations[0]!.dispatched, true);
  });

  it('never converts "not observed" into permission to recreate', async () => {
    const report = reconcileJournal(
      journal([
        entry(1, 'op-001', 'prepared'),
        entry(2, 'op-001', 'dispatching'),
        entry(3, 'op-001', 'outcome-unknown', ['00000000-0000-4000-8000-0000000000ff']),
      ]),
      await convergedSnapshot(),
    );
    assert.equal(report.status, 'outcome_unknown');
    assert.equal(report.operations[0]!.snapshotFinding, 'records-not-observed');
  });

  it('reports partial, failed, and succeeded outcomes with precedence', () => {
    const partial = reconcileJournal(
      journal([entry(1, 'op-001', 'prepared'), entry(2, 'op-001', 'dispatching'), entry(3, 'op-001', 'completed'), entry(4, 'op-002', 'prepared')]),
    );
    assert.equal(partial.status, 'partial');
    const failed = reconcileJournal(journal([entry(1, 'op-001', 'prepared'), entry(2, 'op-001', 'dispatching'), entry(3, 'op-001', 'failed-definite')]));
    assert.equal(failed.status, 'failed');
    const done = reconcileJournal(journal([entry(1, 'op-001', 'prepared'), entry(2, 'op-001', 'dispatching'), entry(3, 'op-001', 'completed')]));
    assert.equal(done.status, 'blocked', 'journal state alone never proves success');
    assert.ok(done.reasonCodes.includes('READ_BACK_REQUIRES_LIVE_READS'));
    assert.equal(reconcileJournal(journal([])).status, 'succeeded');
  });

  it('rejects sequence gaps, invalid transitions, and target mismatches', async () => {
    assert.equal(reconcileJournal(journal([entry(2, 'op-001', 'prepared')])).status, 'failed');
    assert.equal(reconcileJournal(journal([entry(1, 'op-001', 'completed')])).status, 'failed');
    assert.deepEqual(
      reconcileJournal(journal([entry(1, 'op-001', 'prepared'), entry(2, 'op-001', 'outcome-unknown')])).reasonCodes,
      ['JOURNAL_SEQUENCE_INVALID'],
    );
    const snapshot = await convergedSnapshot();
    snapshot.target.environmentId = '00000000-0000-4000-8000-000000000099';
    assert.deepEqual(reconcileJournal(journal([entry(1, 'op-001', 'prepared')]), snapshot).reasonCodes, ['JOURNAL_TARGET_MISMATCH']);
  });
});

describe('single-writer lease (T06)', () => {
  const scope = '00000000-0000-4000-8000-000000000002|function|sample_CalculateFee';
  const t0 = new Date('2026-10-15T10:00:00Z');

  it('excludes concurrent writers and only releases for the owner', async () => {
    const dir = await tempDir();
    const first = await acquireLease(dir, scope, 'host-a', RUN, 300, t0);
    assert.equal(first.acquired, true);
    const second = await acquireLease(dir, scope, 'host-b', '00000000-0000-4000-8000-0000000000f2', 300, t0);
    assert.deepEqual(second.acquired ? 'acquired' : second.reasonCode, 'LEASE_HELD');
    assert.equal((await releaseLease(dir, scope, '00000000-0000-4000-8000-0000000000f2')).reasonCode, 'LEASE_NOT_OWNED');
    assert.equal((await releaseLease(dir, scope, RUN)).released, true);
  });

  it('reports stale leases and requires explicit recovery naming the stale run', async () => {
    const dir = await tempDir();
    await acquireLease(dir, scope, 'host-a', RUN, 60, t0);
    const later = new Date(t0.getTime() + 120_000);
    const contender = await acquireLease(dir, scope, 'host-b', '00000000-0000-4000-8000-0000000000f2', 60, later);
    assert.equal(contender.acquired ? 'acquired' : contender.reasonCode, 'LEASE_STALE_REQUIRES_RECOVERY');
    assert.equal((await recoverStaleLease(dir, scope, '00000000-0000-4000-8000-0000000000f9', later)).reasonCode, 'LEASE_NOT_OWNED');
    assert.equal((await recoverStaleLease(dir, scope, RUN, t0)).reasonCode, 'LEASE_HELD');
    assert.equal((await recoverStaleLease(dir, scope, RUN, later)).recovered, true);
    assert.equal((await acquireLease(dir, scope, 'host-b', '00000000-0000-4000-8000-0000000000f2', 60, later)).acquired, true);
  });
});
