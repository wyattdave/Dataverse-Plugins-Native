# Evidence index and capability matrix

Evidence IDs (E01–E18), unknowns (U01–U08), and sources (S1–S20) refer to [requierments.md](../requierments.md) §2 and §13.
**No tenant access, network capture, or Microsoft confirmation was performed for this POC.** All tests are offline;
fakes are explicitly named and are not protocol evidence.

## How the code preserves the evidence boundaries

| Evidence | Constraint | Where enforced |
| --- | --- | --- |
| E01, E14 | No local Power Fx runtime; never evaluate to validate | No evaluator exists; `host` phase is always `unknown` (`NO_PROVEN_NON_EXECUTING_VALIDATOR`) |
| E02 | Six documented types are a ceiling; MVP = Decimal only; ≤ 5 table refs | `src/contracts/spec.ts` schema enum + `maxItems: 5`; profile check in `src/core/policy.ts` |
| E03, E04 | Automated support per proven combination; never touch Accelerator | `kind: automated` → `AUTOMATED_PROFILE_NOT_SUPPORTED`; reserved prefixes/managed state blocked |
| E05, E06 | Connectors are a separate capability; no setting changes | Non-empty `connectionReferences` → `CONNECTION_REFERENCES_NOT_SUPPORTED`; no code changes settings |
| E07–E09 | Schema ≠ lifecycle; `powerfxrule` role unknown | Snapshot `source.mapping` is always `unverified`; `read.definition` capability blocked |
| E10, E11 | Custom API CRUD ≠ native registration; "Function" is an unbound action | `function.create` blocked; no payloads or `isfunction` assumptions |
| E12 | Deletion can orphan components | `retire` → `GENERIC_DELETE_DISABLED`; planner never emits delete/recreate |
| E13 | Saving can initialize authentication / activate behavior | Plan effects disclose `may-initialize-connector-authentication`, `may-activate-behavior` |
| E15, E16, E18 | Proposals and generic-engine behavior are not shipped contracts | No `ThisRecord`/serialization assumptions; formula text preserved exactly |
| E17 | Any future UI parses/checks only on change; execution separate and explicit | The local UI (D21) auto-runs only an offline validate; every other operation is an explicit button and gated ones stay blocked |

## Unknown register status (all open)

| ID | Status in POC | What the code does meanwhile |
| --- | --- | --- |
| U01 | Open | Target identity validated offline only; `inspect --target` blocked; classification always `unknown` |
| U02 | Open | Every native write capability blocked with a specific reason |
| U03 | Open | Projection mapping marked unverified; formula compared by hash with declared normalization |
| U04 | Open | No invocation; `test` blocked (`INVOCATION_REQUIRES_SEPARATE_TEST_GATE`) |
| U05 | Open | `automated.register` blocked |
| U06 | Open | Solution association, retirement, package export/import blocked |
| U07 | Open | Locale limited to `en-US` profile; app-user auth not implemented |
| U08 | Open | `supportability` tracked separately from `protocolEvidence`; both `unverified` |

## Capability matrix

Source of truth: `CAPABILITY_REGISTRY` in [src/contracts/capability.ts](../src/contracts/capability.ts). Every entry is
`status: blocked`; the registry fingerprint is bound into every plan and result.

