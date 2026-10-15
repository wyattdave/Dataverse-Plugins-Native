/**
 * Adapter-owned identifier rules. These are conservative adapter constraints, not claimed
 * Dataverse platform limits; they exist to reject ambiguous identifiers before any network access.
 */
export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const PUBLISHER_PREFIX_PATTERN = /^[a-z][a-z0-9]{1,7}$/;
export const UNIQUE_NAME_PATTERN = /^[a-z][a-z0-9]{1,7}_[A-Za-z0-9][A-Za-z0-9_]{0,99}$/;
export const SOLUTION_UNIQUE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
export const LOGICAL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const LOCALE_PATTERN = /^[a-z]{2,3}-[A-Z]{2}$/;
export const DISPLAY_NAME_PATTERN = /^[^\u0000-\u001F\u007F]+$/;
export const OPERATION_ID_PATTERN = /^op-[0-9]{3}$/;
export const EVIDENCE_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,63}$/;
export const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Prefixes treated as Microsoft-owned; the adapter never targets them even when ownership appears to allow it. */
export const RESERVED_PREFIX_RULES: readonly RegExp[] = [/^ms/, /^adx$/];

export function isReservedPrefix(prefix: string): boolean {
  return RESERVED_PREFIX_RULES.some((rule) => rule.test(prefix));
}

export const RESERVED_SOLUTION_NAMES: readonly string[] = ['default', 'active', 'basic'];

export function isReservedSolutionName(name: string): boolean {
  return RESERVED_SOLUTION_NAMES.includes(name.toLowerCase());
}
