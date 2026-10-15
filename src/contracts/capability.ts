import type { ReasonCode } from './reasonCodes.js';

export type CapabilityOperation =
  | 'read.target-identity'
  | 'read.metadata'
  | 'read.definition'
  | 'host.validate'
  | 'function.create'
  | 'function.update.source'
  | 'function.update.metadata'
  | 'function.signature.change'
  | 'function.solution.associate'
  | 'function.invoke'
  | 'automated.register'
  | 'component.deactivate'
  | 'component.retire'
  | 'package.export'
  | 'package.import'
  | 'configuration.recover';

export type ProtocolEvidence = 'unverified' | 'verified-experimental';
export type Supportability = 'unverified' | 'documented' | 'confirmed-in-writing';

/** Phase 1 native provider identity. Every operation it is asked to perform returns blocked without dispatch. */
export const NATIVE_PROVIDER = { id: 'dataverse.native.blocked', version: '0.1.0' } as const;

export interface CapabilityRecord {
  operation: CapabilityOperation;
  phase: number;
  status: 'blocked';
  reasonCode: ReasonCode;
  protocolEvidence: ProtocolEvidence;
  supportability: Supportability;
  unknowns: string[];
  evidenceRefs: string[];
  unblockingProof: string;
}

/**
 * Phase 1 capability registry. Every entry is blocked: protocol evidence and supportability are tracked
 * separately, and neither is established for any native write, invocation, or package operation.
 */
