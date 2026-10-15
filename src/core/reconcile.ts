import { diag, worstStatus, type Diagnostic, type ResultStatus } from '../contracts/common.js';
import type { Journal, JournalEntry, JournalState } from '../contracts/journal.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import type { OperationOutcome } from '../contracts/result.js';
import type { Snapshot } from '../contracts/snapshot.js';
import { hashCanonical } from './canonical.js';

export function computeEntriesSha256(entries: readonly JournalEntry[]): string {
  return hashCanonical(entries);
}

const ALLOWED_NEXT: Record<JournalState | 'start', readonly JournalState[]> = {
  start: ['prepared'],
  prepared: ['dispatching'],
  dispatching: ['completed', 'failed-definite', 'outcome-unknown'],
  completed: [],
  'failed-definite': [],
  'outcome-unknown': [],
};

/** Integrity and ordering checks; any failure makes the journal unsafe for continuation. */
export function checkJournalIntegrity(journal: Journal): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (computeEntriesSha256(journal.entries) !== journal.entriesSha256) {
    out.push(diag('JOURNAL_CORRUPT', 'error', 'integrity', 'Journal entries do not match entriesSha256.', '/entriesSha256'));
  }
  const lastState = new Map<string, JournalState>();
  journal.entries.forEach((entry, i) => {
    if (entry.sequence !== i + 1) {
      out.push(diag('JOURNAL_SEQUENCE_INVALID', 'error', 'integrity', 'Sequences must be contiguous from 1.', `/entries/${i}/sequence`));
    }
    const previous = lastState.get(entry.operationId) ?? 'start';
    if (!ALLOWED_NEXT[previous].includes(entry.state)) {
      out.push(diag('JOURNAL_SEQUENCE_INVALID', 'error', 'integrity', `Invalid transition ${previous} -> ${entry.state}.`, `/entries/${i}/state`));
    }
    lastState.set(entry.operationId, entry.state);
  });
  return out;
}

export type SnapshotFinding = 'not-checked' | 'records-observed-ownership-unproven' | 'records-not-observed' | 'snapshot-incomplete';

export interface ReconciledOperation extends OperationOutcome {
  lastState: JournalState;
  snapshotFinding: SnapshotFinding;
}

export interface ReconcileReport {
  status: ResultStatus;
  reasonCodes: ReasonCode[];
  operations: ReconciledOperation[];
  diagnostics: Diagnostic[];
}

/**
 * Read-only reconciliation. A dispatched operation without a proven result is treated as potentially
 * executed. Snapshot observations add facts but never convert unknown into success or permission to retry.
 */
export function reconcileJournal(journal: Journal, snapshot?: Snapshot): ReconcileReport {
  const diagnostics = checkJournalIntegrity(journal);
  if (diagnostics.length > 0) {
    return { status: 'failed', reasonCodes: [...new Set(diagnostics.map((d) => d.code))], operations: [], diagnostics };
  }
  if (
    snapshot !== undefined &&
    (snapshot.target.tenantId !== journal.target.tenantId ||
      snapshot.target.environmentId !== journal.target.environmentId ||
      snapshot.target.organizationId !== journal.target.organizationId)
  ) {
    const d = diag('JOURNAL_TARGET_MISMATCH', 'error', 'integrity', 'Snapshot target differs from the journal target.');
    return { status: 'blocked', reasonCodes: ['JOURNAL_TARGET_MISMATCH'], operations: [], diagnostics: [d] };
  }

  const snapshotRecordIds = new Set(snapshot?.components.flatMap((c) => c.records.map((r) => r.id)) ?? []);
  const byOperation = new Map<string, JournalEntry[]>();
  for (const entry of journal.entries) {
    byOperation.set(entry.operationId, [...(byOperation.get(entry.operationId) ?? []), entry]);
  }

  const operations: ReconciledOperation[] = [];
  for (const [operationId, entries] of [...byOperation.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const last = entries[entries.length - 1]!;
    const recordIds = [...new Set(entries.flatMap((e) => e.recordIds))];
    let snapshotFinding: SnapshotFinding = 'not-checked';
    if (snapshot !== undefined && recordIds.length > 0) {
      if (recordIds.some((id) => snapshotRecordIds.has(id))) {
        snapshotFinding = 'records-observed-ownership-unproven';
      } else {
        snapshotFinding = snapshot.completeness.status === 'complete' ? 'records-not-observed' : 'snapshot-incomplete';
      }
    }
    const base = { operationId, kind: 'journaled-operation', lastState: last.state, snapshotFinding };
    switch (last.state) {
      case 'prepared':
        operations.push({ ...base, status: 'not-started', dispatched: false, reasonCodes: ['OPERATION_NOT_STARTED'] });
        break;
      case 'dispatching':
      case 'outcome-unknown':
        operations.push({ ...base, status: 'outcome_unknown', dispatched: true, reasonCodes: ['OPERATION_OUTCOME_UNKNOWN'] });
        break;
      case 'failed-definite':
        operations.push({ ...base, status: 'failed', dispatched: true, reasonCodes: ['OPERATION_FAILED'] });
        break;
      case 'completed':
        operations.push({ ...base, status: 'completed', dispatched: true, reasonCodes: [] });
        break;
    }
  }

  const statuses = operations.map((o) => o.status);
  let status: ResultStatus = 'succeeded';
  if (statuses.includes('outcome_unknown')) {
    status = 'outcome_unknown';
  } else if (statuses.includes('completed') && statuses.some((s) => s === 'failed' || s === 'not-started')) {
    status = 'partial';
  } else if (statuses.includes('failed')) {
    status = 'failed';
  } else if (statuses.includes('completed')) {
    // Journal state is a local, unkeyed record; without authoritative live read-back it cannot prove success.
    status = 'blocked';
    diagnostics.push(
      diag('READ_BACK_REQUIRES_LIVE_READS', 'warning', 'read-back', 'Journaled completions are unverified without complete live graph read-back.'),
    );
  }
  if (status === 'outcome_unknown') {
    diagnostics.push(
      diag('OPERATION_OUTCOME_UNKNOWN', 'error', 'read-back', 'Dispatched operations without proven results halt dependent writes and need human review.'),
    );
  }
  const reasonCodes = [
    ...new Set([...operations.flatMap((o) => o.reasonCodes), ...(status === 'blocked' ? (['READ_BACK_REQUIRES_LIVE_READS'] as const) : [])]),
  ].sort();
  return { status: worstStatus(status), reasonCodes, operations, diagnostics };
}
