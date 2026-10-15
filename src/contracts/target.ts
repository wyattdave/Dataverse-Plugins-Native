import { GUID_PATTERN, PUBLISHER_PREFIX_PATTERN, SOLUTION_UNIQUE_NAME_PATTERN } from './patterns.js';
import { arr, lit, obj, str, type Schema } from './schema.js';

export const TARGET_SCHEMA_VERSION = 'adapter.target/v1';

export interface TargetIdentity {
  tenantId: string;
  environmentId: string;
  organizationId: string;
  organizationUrl: string;
}

export interface TargetConfig {
  schemaVersion: typeof TARGET_SCHEMA_VERSION;
  expectedTarget: TargetIdentity;
  allowedOrigins: string[];
  expectedEnvironmentClass: 'sandbox';
  auth: { mode: 'delegated'; clientId: string; authorityTenantId: string };
  ownership: { publisherPrefix: string; solutionUniqueName: string };
}

/** v1 supports the public cloud only; other clouds need their own authority/resource validation. */
export const PUBLIC_CLOUD_ORGANIZATION_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.crm[0-9]{0,2}\.dynamics\.com$/;
export const PUBLIC_CLOUD_AUTHORITY_HOST = 'login.microsoftonline.com';

const guid = () => str({ pattern: GUID_PATTERN });

export const targetSchema: Schema = obj({
  schemaVersion: lit(TARGET_SCHEMA_VERSION, 'SCHEMA_VERSION_UNSUPPORTED'),
  expectedTarget: obj({
    tenantId: guid(),
    environmentId: guid(),
    organizationId: guid(),
    organizationUrl: str({ minLength: 9, maxLength: 256 }),
  }),
  // v1's expectedTarget is a singleton environment allowlist.
  allowedOrigins: arr(str({ minLength: 9, maxLength: 256 }), { minItems: 1, maxItems: 1 }),
  expectedEnvironmentClass: str({ enum: ['sandbox'] }),
  auth: obj({
    mode: str({ enum: ['delegated'] }),
    clientId: guid(),
    authorityTenantId: guid(),
  }),
  ownership: obj({
    publisherPrefix: str({ pattern: PUBLISHER_PREFIX_PATTERN }),
    solutionUniqueName: str({ pattern: SOLUTION_UNIQUE_NAME_PATTERN }),
  }),
});
