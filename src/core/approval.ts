import type { ApprovalEnvelope } from '../contracts/approval.js';
import { NATIVE_PROVIDER } from '../contracts/capability.js';
import { uniqueSorted } from '../contracts/common.js';
import { MAX_APPROVAL_TTL_SECONDS, type Plan } from '../contracts/plan.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import { canonicalize, hashCanonical } from './canonical.js';
import { computePlanHash, computePlanId } from './planner.js';
import { CAPABILITY_FINGERPRINT, POLICY_FINGERPRINT } from './policy.js';

/** Recomputes planId/planHash and compares policy/capability/provider fingerprints with the running adapter. */
export function verifyPlanIntegrity(plan: Plan): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  if (computePlanId(plan) !== plan.planId) {
    reasons.push('PLAN_ID_MISMATCH');
  }
  if (computePlanHash(plan) !== plan.planHash) {
    reasons.push('PLAN_HASH_MISMATCH');
  }
  if (plan.policy.fingerprint !== POLICY_FINGERPRINT) {
    reasons.push('POLICY_FINGERPRINT_CHANGED');
  }
  if (plan.capabilities.fingerprint !== CAPABILITY_FINGERPRINT) {
    reasons.push('CAPABILITY_FINGERPRINT_CHANGED');
  }
  if (plan.provider.id !== NATIVE_PROVIDER.id || plan.provider.version !== NATIVE_PROVIDER.version) {
    reasons.push('PROVIDER_CHANGED');
  }
  return uniqueSorted(reasons);
}

export function computeApprovalHash(envelope: Omit<ApprovalEnvelope, 'approvalHash'> | ApprovalEnvelope): string {
  const { approvalHash: _ignored, ...rest } = envelope as ApprovalEnvelope;
  return hashCanonical(rest);
}

export function isApprovalEligible(plan: { approvalEligible: boolean; planState: string }): boolean {
  return plan.approvalEligible && plan.planState !== 'draft';
}

export interface ApprovalContext {
  now: Date;
  currentPrincipalFingerprint: string | null;
}

/**
 * Checks every approval binding and returns all failing reasons (not just the first) so tampering is
 * diagnosable. Phase 1 plans are drafts, so PLAN_NOT_APPROVAL_ELIGIBLE is always present.
 */
export function verifyApproval(plan: Plan, approval: ApprovalEnvelope, context: ApprovalContext): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  if (!isApprovalEligible(plan)) {
    reasons.push('PLAN_NOT_APPROVAL_ELIGIBLE');
  }
  if (computeApprovalHash(approval) !== approval.approvalHash) {
    reasons.push('APPROVAL_HASH_MISMATCH');
  }
  if (approval.planHash !== plan.planHash || approval.planId !== plan.planId) {
    reasons.push('APPROVAL_PLAN_MISMATCH');
  }
  if (canonicalize(approval.target) !== canonicalize(plan.target.expected)) {
    reasons.push('APPROVAL_TARGET_MISMATCH');
  }
  // The approved set must equal the plan's operation set exactly: no omissions, extras, or duplicates.
  const approvedIds = approval.operations.map((o) => o.id);
  if (new Set(approvedIds).size !== approvedIds.length) {
    reasons.push('APPROVAL_OPERATION_NOT_IN_PLAN');
  }
  if (plan.operations.some((o) => !approvedIds.includes(o.id))) {
    reasons.push('APPROVAL_OPERATIONS_INCOMPLETE');
  }
  for (const approved of approval.operations) {
    const planned = plan.operations.find((o) => o.id === approved.id);
    if (planned === undefined || planned.kind !== approved.kind) {
      reasons.push('APPROVAL_OPERATION_NOT_IN_PLAN');
    } else if (canonicalize(uniqueSorted(approved.effects)) !== canonicalize(uniqueSorted(planned.effects))) {
      reasons.push('APPROVAL_EFFECTS_MISMATCH');
    }
  }
  const issued = Date.parse(approval.issuedAt);
  const expires = Date.parse(approval.expiresAt);
  const now = context.now.getTime();
  const maxTtlMs = Math.min(plan.maxApprovalTtlSeconds, MAX_APPROVAL_TTL_SECONDS) * 1000;
  if (issued > now) {
    reasons.push('APPROVAL_NOT_YET_VALID');
  }
  if (expires <= now) {
    reasons.push('APPROVAL_EXPIRED');
  }
  if (expires <= issued || expires - issued > maxTtlMs) {
    reasons.push('APPROVAL_TTL_EXCEEDS_POLICY');
  }
  if (approval.principal.fingerprint === null || context.currentPrincipalFingerprint === null) {
    reasons.push('PRINCIPAL_UNRESOLVED');
  } else if (approval.principal.fingerprint !== context.currentPrincipalFingerprint) {
    reasons.push('APPROVAL_PRINCIPAL_MISMATCH');
  }
  // Hashes detect tampering but anyone can recompute them. Until a trusted local attestation (protected
  // signing key or separately protected approval record) authenticates the approver, approvals fail closed.
  reasons.push('APPROVAL_ATTESTATION_UNVERIFIED');
  return uniqueSorted(reasons);
}
