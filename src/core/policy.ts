import { CAPABILITY_REGISTRY } from '../contracts/capability.js';
import { diag, type Diagnostic, type JsonValue } from '../contracts/common.js';
import {
  isReservedPrefix,
  isReservedSolutionName,
  RESERVED_PREFIX_RULES,
  RESERVED_SOLUTION_NAMES,
} from '../contracts/patterns.js';
import { MAX_APPROVAL_TTL_SECONDS } from '../contracts/plan.js';
import type { ReasonCode } from '../contracts/reasonCodes.js';
import type { EnvironmentClass, Snapshot } from '../contracts/snapshot.js';
import { MVP_FUNCTION_PROFILE, type FunctionSpec } from '../contracts/spec.js';
import { PUBLIC_CLOUD_ORGANIZATION_HOST, type TargetConfig, type TargetIdentity } from '../contracts/target.js';
import { hashCanonical } from './canonical.js';

/**
 * Hard policy. There is deliberately no override flag, environment variable, or config switch:
 * production and unknown-environment writes are always blocked.
 */
export const POLICY = {
  id: 'adapter.policy/v1',
  productionWrites: 'hard-blocked',
  unknownEnvironmentWrites: 'hard-blocked',
  overrides: 'none',
  offlineClassificationTrusted: false,
  allowedClouds: ['public'],
  reservedPrefixRules: RESERVED_PREFIX_RULES.map((r) => r.source),
  reservedSolutionNames: [...RESERVED_SOLUTION_NAMES],
  managedComponents: 'blocked',
  connectors: 'blocked',
  genericDelete: 'disabled',
  organizationSettingChanges: 'never',
  securityRoleChanges: 'never',
  maxApprovalTtlSeconds: MAX_APPROVAL_TTL_SECONDS,
} as const;

export const POLICY_FINGERPRINT = hashCanonical(POLICY);
export const CAPABILITY_FINGERPRINT = hashCanonical(CAPABILITY_REGISTRY);

export function checkSpecPolicy(spec: FunctionSpec): Diagnostic[] {
  const out: Diagnostic[] = [];
  const profile = MVP_FUNCTION_PROFILE;
  if (!(profile.kinds as readonly string[]).includes(spec.kind)) {
    out.push(
      diag('AUTOMATED_PROFILE_NOT_SUPPORTED', 'error', 'policy', 'Automated registrations need a separately proven message/table/stage profile (Phase 4).', '/kind'),
    );
  }
  if (!spec.identity.uniqueName.startsWith(`${spec.solution.publisherPrefix}_`)) {
    out.push(diag('NAMESPACE_PREFIX_MISMATCH', 'error', 'policy', 'identity.uniqueName must start with "<publisherPrefix>_".', '/identity/uniqueName'));
  }
  if (isReservedPrefix(spec.solution.publisherPrefix)) {
    out.push(diag('RESERVED_PUBLISHER_PREFIX', 'error', 'policy', 'Microsoft-reserved prefixes are never targeted.', '/solution/publisherPrefix'));
  }
  if (isReservedSolutionName(spec.solution.uniqueName)) {
    out.push(diag('RESERVED_SOLUTION_NAME', 'error', 'policy', 'System solutions cannot be the owned solution.', '/solution/uniqueName'));
  }
  spec.parameters.forEach((p, i) => {
    if (!(profile.parameterTypes as readonly string[]).includes(p.type)) {
      out.push(
        diag(
          'PARAMETER_TYPE_NOT_IN_PROFILE',
          'error',
          'policy',
          `Profile ${profile.id} supports only ${profile.parameterTypes.join(', ')}; other documented types need their own binding/precision/locale proof.`,
          `/parameters/${i}/type`,
        ),
      );
    }
  });
  if (profile.requireOutputParameter && !spec.parameters.some((p) => p.direction === 'output')) {
    out.push(diag('OUTPUT_PARAMETER_REQUIRED', 'error', 'policy', `Profile ${profile.id} requires at least one output parameter.`, '/parameters'));
  }
  if (spec.tableReferences.length > profile.maxTableReferences) {
    out.push(diag('TABLE_REFERENCES_NOT_IN_PROFILE', 'error', 'policy', `Profile ${profile.id} allows no table references.`, '/tableReferences'));
  }
  if (spec.connectionReferences.length > profile.maxConnectionReferences) {
    out.push(
      diag('CONNECTION_REFERENCES_NOT_SUPPORTED', 'error', 'policy', 'Connector support is a separate, later capability; the list must be empty.', '/connectionReferences'),
    );
  }
  if (!(profile.locales as readonly string[]).includes(spec.formula.locale)) {
    out.push(diag('LOCALE_NOT_IN_PROFILE', 'error', 'policy', `Profile ${profile.id} supports only ${profile.locales.join(', ')}.`, '/formula/locale'));
  }
  out.push(
    diag('CAPABILITY_PROFILE_UNPROVEN', 'info', 'policy', `Profile ${profile.id} is an adapter restriction; its native lifecycle is not proven.`),
  );
  return out;
}