| Operation | Phase | Reason code | Protocol evidence | Supportability |
| --- | --- | --- | --- | --- |
| read.target-identity / read.metadata | 1 | LIVE_TRANSPORT_NOT_CONFIGURED | unverified | documented (Web API reads) |
| read.definition | 2 | SNAPSHOT_MAPPING_UNVERIFIED | unverified | unverified |
| host.validate | 2 | NO_PROVEN_NON_EXECUTING_VALIDATOR | unverified | unverified |
| function.update.source | 2 | NATIVE_UPDATE_PROTOCOL_UNVERIFIED | unverified | unverified |
| function.update.metadata | 2 | NATIVE_METADATA_UPDATE_PROTOCOL_UNVERIFIED | unverified | unverified |
| configuration.recover | 2 | RECOVERY_PROTOCOL_UNVERIFIED | unverified | unverified |
| function.create | 3 | NATIVE_CREATE_PROTOCOL_UNVERIFIED | unverified | unverified |
| function.signature.change | 3 | BREAKING_CHANGE_REQUIRES_REVIEW | unverified | unverified |
| function.solution.associate | 3 | SOLUTION_ASSOCIATION_PROTOCOL_UNVERIFIED | unverified | unverified |
| function.invoke | 3 | INVOCATION_REQUIRES_SEPARATE_TEST_GATE | unverified | documented (unbound action) |
| automated.register | 4 | AUTOMATED_REGISTRATION_PROFILE_UNVERIFIED | unverified | unverified |
| component.deactivate | 5 | DEACTIVATION_PROFILE_UNVERIFIED | unverified | unverified |
| component.retire | 5 | GENERIC_DELETE_DISABLED | unverified | unverified |
| package.export / package.import | 5 | PACKAGE_EXPORT_NOT_ENABLED / PACKAGE_IMPORT_NOT_ENABLED | unverified | unverified |

## Test coverage against §10

| Test | Status | Location |
| --- | --- | --- |
| T01 strict schema / unknown & duplicate fields / types / table refs / connectors | Implemented, offline | `tests/unit/strictJson.test.ts`, `tests/unit/specValidation.test.ts` |
| T02 canonical JSON, LF policy, whitespace/Unicode visibility, stable hashes (golden) | Implemented, offline | `tests/unit/canonical.test.ts` |
| T03 missing host validator, stale/incomplete snapshot, partial pagination | Implemented, offline | `tests/unit/planner.test.ts`, `tests/contract/readTransport.test.ts` |
| T04 wrong tenant/audience/origin, redirect/nextLink injection, production/unknown | Implemented with explicit fakes | `tests/unit/targetPolicy.test.ts`, `tests/contract/readTransport.test.ts` |
| T05 401/403, bounded throttling, timeout, denied reads | Implemented with explicit fakes | `tests/contract/readTransport.test.ts` |
| T06 approval/hash/TTL tampering, changed policy/capability, lease contention | Implemented (fake sequence) | `tests/unit/approval.test.ts`, `tests/unit/journalLease.test.ts` |
| T07 redaction of tokens/cookies/formulas/business fields | Implemented with synthetic fixtures | `tests/unit/redact.test.ts`, `tests/contract/cli.test.ts` |
| T08–T15 | **Not run / not implemented** (Phases 2–5 need sandbox evidence and approvals) | — |

## Next smallest proof for Phase 2

Phase 2 enables exactly one capability: `function.update.source` for one existing, owned, unmanaged sandbox Function.
The smallest set of missing proof (G0) is:

1. **Authenticated target identity (U01):** an approved public client ID, an OS-backed delegated token provider plugged
   into `DataverseReadTransport`, and a documented authenticated route that classifies the environment as sandbox.
   Hostnames or display names are not acceptable evidence.
2. **One redacted native-editor capture (U02/U03):** a separately authorized human edits the formula of one simple,
   unbound, no-connector Function once (plus one repeat). Record the exact request sequence; which `fxexpression` /
   `customapi` / `msdyn_function` fields change; which fields (`compiledexpression`, `dependencies`, `parameters`,
   `context`) are server-recomputed; and any side effects (E13).
3. **Concurrency mechanism:** whether the persisted row(s) support ETag/`If-Match` conditional updates, so
   `CONCURRENCY_MECHANISM_UNPROVEN` can be replaced by an atomic precondition.
4. **Read-back invariants:** the field set that proves the edit took effect and the designer can reopen/resave it
   (T09), so `read.definition` can map platform rows to the projection.
5. **Approver attestation:** a trusted local approval record or OS-protected signing key so
   `APPROVAL_ATTESTATION_UNVERIFIED` can be cleared for an explicitly approved experimental plan.
6. **Supportability (U08):** Microsoft documentation or written confirmation covering this use; otherwise the
   capability can at most be `verified-experimental` in a sandbox and never production.

If the capture shows the only path is a private/uncontracted endpoint or opaque client-generated fields, the update
capability stays blocked and the correct product remains this inspector/validator/planner.
