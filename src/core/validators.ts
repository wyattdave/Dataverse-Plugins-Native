import { diag, hasErrors, sortDiagnostics, type Diagnostic, type JsonValue } from '../contracts/common.js';
import { SNAPSHOT_SCHEMA_VERSION, snapshotSchema, type Snapshot } from '../contracts/snapshot.js';
import { SPEC_SCHEMA_VERSION, specSchema, type FunctionSpec } from '../contracts/spec.js';
import { TARGET_SCHEMA_VERSION, targetSchema, type TargetConfig } from '../contracts/target.js';
import { hashCanonical } from './canonical.js';
import { parseDocument } from './documents.js';
import { checkSnapshotPolicy, checkSpecPolicy, checkTargetPolicy, findPlaceholders } from './policy.js';
import { parseStrictJson } from './strictJson.js';

export interface DocumentValidation<T> {
  value: T | undefined;
  schemaPassed: boolean;
  policyPassed: boolean;
  diagnostics: Diagnostic[];
}

export function validateSpecText(text: string): DocumentValidation<FunctionSpec> {
  const parsed = parseDocument<FunctionSpec>(text, specSchema, SPEC_SCHEMA_VERSION, 'spec');
  if (parsed.value === undefined) {
    return { value: undefined, schemaPassed: false, policyPassed: false, diagnostics: sortDiagnostics(parsed.diagnostics) };
  }
  const policy = checkSpecPolicy(parsed.value);
  return { value: parsed.value, schemaPassed: true, policyPassed: !hasErrors(policy), diagnostics: sortDiagnostics(policy) };
}

export function validateTargetText(text: string): DocumentValidation<TargetConfig> {
  const placeholders: Diagnostic[] = [];
  try {
    for (const path of findPlaceholders(parseStrictJson(text) as JsonValue)) {
      placeholders.push(diag('TARGET_PLACEHOLDER_UNRESOLVED', 'error', 'schema', 'Template placeholder must be replaced via approved private configuration.', path));
    }
  } catch {
    // parseDocument reports the parse error below.
  }
  const parsed = parseDocument<TargetConfig>(text, targetSchema, TARGET_SCHEMA_VERSION, 'target');
  if (parsed.value === undefined || placeholders.length > 0) {
    return {
      value: undefined,
      schemaPassed: false,
      policyPassed: false,
      diagnostics: sortDiagnostics([...placeholders, ...parsed.diagnostics]),
    };
  }
  const policy = checkTargetPolicy(parsed.value);
  return { value: parsed.value, schemaPassed: true, policyPassed: !hasErrors(policy), diagnostics: sortDiagnostics(policy) };
}

export interface SnapshotValidation extends DocumentValidation<Snapshot> {
  sha256: string | undefined;
}

export function validateSnapshotText(text: string): SnapshotValidation {
  const parsed = parseDocument<Snapshot>(text, snapshotSchema, SNAPSHOT_SCHEMA_VERSION, 'snapshot');
  if (parsed.value === undefined) {
    return { value: undefined, sha256: undefined, schemaPassed: false, policyPassed: false, diagnostics: sortDiagnostics(parsed.diagnostics) };
  }
  const policy = checkSnapshotPolicy(parsed.value);
  return {
    value: parsed.value,
    sha256: hashCanonical(parsed.value),
    schemaPassed: true,
    policyPassed: !hasErrors(policy),
    diagnostics: sortDiagnostics(policy),
  };
}