export interface OriginCheck {
  origin?: string;
  reason?: ReasonCode;
}

/** Accepts only an exact canonical https origin (no path, query, fragment, port, or credentials). */
export function parseExactOrigin(value: string): OriginCheck {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { reason: 'TARGET_URL_NOT_ORIGIN' };
  }
  if (url.protocol !== 'https:') {
    return { reason: 'TARGET_URL_NOT_HTTPS' };
  }
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    return { reason: 'TARGET_URL_NOT_ORIGIN' };
  }
  if (value !== url.origin && value !== `${url.origin}/`) {
    return { reason: 'TARGET_URL_NOT_ORIGIN' };
  }
  return { origin: url.origin };
}

export function findPlaceholders(value: JsonValue, path = ''): string[] {
  if (typeof value === 'string') {
    return /<[^<>]*>/.test(value) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findPlaceholders(item, `${path}/${i}`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => findPlaceholders(v, `${path}/${k}`));
  }
  return [];
}

export function checkTargetPolicy(target: TargetConfig): Diagnostic[] {
  const out: Diagnostic[] = [];
  const org = parseExactOrigin(target.expectedTarget.organizationUrl);
  if (org.reason !== undefined) {
    out.push(diag(org.reason, 'error', 'policy', 'organizationUrl must be an exact https origin.', '/expectedTarget/organizationUrl'));
  } else if (!PUBLIC_CLOUD_ORGANIZATION_HOST.test(new URL(org.origin!).hostname)) {
    out.push(diag('TARGET_CLOUD_UNSUPPORTED', 'error', 'policy', 'v1 supports public-cloud *.crm*.dynamics.com organizations only.', '/expectedTarget/organizationUrl'));
  }
  target.allowedOrigins.forEach((candidate, i) => {
    const check = parseExactOrigin(candidate);
    if (check.reason !== undefined) {
      out.push(diag(check.reason, 'error', 'policy', 'allowedOrigins entries must be exact https origins.', `/allowedOrigins/${i}`));
    } else if (org.origin !== undefined && check.origin !== org.origin) {
      out.push(diag('TARGET_ORIGIN_NOT_ALLOWLISTED', 'error', 'policy', 'v1 allowlist must contain exactly the organization origin.', `/allowedOrigins/${i}`));
    }
  });
  if (target.auth.authorityTenantId !== target.expectedTarget.tenantId) {
    out.push(diag('TARGET_AUTHORITY_TENANT_MISMATCH', 'error', 'policy', 'auth.authorityTenantId must equal expectedTarget.tenantId.', '/auth/authorityTenantId'));
  }
  if (isReservedPrefix(target.ownership.publisherPrefix)) {
    out.push(diag('RESERVED_PUBLISHER_PREFIX', 'error', 'policy', 'Microsoft-reserved prefixes are never targeted.', '/ownership/publisherPrefix'));
  }
  if (isReservedSolutionName(target.ownership.solutionUniqueName)) {
    out.push(diag('RESERVED_SOLUTION_NAME', 'error', 'policy', 'System solutions cannot be the owned solution.', '/ownership/solutionUniqueName'));
  }
  return out;
}