export const CAPABILITY_REGISTRY: readonly CapabilityRecord[] = [
  {
    operation: 'read.target-identity',
    phase: 1,
    status: 'blocked',
    reasonCode: 'LIVE_TRANSPORT_NOT_CONFIGURED',
    protocolEvidence: 'unverified',
    supportability: 'documented',
    unknowns: ['U01'],
    evidenceRefs: [],
    unblockingProof: 'Approved public client ID plus an OS-backed delegated token provider wired to the trust-boundary transport.',
  },
  {
    operation: 'read.metadata',
    phase: 1,
    status: 'blocked',
    reasonCode: 'LIVE_TRANSPORT_NOT_CONFIGURED',
    protocolEvidence: 'unverified',
    supportability: 'documented',
    unknowns: ['U01'],
    evidenceRefs: ['E07', 'E08'],
    unblockingProof: 'Same as read.target-identity; metadata reads use only the bounded transport operations.',
  },
  {
    operation: 'read.definition',
    phase: 2,
    status: 'blocked',
    reasonCode: 'SNAPSHOT_MAPPING_UNVERIFIED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U03', 'U06'],
    evidenceRefs: ['E07', 'E08', 'E09'],
    unblockingProof: 'G0 evidence mapping customapi/fxexpression/msdyn_function rows to the adapter projection, with complete graph read-back.',
  },
  {
    operation: 'host.validate',
    phase: 2,
    status: 'blocked',
    reasonCode: 'NO_PROVEN_NON_EXECUTING_VALIDATOR',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U02', 'U07'],
    evidenceRefs: ['E14', 'E18'],
    unblockingProof: 'A documented, non-executing Dataverse-host validation route; pac power-fx repl/run evaluate and are excluded.',
  },
  {
    operation: 'function.update.source',
    phase: 2,
    status: 'blocked',
    reasonCode: 'NATIVE_UPDATE_PROTOCOL_UNVERIFIED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U02', 'U03', 'U08'],
    evidenceRefs: ['E07', 'E13'],
    unblockingProof: 'G0 redacted capture of one native-editor source edit: request sequence, server-derived fields, concurrency mechanism, read-back invariants.',
  },
  {
    operation: 'function.update.metadata',
    phase: 2,
    status: 'blocked',
    reasonCode: 'NATIVE_METADATA_UPDATE_PROTOCOL_UNVERIFIED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U02', 'U03'],
    evidenceRefs: ['E08'],
    unblockingProof: 'G0 evidence that display-name changes persist without side effects on registration.',
  },
  {
    operation: 'function.create',
    phase: 3,
    status: 'blocked',
    reasonCode: 'NATIVE_CREATE_PROTOCOL_UNVERIFIED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U02', 'U03', 'U04', 'U06', 'U08'],
    evidenceRefs: ['E10', 'E11'],
    unblockingProof: 'Proven compile/register/parameter/solution-association sequence; ordinary Custom API CRUD is insufficient.',
  },
  {
    operation: 'function.signature.change',
    phase: 3,
    status: 'blocked',
    reasonCode: 'BREAKING_CHANGE_REQUIRES_REVIEW',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U03', 'U04', 'U06'],
    evidenceRefs: ['E11'],
    unblockingProof: 'Proven signature/binding change lifecycle with caller impact analysis; never silent delete/recreate.',
  },
  {
    operation: 'function.solution.associate',
    phase: 3,
    status: 'blocked',
    reasonCode: 'SOLUTION_ASSOCIATION_PROTOCOL_UNVERIFIED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U06'],
    evidenceRefs: ['E12'],
    unblockingProof: 'Proven solution-membership representation for all native component rows.',
  },
  {
    operation: 'function.invoke',
    phase: 3,
    status: 'blocked',
    reasonCode: 'INVOCATION_REQUIRES_SEPARATE_TEST_GATE',
    protocolEvidence: 'unverified',
    supportability: 'documented',
    unknowns: ['U04'],
    evidenceRefs: ['E11', 'E13'],
    unblockingProof: 'Separate approved test plan with isolated sandbox data, effect disclosure, and cleanup accounting.',
  },
  {
    operation: 'automated.register',
    phase: 4,
    status: 'blocked',
    reasonCode: 'AUTOMATED_REGISTRATION_PROFILE_UNVERIFIED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U02', 'U05'],
    evidenceRefs: ['E03', 'E04'],
    unblockingProof: 'One proven message/table/stage profile with context, filtering, mode, order, and recursion semantics.',
  },
  {
    operation: 'component.deactivate',
    phase: 5,
    status: 'blocked',
    reasonCode: 'DEACTIVATION_PROFILE_UNVERIFIED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U05', 'U06'],
    evidenceRefs: ['E12'],
    unblockingProof: 'Verified deactivation profile; an index-row active flag is not assumed to disable a handler.',
  },
  {
    operation: 'component.retire',
    phase: 5,
    status: 'blocked',
    reasonCode: 'GENERIC_DELETE_DISABLED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U06', 'U08'],
    evidenceRefs: ['E12'],
    unblockingProof: 'Proven native teardown, dependency order, solution behavior, and post-removal verification.',
  },
  {
    operation: 'package.export',
    phase: 5,
    status: 'blocked',
    reasonCode: 'PACKAGE_EXPORT_NOT_ENABLED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U06', 'U08'],
    evidenceRefs: ['E14'],
    unblockingProof: 'Tested native component export behavior; export creates a service-side job and is not a passive read.',
  },
  {
    operation: 'package.import',
    phase: 5,
    status: 'blocked',
    reasonCode: 'PACKAGE_IMPORT_NOT_ENABLED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U06', 'U08'],
    evidenceRefs: ['E14'],
    unblockingProof: 'Tested round-trip, upgrade, and dependency ordering under a separate ALM plan and approval.',
  },
  {
    operation: 'configuration.recover',
    phase: 2,
    status: 'blocked',
    reasonCode: 'RECOVERY_PROTOCOL_UNVERIFIED',
    protocolEvidence: 'unverified',
    supportability: 'unverified',
    unknowns: ['U02', 'U03', 'U06'],
    evidenceRefs: ['E13'],
    unblockingProof: 'Proven lifecycle for compensating configuration changes; recovery cannot undo business effects.',
  },
];

export function capabilityFor(operation: CapabilityOperation): CapabilityRecord {
  const record = CAPABILITY_REGISTRY.find((c) => c.operation === operation);
  if (record === undefined) {
    throw new Error(`No capability record for ${operation}.`);
  }
  return record;
}
