import type { ReasonCode } from '../contracts/reasonCodes.js';
import { hashCanonical } from '../core/canonical.js';
import type { DataverseReadTransport } from './readTransport.js';

export type TargetResolution =
  | {
      ok: true;
      organizationId: string;
      principalFingerprint: string;
      environmentClass: 'unknown';
      classificationReason: ReasonCode;
    }
  | { ok: false; reasonCode: ReasonCode };

/**
 * Resolves authenticated organization identity and a principal fingerprint. Environment classification
 * needs an authenticated management discovery route that is not implemented, so it stays unknown and
 * no hostname or display name is used to infer sandbox.
 */
export async function resolveTarget(transport: DataverseReadTransport, tenantId: string): Promise<TargetResolution> {
  const who = await transport.whoAmI();
  if (!who.ok) {
    return { ok: false, reasonCode: who.reasonCode };
  }
  return {
    ok: true,
    organizationId: who.value.organizationId,
    principalFingerprint: hashCanonical({ tenantId, userId: who.value.userId }),
    environmentClass: 'unknown',
    classificationReason: 'ENVIRONMENT_CLASSIFICATION_ROUTE_UNAVAILABLE',
  };
}
