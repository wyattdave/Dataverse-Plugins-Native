import { capabilityFor, NATIVE_PROVIDER } from '../contracts/capability.js';
import { uniqueSorted } from '../contracts/common.js';
import type { PlanOperation } from '../contracts/plan.js';
import type { OperationOutcome } from '../contracts/result.js';

/** Gated per operation: proof for one operation never authorizes another. */
export interface NativeProvider {
  readonly id: string;
  readonly version: string;
  execute(operation: PlanOperation): Promise<OperationOutcome>;
}

/**
 * The only Phase 1 provider. It constructs no request payloads and dispatches nothing; it returns the
 * capability-specific blocking reason for every operation.
 */
export class BlockedNativeProvider implements NativeProvider {
  readonly id = NATIVE_PROVIDER.id;
  readonly version = NATIVE_PROVIDER.version;

  async execute(operation: PlanOperation): Promise<OperationOutcome> {
    const capability = capabilityFor(operation.kind);
    return {
      operationId: operation.id,
      kind: operation.kind,
      status: 'blocked',
      dispatched: false,
      reasonCodes: uniqueSorted([capability.reasonCode, ...operation.reasonCodes]),
    };
  }
}
