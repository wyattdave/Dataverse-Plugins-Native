import { diag, type Diagnostic } from '../contracts/common.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import type { Snapshot } from '../contracts/snapshot.js';
import type { FunctionSpec } from '../contracts/spec.js';
import { buildDesiredState, diffProjection, resolveObserved } from './planner.js';

export type CheckObservation = 'matches' | 'differs' | 'unknown';

export interface VerificationCheck {
  check: string;
  observation: CheckObservation;
  reasonCode: ReasonCode | null;
}

export interface VerificationReport {
  observedStatus: string;
  checks: VerificationCheck[];
  diagnostics: Diagnostic[];
}

/**
 * Compares desired state with a snapshot projection. This is informational: without a live,
 * complete graph read-back the verification phase stays unknown and the command never succeeds.
 */
export function verifyAgainstSnapshot(spec: FunctionSpec, snapshot: Snapshot | undefined): VerificationReport {
  const desired = buildDesiredState(spec);
  const observed = resolveObserved(spec.identity.uniqueName, snapshot);
  const diagnostics: Diagnostic[] = [
    ...observed.diagnostics,
    diag('READ_BACK_REQUIRES_LIVE_READS', 'warning', 'read-back', 'Read-back verification requires live, complete graph reads.'),
  ];
  const graphUnknown = (check: string): VerificationCheck => ({ check, observation: 'unknown', reasonCode: 'GRAPH_READ_BACK_UNAVAILABLE' });

  if (observed.status !== 'present' || observed.projection === null) {
    const reason: ReasonCode = observed.status === 'ambiguous' ? 'SNAPSHOT_AMBIGUOUS_IDENTITY' : 'OBSERVED_STATE_UNKNOWN';
    const unknownChecks: VerificationCheck[] = ['source-sha256', 'parameters', 'binding', 'solution-membership'].map((check) => ({
      check,
      observation: 'unknown',
      reasonCode: reason,
    }));
    return {
      observedStatus: observed.status,
      checks: [...unknownChecks, graphUnknown('registration'), graphUnknown('dependencies')],
      diagnostics,
    };
  }

  const changes = diffProjection(desired.projection, observed.projection);
  const observe = (prefixes: string[]): VerificationCheck['observation'] => {
    const relevant = changes.filter((c) => prefixes.some((p) => c.path === p || c.path.startsWith(`${p}/`)));
    if (relevant.some((c) => c.impact === 'unknown' && c.reasonCode !== null)) {
      return 'unknown';
    }
    return relevant.length > 0 ? 'differs' : 'matches';
  };
  return {
    observedStatus: observed.status,
    checks: [
      { check: 'source-sha256', observation: observe(['/formula']), reasonCode: 'SNAPSHOT_MAPPING_UNVERIFIED' },
      { check: 'parameters', observation: observe(['/parameters']), reasonCode: 'SNAPSHOT_MAPPING_UNVERIFIED' },
      { check: 'binding', observation: observe(['/binding']), reasonCode: 'SNAPSHOT_MAPPING_UNVERIFIED' },
      { check: 'solution-membership', observation: observe(['/solution']), reasonCode: 'SNAPSHOT_MAPPING_UNVERIFIED' },
      graphUnknown('registration'),
      graphUnknown('dependencies'),
    ],
    diagnostics,
  };
}