export function checkSnapshotPolicy(snapshot: Snapshot): Diagnostic[] {
  const out: Diagnostic[] = [];
  const org = parseExactOrigin(snapshot.target.organizationUrl);
  if (org.reason !== undefined) {
    out.push(diag(org.reason, 'error', 'policy', 'Snapshot organizationUrl must be an exact https origin.', '/target/organizationUrl'));
  }
  if (snapshot.completeness.status === 'complete' && snapshot.completeness.gaps.length > 0) {
    out.push(diag('SNAPSHOT_INCOMPLETE', 'error', 'policy', 'A snapshot that lists gaps cannot claim completeness.', '/completeness'));
  }
  const scope = new Set(snapshot.scope.uniqueNames.map((n) => n.toLowerCase()));
  snapshot.components.forEach((c, i) => {
    if (!scope.has(c.uniqueName.toLowerCase())) {
      out.push(diag('SNAPSHOT_SCOPE_MISMATCH', 'error', 'policy', 'Component is outside the snapshot scope.', `/components/${i}/uniqueName`));
    }
  });
  return out;
}

export function checkOwnership(spec: FunctionSpec, target: TargetConfig): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (spec.solution.publisherPrefix !== target.ownership.publisherPrefix) {
    out.push(diag('OWNERSHIP_MISMATCH', 'error', 'policy', 'Spec publisherPrefix differs from the approved ownership prefix.', '/solution/publisherPrefix'));
  }
  if (spec.solution.uniqueName.toLowerCase() !== target.ownership.solutionUniqueName.toLowerCase()) {
    out.push(diag('OWNERSHIP_MISMATCH', 'error', 'policy', 'Spec solution differs from the approved owned solution.', '/solution/uniqueName'));
  }
  return out;
}

export function normalizeIdentity(identity: TargetIdentity): TargetIdentity {
  const origin = parseExactOrigin(identity.organizationUrl).origin ?? identity.organizationUrl;
  return {
    tenantId: identity.tenantId,
    environmentId: identity.environmentId,
    organizationId: identity.organizationId,
    organizationUrl: origin,
  };
}

export function checkIdentityMatch(expected: TargetIdentity, observed: TargetIdentity): Diagnostic[] {
  const a = normalizeIdentity(expected);
  const b = normalizeIdentity(observed);
  const out: Diagnostic[] = [];
  for (const key of ['tenantId', 'environmentId', 'organizationId', 'organizationUrl'] as const) {
    if (a[key] !== b[key]) {
      out.push(diag('TARGET_IDENTITY_MISMATCH', 'error', 'policy', `Snapshot ${key} differs from the expected target.`, `/target/${key}`));
    }
  }
  return out;
}

export interface ClassificationAssessment {
  effective: 'unknown';
  reason: ReasonCode;
  diagnostics: Diagnostic[];
}

/**
 * Offline inputs are expectations, never proof. Phase 1 has no authenticated management discovery route,
 * so the effective classification is always unknown and writes stay blocked.
 */
export function assessClassification(claimed: EnvironmentClass | null): ClassificationAssessment {
  if (claimed === 'production') {
    return {
      effective: 'unknown',
      reason: 'PRODUCTION_WRITE_BLOCKED',
      diagnostics: [diag('PRODUCTION_WRITE_BLOCKED', 'error', 'policy', 'Production writes are hard-blocked; there is no override.', '/target/environmentClass')],
    };
  }
  if (claimed === 'sandbox') {
    return {
      effective: 'unknown',
      reason: 'OFFLINE_CLASSIFICATION_NOT_TRUSTED',
      diagnostics: [
        diag(
          'OFFLINE_CLASSIFICATION_NOT_TRUSTED',
          'warning',
          'policy',
          'A sandbox claim in a file is not authenticated discovery; classification remains unknown.',
          '/target/environmentClass',
        ),
      ],
    };
  }
  return {
    effective: 'unknown',
    reason: 'ENVIRONMENT_CLASSIFICATION_UNKNOWN',
    diagnostics: [diag('ENVIRONMENT_CLASSIFICATION_UNKNOWN', 'warning', 'policy', 'Environment classification is unknown; writes are blocked.')],
  };
}

/** Write gate used by any future mutation path. Only a live, authenticated sandbox classification can pass. */
export function writeGateReasons(effectiveClass: EnvironmentClass, classificationSource: 'live-authenticated' | 'offline'): ReasonCode[] {
  if (effectiveClass === 'production') {
    return ['PRODUCTION_WRITE_BLOCKED'];
  }
  if (effectiveClass !== 'sandbox') {
    return ['ENVIRONMENT_CLASSIFICATION_UNKNOWN'];
  }
  if (classificationSource !== 'live-authenticated') {
    return ['OFFLINE_CLASSIFICATION_NOT_TRUSTED'];
  }
  return [];
}
