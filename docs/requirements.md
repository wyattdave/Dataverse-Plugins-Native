# Requirements: small deterministic Dataverse deployment adapter

**Owner:** David Wyatt  
**Audience:** GitHub Copilot and the developer reviewing its changes  
**Evidence cutoff:** 2026-10-15  
**Document status:** implementation handoff, not an implemented or supported deployment protocol  
**Filename:** `requirements.md` 

## 1. Start here: the decision and the first useful deliverable

Build a small CLI and reusable library that inspect, validate, compare, and plan native Dataverse Functions and automated low-code plug-in definitions.
The adapter coordinates the platform; it does **not** replace the Dataverse Power Fx runtime. “Deterministic” describes adapter planning and execution bookkeeping, not Power Fx business outputs or external-system behavior.
Prioritize **API/lifecycle proof first, reusable adapter second, skill third, UI last**; the adapter's read-only foundation can proceed while proof is incomplete.
The first implementation MUST be useful offline and read-only: accept a neutral specification, report evidence gaps, inspect authorized metadata, and generate deterministic plans.
Every native write capability MUST remain blocked until that specific operation passes the proof gates below.
This handoff authorizes code preparation only; it is not permission to change any tenant, run a Function, or conduct an experiment.

### 1.1 Requirement language and boundaries

- **MUST** is an acceptance requirement; **SHOULD** allows a documented, reviewed alternative; **OUT OF SCOPE** excludes MVP work.
- All CLI names, JSON contracts, capability profiles, gates, and repository names below are **proposed adapter contracts**, not Microsoft APIs.
- An observed schema is evidence that fields exist, not evidence that writing them implements a supported native lifecycle.
- A successful sandbox experiment establishes behavior in that tested context, not Microsoft support or production readiness.
- Native Functions are documented as preview/not for production; the adapter MUST block production deployment. [S1]
- Automated low-code plug-ins have no formal deprecation established by the supplied evidence; do not describe them as removed or abandoned. [S2][S3]
- OUT OF SCOPE: UI, always-on web service, database, LLM executor, installed skill, arbitrary agent HTTP access, or a traditional C# plug-in substitute.
- OUT OF SCOPE: evaluating Power Fx locally as a replacement runtime, automatic business-data tests, tenant-setting changes, and broad multi-host orchestration.

### 1.2 Instructions to GitHub Copilot

1. Inspect repository conventions, existing projects, authentication, dependency policy, tests, and CI before adding anything.
2. Reuse suitable existing conventions; otherwise propose a C# CLI plus library on a supported .NET LTS release.
3. For a new repository, default to `net10.0` (.NET 10, active LTS): released 2025-11-11, supported through 2028-11-14. Use another supported target only when actual repository/SDK/dependency constraints require it and record why; .NET 8/9 support ends 2026-11-10. Do not pin a guessed patch or package version. [S20]
4. Keep the first PR limited to Phase 1; use explicit blocked capability results instead of implementing speculative write requests.
5. Do not create native deployment payloads, compiled artifacts, or solution XML until the relevant protocol is proven; neutral specs and plans are allowed now.
6. No LLM, prompt interpretation, dynamic code execution, or arbitrary request construction may be in the apply path.
7. Production code MUST NOT return simulated success; fake transports belong only in clearly named tests.
8. Do not claim builds, tests, permissions, protocol discovery, or integrations passed unless actually run and recorded.
9. Record unresolved choices as diagnostics or a bounded decision register; do not fill gaps with guessed platform behavior.

## 2. Evidence inventory and interpretation

Evidence labels: **DOC** = official documentation; **PUBLIC-SCHEMA** = published entity reference; **TENANT-SCHEMA** = supplied read-only metadata observation; **PROPOSAL** = design discussion or this adapter design; **INFERENCE** = reasoned interpretation; **UNVERIFIED** = not established.
No new research or tenant access was performed to produce this handoff; URLs and observations are supplied evidence, with the cutoff above.

| ID | Classification | Established information | Constraint on implementation |
| --- | --- | --- | --- |
| E01 | DOC | Functions were formerly instant low-code plug-ins; server-side Power Fx; preview; caller-context runtime. [S1] | Do not substitute a local runtime or assume deployment identity becomes caller identity. |
| E02 | DOC | Function parameter types documented: Boolean, String, Float, Decimal, DateTime, Integer; up to five table references; System Customizer or higher at design time. [S1] | MVP restricts further to a no-connector, primitive, unbound Function; do not borrow complex types merely from Custom API support. |
| E03 | DOC | Instant plug-ins are deprioritized/replaced; automated Create/Update/Delete, pre/post, are authored through Accelerator. [S2] | Automated support must be proven per selected combination; formal automated deprecation is not established. |
| E04 | DOC | Accelerator itself is deprioritized and is a shell over platform API; support exists. [S3] | Do not customize managed Accelerator components or equate deprioritization with abandonment/removal. |
| E05 | DOC | Use native Power Fx table operations rather than the Dataverse connector; custom connectors import separately before connection references. [S2] | Connector support is a separate later capability, never an implicit dependency repair. |
| E06 | DOC | DLP has an existing-reference caveat; `Allowconnectorsonpowerfxactions` defaults on. [S2] | Existing references are not proof of policy compliance; never change this or other organization settings automatically. |
| E07 | PUBLIC-SCHEMA | `fxexpression` documents CRUD and `fxexpression_customapi` / `fxexpression_sdkmessageprocessingstep` relationships. [S4] | CRUD metadata is not a supported Power Fx compile/register contract. |
| E08 | PUBLIC-SCHEMA | `msdyn_function` includes a Custom API lookup and PowerFx/CSharp choices; `plugin` includes Instant/Automated choices and API/step links. [S5][S6] | Choices do not prove C# UI authoring; index records are not proof of a complete runtime registration. |
| E09 | PUBLIC-SCHEMA | `powerfxrule` is a separate entity. [S7] | Do not treat it as an alias for `fxexpression`; its role here is unknown. |
| E10 | DOC | Ordinary Custom APIs, parameters, and solution association can be created through Web API/SDK. [S8] | That is not evidence of the native Power Fx compilation/registration sequence. |
| E11 | DOC | Documented Function invocation is an unbound ACTION. [S9] | Product “Function” is not necessarily an OData function; inspect actual metadata, never infer `isfunction=true`. |
| E12 | DOC | Deleting in Solutions can orphan components; guidance says use the Functions area. [S10] | Generic deletion order is unproven; a native lifecycle profile is required before retirement. |
| E13 | DOC | Two-minute runtime limit; recursive post-operation `Patch` risk; edit/resave initializes APIM authentication. [S11] | Saving can do more than persist text; transaction rollback cannot reverse external effects. |
| E14 | DOC | `pac power-fx repl/run` evaluate expressions, not native deploy/compile operations. [S12] | Never execute them as “validation”; solution export/import is intended ALM, but these native components' round-trip is untested. |
| E15 | PROPOSAL | The Power Fx discussion proposes a C# host/NuGets, Custom API versus pipeline integration, explicit tables/logical names, and context/dialect changes. [S13] | Do not assume proposed `ThisRecord`, `NewRecord`, `OldRecord`, or serialization behavior shipped. |
| E16 | INFERENCE / UNVERIFIED | Public Power-Fx-Dataverse code helps explain interpreter/binding behavior; supplied public-source research was partial. [S14] | A complete supported native authoring protocol is not established; do not claim “no API exists.” |
| E17 | DOC / SOURCE | WebDemo combines React, Monaco/FormulaBar, and a .NET LSP; its page evaluates on change. [S15][S16] | A future UI MUST parse/check/suggest only on change; execution must be separate and explicit. |
| E18 | DOC / UNVERIFIED | Supplied Power Fx function-reference pages conflict or differ in scope. [S17][S18][S19] | Do not blindly rewrite syntax or names; generic-engine validation is not Dataverse-host parity. |

### 2.1 What the supplied tenant observation actually proves

- TENANT-SCHEMA: `fxexpression` entity set `fxexpressions` exposes `expression`, `compiledexpression`, `parameters`, `context`, `dependencies`, `entitylogicalname`, `messagename`, `name`, and `uniquename`.
- TENANT-SCHEMA: `customapi` exposes `fxexpressionid` Lookup, `isfunction`, `bindingtype`, `plugintypeid`, and `sdkmessageid`.
- TENANT-SCHEMA: `sdkmessageprocessingstep` exposes `fxexpressionid` Lookup, `eventhandler`, `plugintypeid`, `filteringattributes`, `stage`, `mode`, `rank`, `sdkmessageid`, and `sdkmessagefilterid`.
- TENANT-SCHEMA: `msdyn_function` exposes a Custom API lookup/language; `plugin` exposes Custom API and processing-step lookups/language/trigger type; `powerfxrule` exposes `expression`, `compiledexpression`, `dependencies`, and `parameters`, but its purpose here is UNKNOWN.
- Only schema was read: no definition/business rows, invocation, deployment, network capture, or solution round-trip was performed.
- Public shared schema supports a common model; it does not establish full runtime identity or prove a table is merely a discovery index.
- Dedicated metadata reading worked; no usable general authenticated Dataverse connector was available in the discovery context.
- The supplied environment-to-organization URL mapping was not independently verified; sandbox classification, tenant ID, publisher, and solution remain unknown.
- Do not copy discovery environment IDs or organization URLs into source control, examples, defaults, or fixtures; use private placeholders and authenticated discovery.

### 2.2 Bounded unknown register

| ID | Open question | Evidence needed / blocking consequence |
| --- | --- | --- |
| U01 | Is the authenticated tenant/environment/organization mapping correct, and is it a sandbox? | Trusted authenticated identity/environment discovery; every write blocked until resolved. |
| U02 | What supported call sequence validates, compiles, saves, registers, and activates native Power Fx? | Redacted human-editor baseline, definition diffs, metadata, and support/docs assessment; block each unproven operation. |
| U03 | Which fields are writable inputs versus server-generated state, and how are parameters/context serialized? | Captured supported behavior plus read-back; never infer serialization from field names. |
| U04 | What are the actual Function binding, invocation, output, and caller-privilege semantics? | Actual operation metadata plus separately approved sandbox tests. |
| U05 | What makes an automated handler effective: event, table, stage, mode, filtering, ordering, and context? | One supported registration profile at a time; no cross-combination assumptions. |
| U06 | How are ownership, solution membership, dependencies, rename/breaking changes, retirement, and upgrade represented? | Full graph inspection and separately tested lifecycle/ALM cases. |
| U07 | Which locale, logical/display-name bindings, formula dialect, connector authentication, and app-user behaviors apply? | Host-specific validation and isolated integration evidence; unknown remains blocked. |
| U08 | What is supported versus merely observed, including private endpoints and native component ALM? | Published Microsoft contract or written Microsoft confirmation covering the exact use; technical success alone is insufficient. |

## 3. Small architecture, not a platform

Default to one reusable library, one thin CLI, and one offline test project; use folders for responsibilities, not an assembly or service per concern. Add a separate sandbox test project only when integration work starts.

```text
src/Adapter/Contracts/          versioned specs, plans, results, capability records
src/Adapter/Core/               canonicalization, validation, diff/planning, policy gates
src/Adapter/Dataverse/          authenticated read transport, discovery, gated native provider
src/Adapter.Cli/                thin command parsing, local auth, JSON/text output
tests/Adapter.Tests/Unit/       deterministic pure logic and sanitized fixtures
tests/Adapter.Tests/Contract/   explicitly fake transport, failure/recovery sequences
tests/Adapter.IntegrationTests/ later, explicit opt-in sandbox tests; not ordinary CI
docs/                          protocol evidence index, decisions, command reference
```

- Proposed interfaces: `ITargetResolver`, `IDataverseReader`, `ISpecValidator`, `IPlanner`, `INativeProvider`, and `IJournalStore`; introduce only those needed for tested seams.
- The core MUST NOT know CLI, future skill, or UI details; all callers use the same typed contracts and policies.
- Read transport exposes bounded metadata/definition operations, not a generic arbitrary-HTTP escape hatch for an agent.
- The native provider is gated per operation: update proof never authorizes create, registration/activation, invocation, deactivation, or delete. Its initial implementation returns `blocked` with specific reason codes.
- A capability profile identifies exact operation, provider ID/version, target/platform/metadata fingerprint, validated inputs, required privileges, evidence hashes/version, supported concurrency mechanism, verification rules, and validity/review dates; changes invalidate dependent approvals.
- Track `protocolEvidence` and `supportability` separately; an explicitly authorized sandbox experiment may be `verified-experimental` while support remains `unverified`.
- No always-on service or database; use private local JSON journals, evidence indexes, and snapshots with restrictive user permissions and retention limits.
- Use a single-writer lease keyed by target and component scope, with owner/run ID and explicit stale-lease recovery; support only one designated writer host in MVP.
- A local lease/preflight cannot exclude concurrent humans using native editors. Require atomic conditional updates or a proven equivalent for the operation's affected state; read-before-write alone is insufficient. Block writes without adequate concurrency protection and defer multi-host writers; this does not imply a graph-wide transaction.
- Keep production dependencies minimal and use existing repository tooling; do not add a framework or background job system for this adapter.

## 4. Versioned neutral specification

The following is an **adapter-owned design example**, not harvested tenant content or a native request body.
The first profile is one unbound, pure-calculation Function, Decimal inputs/output, no tables, no connectors, and no execution during validation.
Parameter/output binding and the exact host interpretation of this source MUST still be proven; the example does not claim deployability.

```json
{
  "schemaVersion": "adapter.spec/v1",
  "kind": "function",
  "identity": {
    "uniqueName": "sample_CalculateFee",
    "displayName": "Calculate fee"
  },
  "binding": "unbound",
  "solution": {
    "uniqueName": "sample_AdapterLab",
    "publisherPrefix": "sample"
  },
  "parameters": [
    { "name": "Amount", "direction": "input", "type": "Decimal" },
    { "name": "Rate", "direction": "input", "type": "Decimal" },
    { "name": "Fee", "direction": "output", "type": "Decimal" }
  ],
  "formula": {
    "text": "Amount * Rate",
    "dialect": "dataverse-function",
    "locale": "en-US",
    "lineEndings": "lf"
  },
  "tableReferences": [],
  "connectionReferences": []
}
```

- `schemaVersion` uses an exact supported identifier; reject unknown versions, properties, duplicate JSON keys, invalid enum values, and ambiguous identifiers before network access.
- `kind` is `function` or, in a later profile, `automated`; all names here are adapter labels, not platform enum values.
- The example's `sample` publisher/solution are illustrative placeholders; resolve real ownership and solution records from approved private configuration.
- The six documented Function type labels are the ceiling, not a promise that every type is implemented; reject types outside the selected capability. [S1]
- Initially support only the illustrated Decimal input/output signature after proof; Float/DateTime and other documented types require their own binding, precision, and locale tests.
- `formula.text` preserves exact source except declared LF normalization; retain dialect and locale, do not format/rewrite formulas silently.
- `tableReferences` entries, when supported, use `{ "logicalName": "sample_calculation" }`; resolve canonical table identity, privileges, and allowed count from evidence, not display-name guessing.
- Connection references are empty in MVP; reject nonempty lists until a separately tested connector profile exists.
- Display names are presentation only; ambiguous or missing logical-name binding is a diagnostic, not permission to substitute a similarly named object.
- Changes to name, signature, binding, kind, event, or table MUST be classified for breaking impact; require a new reviewed plan, never silent delete/recreate.
- Optional future automated fragment below shows neutral intent only; it is incomplete and not an acceptable standalone spec or platform payload.

```json
{
  "kind": "automated",
  "registration": {
    "message": "Update",
    "tableLogicalName": "sample_calculation",
    "stage": "postOperation"
  }
}
```

`postOperation` is an adapter label, not a claimed numeric stage; no default mode, rank, filtering attributes, or context variables are asserted.
A later automated schema MUST require a proven combination and explicit trigger semantics; do not add unsupported fields merely because metadata exposes them.

## 5. Private target configuration and trust boundaries

This template contains placeholders only; it is an adapter contract, not a known target or permission grant.

```json
{
  "schemaVersion": "adapter.target/v1",
  "expectedTarget": {
    "tenantId": "<TENANT_GUID>",
    "environmentId": "<ENVIRONMENT_GUID>",
    "organizationId": "<ORGANIZATION_GUID>",
    "organizationUrl": "https://<APPROVED_ORGANIZATION_HOST>"
  },
  "allowedOrigins": ["https://<APPROVED_ORGANIZATION_HOST>"],
  "expectedEnvironmentClass": "sandbox",
  "auth": {
    "mode": "delegated",
    "clientId": "<APPROVED_PUBLIC_CLIENT_ID>",
    "authorityTenantId": "<TENANT_GUID>"
  },
  "ownership": {
    "publisherPrefix": "<OWNED_PREFIX>",
    "solutionUniqueName": "<OWNED_SOLUTION>"
  }
}
```

- Resolve tenant, environment GUID, organization ID/URL, and environment classification through trusted authenticated discovery; compare every expected identifier and reject inconsistencies.
- Configuration claims are expectations, not proof: `expectedEnvironmentClass=sandbox` MUST NOT authorize an unknown or production environment.
- If an authenticated management discovery route is unavailable, report classification `unknown`; do not infer sandbox from a hostname, display name, or developer assertion.
- Enforce environment and origin allowlists and namespace/solution ownership; v1's `expectedTarget` is a singleton environment allowlist. No implicit active PAC profile or “current environment” fallback.
- Start with local delegated authentication using an approved public-client flow and secure OS-backed token cache; never put credentials or bearer tokens in specs, arguments, logs, or git.
- Application-user/service-principal authentication is deferred until privilege, caller-context, and lifecycle behavior are independently proven.
- Accept HTTPS only; validate cloud/authority/resource configuration and token audience against the approved authenticated target before sending a token.
- Never send tokens to arbitrary supplied hosts; disable automatic redirects or reject any unapproved origin/authority change before following it.
- Validate every pagination/operation-location URL against the same trust boundary; a service-provided next link is not exempt.
- Production and unknown-environment writes are hard blocked; there is no `--force`, environment variable, config switch, or approval override for this policy.
- Direct mutation is limited to owned unmanaged components; managed solution components change only through separately verified normal ALM.
- Never alter managed Accelerator/Microsoft components, even if a namespace check appears to allow it; never change organization settings or security roles automatically.
- Do not log secrets, formula/code bodies, business data, raw HTTP payloads, or user tokens; use hashes, bounded diagnostics, safe correlation IDs, and classified private evidence references.
- Private target files, journals, snapshots, and sanitized capture evidence MUST be excluded from git; only synthetic examples and redaction-tested fixtures are commit-ready.

## 6. CLI contract and mutation classifications

Executable name `dataverse-plugins-native` is proposed; adapt to repository naming. Every command supports structured JSON output and explicit target/config inputs where relevant.
Commands are introduced incrementally, not all implemented as working mutations in the first PR.

| Command | First phase | Contract and side effects |
| --- | --- | --- |
| `inspect` | 1 | Read authorized target identity/metadata; selected definition reads require explicit scope. Local output only; no invoke or deployment write. |
| `validate` | 1 | Offline schema/policy checks; optional metadata checks. Host validation only when a proven non-executing route exists. Never evaluate to validate. |
| `plan` | 1 | Build a deterministic intent diff from spec plus identified snapshot/live reads; no writes or auto-tests. Phase 1 always emits draft, non-executable, non-approvable plans. |
| `apply` | 1 stub; 2+ gated | Mutates only operations in an immutable approved plan; Phase 1 always returns `blocked`. No implicit create/update fallback. |
| `verify` | 1 reads; 2+ lifecycle | Read back source/bindings/registration/solution graph; no invocation. Missing evidence produces unknown validation and an overall blocked/partial result, not success. |
| `test` | 3+ separate gate | Explicit Function invocation or automated-event exercise; can change records and call external systems. Requires a separate test plan/approval. |
| `package export` | 5 | Writes local package files and may create a service-side export job; not a purely passive metadata read. |
| `package import` | 5 | Writes the environment; separate ALM plan, target checks, approval, and verification required. |
| `reconcile` | 1 local; 2+ remote reads | Read-only comparison of an interrupted journal against observed state; never silently retries or repairs. |
| `recover` | 1 blocked stub; 2+ gated | Proposes or executes separately approved compensating configuration changes where proven; cannot undo emitted business effects. |
| `retire` | 1 blocked stub; 5 gated | Proven deactivation/removal only; generic delete is disabled until the complete lifecycle is verified. |

Suggested offline usage: `dataverse-plugins-native validate --spec calculation.json --offline --json`, then `dataverse-plugins-native plan --spec calculation.json --snapshot baseline.json --json`.
A snapshot MUST carry identity, acquisition time, completeness, projection version, and evidence fingerprints; offline planning cannot authorize a later write without fresh preflight reads.
Phase 1 plans MUST declare `planState=draft`, `executionReadiness=blocked`, and `approvalEligible=false`; refuse approval when the operation's required protocol/host checks or preconditions are missing, not merely at dispatch.
Unknown CLI options and invalid input are errors; no silent defaults to an environment, principal, destructive operation, or evaluation mode.
A read-only command may authenticate or generate ordinary service audit records; it MUST NOT invoke business logic, save definitions, or run export/import jobs implicitly.

### 6.1 Proposed result contract

```json
{
  "schemaVersion": "adapter.result/v1",
  "command": "apply",
  "status": "blocked",
  "exitCode": 2,
  "reasonCodes": ["NATIVE_UPDATE_PROTOCOL_UNVERIFIED"],
  "executionReadiness": "blocked",
  "planId": "<SEMANTIC_PLAN_SHA256>",
  "planHash": "<IMMUTABLE_PLAN_SHA256>",
  "validation": [
    { "phase": "schema", "status": "passed" },
    { "phase": "host", "status": "unknown", "reason": "NO_PROVEN_NON_EXECUTING_VALIDATOR" }
  ],
  "operations": [],
  "journalReference": null
}
```

- Top-level status/exit codes are stable: `succeeded=0`, `blocked=2`, `failed=3`, `partial=4`, `outcome_unknown=5`; invalid command/input uses `failed=3` with a distinct reason code.
- `blocked` means preconditions/policy/evidence prevent execution; `failed` means a definite known failure; `partial` means a known incomplete result; `outcome_unknown` means a dispatched write/invocation may have taken effect.
- Validation phase statuses are `passed`, `failed`, `skipped`, or `unknown`; a missing host validator MUST NOT become a passed host check. Name phases explicitly: schema, policy, metadata/bindings, host, preflight, and read-back; report requested scope and skipped/unknown reasons.
- `validate --offline` may succeed for explicitly reported offline scope while host readiness stays blocked; `plan` success means a plan was produced, not deployment eligibility.
- Include run/correlation IDs, scoped target/principal fingerprints, completeness, capability evidence, warnings, and per-operation outcomes in the full schema; redact sensitive values in public output.
- Overall precedence is `outcome_unknown`, `partial`, `failed`, `blocked`, then `succeeded`; some completed mutations plus an uncompleted remainder is `partial` unless any effect is uncertain. Retain per-operation facts instead of flattening uncertainty.
- Standard output in JSON mode contains one result object; diagnostics go to redacted standard error. Do not leak raw platform error bodies.

## 7. Deterministic planning and exact approval

1. Parse with strict versioned schemas; reject duplicate keys and unknown properties before any target operation.
2. Normalize only declared formula line endings (`CRLF`/`CR` to `LF` when `lineEndings=lf`); do not trim, reformat, Unicode-normalize, or translate names.
3. Canonicalize JSON with a documented fixed UTF-8 serializer: recursively ordinal-sort object keys, retain ordered arrays, and sort only schema-declared sets by stable logical identity.
4. Contract v1 numeric fields are integers; decimal formula values remain source text. Reject unsupported numeric encodings and pin serializer escaping/number rules with golden tests.
5. Hash normalized source and canonical desired spec using SHA-256; define the canonicalization version in every plan.
6. Read complete relevant observed state, resolve identity/ownership/dependencies, and capture supported record versions/ETags; do not assume every entity supports optimistic concurrency.
7. A plan MUST contain target identity/classification, principal/policy fingerprints, provider ID/version, capability/evidence fingerprints, desired and expected observed state, dependencies, ordered mutations/effects, preconditions, verification strategy, and maximum approval TTL.
8. Include scope/completeness and missing-proof diagnostics; do not generate plausible native HTTP payloads or mark a draft approvable for capabilities not yet proven.
9. Compute semantic `planId` from canonical desired/observed projections, target/principal/policy/provider/capability/evidence fingerprints, operations/effects, preconditions, and planner/schema versions; exclude timestamps, approval expiry, run IDs, and the ID/hash fields themselves.
10. Proposed initial approval TTL is 30 minutes, bounded by policy and evidence validity. Put approval issuance/expiry in a detached approval envelope, not the semantic hash.
11. Compute `planHash` over the complete immutable canonical plan excluding its own hash and detached approvals; it MUST bind provider/version, evidence, policy, operations/effects, target, and preconditions.
12. The approval envelope MUST reference that exact `planHash`, target, allowed operation IDs/effects, approver identity, issuance, and expiry. Compute its `approvalHash` over all these fields excluding its own hash; no expiry may exceed the plan's TTL policy or evidence validity.
13. Use a local explicit approval flow with a retained private attestation; reject draft/ineligible plans, and never treat a spec, chat request, or file possession as blanket approval.
14. Before the first mutation, verify both hashes, approval/expiry, current principal/privileges, target classification, ownership, dependency state, provider/capability/evidence validity, and fresh observed state plus atomic concurrency conditions.
15. Drift blocks before mutation and requires a newly reviewed plan. Expired approval requires fresh checks and a new explicit approval; never edit or silently extend an approved artifact.
16. Recheck relevant concurrency preconditions before each later operation; halt on drift instead of continuing a partly invalid sequence.
17. The same desired state, after fully verified convergence, MUST plan a no-op; no-op verification is read-only and MUST NOT invoke the Function.
18. Identity matching MUST use proven mappings and resolved IDs; duplicates or ambiguous names block. Do not infer alternate keys or upsert support from `uniquename`; creation also needs proven uniqueness/conflict behavior, since a read-before-create check alone does not prevent races.
19. Breaking changes produce explicit impact diagnostics and new approval; never silently recreate, rename, switch binding, or discard dependencies.
20. Offline/incomplete plans are useful intent diffs but remain non-executable; no auto-tests, hidden imports, or speculative registration steps.

## 8. Native write-provider proof and execution rules

- A write capability MUST have retained redacted evidence for its exact request sequence, inputs, generated fields, permission requirements, side effects, and read-back invariants.
- Save/registration can initialize services/authentication or activate behavior; disclose and bind those effects in the plan and approval even when no test is run. “No auto-test” does not mean “no runtime effects.” [S11]
- Discover entity sets, navigation properties, option values, create/update flags, and relationships from actual metadata; do not synthesize binding property names or numeric enums.
- Do not guess serialization of `compiledexpression`, `context`, `dependencies`, or `parameters`; treat generated state as server-owned unless the lifecycle evidence proves otherwise.
- Do not hand-author opaque compiled values or solution XML, scrape tokens, replay cookies, invoke private endpoints as a production contract, or automate the UI as a workaround.
- If required fields remain opaque or the only sequence depends on a private/uncontracted endpoint, stop that capability and record the exact gap; keep read-only capabilities usable.
- Supportability approval is a separate gate: Microsoft documentation or written confirmation must cover the use before describing it as supported.
- The bounded sandbox provider may be labeled experimental only after protocol proof and explicit risk approval; it never unlocks production or implies support.
- Verify complete read-back of source, parameter/output bindings, native registration, dependency links, and solution membership; an active `msdyn_function`/`plugin` row is insufficient.
- Define equality using proven authoritative fields; retain server-generated hashes/versions where useful, but do not invent opaque-field canonicalization to hide differences.
- Read every page required for the scoped graph; continuation failure, permission-filtered uncertainty, response truncation, or missing related records makes completeness explicit and prevents an executable plan.
- Retry reads only for bounded transient cases such as throttling/service unavailability, respecting server delay with capped backoff and a total deadline; never retry 401/403 by escalating privileges.
- Disable implicit SDK/transport retries for mutations and invocation unless the exact operation has a proven retry contract. An ambiguous dispatch/timeout records `outcome_unknown`, halts all dependent writes, and requires reconciliation; never blindly retry create or invocation.
- A definite server rejection is not automatically proof of zero side effects across an unproven multi-call sequence; preserve completed/unknown operation states.
- Write a durable journal entry before dispatch, then record the observed response/read-back after each operation; journal target, plan hash, operation ID, request hash, known record IDs, and concurrency values, not code bodies.
- Persist journals with same-directory atomic replacement and durable flush where supported; detect incomplete/corrupt persistence and refuse unsafe continuation. Protect private recovery snapshots separately from logs.
- On restart, a prepared/dispatched operation without a proven result is treated as potentially executed; reconcile against expected identity and graph before any new approval or dispatch.
- Bound transport timeouts, polling, and reconciliation attempts; unresolved identity or duplicate candidates stay blocked/unknown and require human review.
- Never claim all-or-nothing transactions unless a supported API covers the complete operation set; a multi-call deployment may stop after partial effects.
- A verified retry/idempotency mechanism may be used only for the operation/profile it actually covers; local hashes are not server idempotency keys.

## 9. Recovery, reconciliation, and retirement

- Reconciliation is read-only and reports observed convergence, definite absence, drift, duplicates, or unresolved outcome; it never turns “not found on one read” into permission to recreate.
- Desired-state equality alone does not prove ownership or that this run successfully created the component. Require authoritative identity/correlation evidence plus complete graph verification; ambiguous reconciliation stays `outcome_unknown`, with dependent writes halted. Resume only when earlier effects and ownership are resolved.
- Recovery restores configuration only where the protocol permits; it does not undo prior record mutations, messages, connector calls, or external-system effects.
- Keep protected before-state snapshots sufficient for a proposed compensating plan; recompute generated fields through the proven lifecycle, never restore opaque compiled values by guess.
- Every compensating mutation needs its own current-state plan, policy/concurrency checks, and explicit approval; rollback is not an authorization bypass.
- Deactivation is a mutation and is allowed only for a verified profile; do not assume an `active` index flag disables a handler.
- Generic deletion remains disabled until discovery, native teardown, dependencies, solution behavior, and post-removal verification are all proven. [S10]
- Do not invent cascade order or delete Custom API/step/expression/index rows independently to “clean up.”
- Never modify managed Microsoft/Accelerator components or organization settings during recovery; stop and report a support escalation instead.

## 10. Validation and test strategy

Offline tests and fake-transport contract tests MUST be clearly separated from opt-in sandbox integrations; none of the tests below are claimed to have run for this handoff.
Use the repository's existing test runner and CI; ordinary CI must need neither tenant credentials nor a network-connected Dataverse environment.

| Test ID | Required case | Expected result / phase |
| --- | --- | --- |
| T01 | Strict schema, unknown/duplicate fields, invalid types, extra table refs, unsupported connectors | Deterministic local rejection; Phase 1. |
| T02 | Canonical JSON/key order, LF policy, unchanged formula whitespace/Unicode, stable hashes | Equivalent declared semantics produce stable IDs; significant source differences remain visible; Phase 1. |
| T03 | Missing host validator, stale/incomplete snapshot, partial pagination | Never claim host validity or executable completeness; Phase 1. |
| T04 | Wrong tenant/audience/origin, redirect/next-link host injection, production/unknown environment | No unsafe token forwarding or writes; Phase 1 contracts, later sandbox identity checks. |
| T05 | 401/403, bounded throttling retries, timeout, denied graph reads | No escalation; stable reason codes and completeness; Phase 1. |
| T06 | Approval/hash/TTL tampering, changed principal/policy/capability, lease contention, concurrency drift | Block before mutation; Phase 1 fake sequence, Phase 2 real supported concurrency. |
| T07 | Logs/error bodies/captures containing tokens, formulas, business fields | Redaction verified with synthetic fixtures; Phase 1 and every provider change. |
| T08 | Invalid formula submitted through a proven sandbox save/validation lifecycle | Definite rejection or accurately reported partial/unknown state; no assumed atomicity; Phase 2. |
| T09 | Source update, server-derived-field recomputation, designer reopen/edit/resave, read-back graph | Native editor interoperability and lifecycle invariants; Phase 2. |
| T10 | Same spec twice, matching-but-unowned state, duplicate names, lost create response, SDK retries, interrupted journal | Verified no-op only with identity/ownership proof; ambiguous create stays unknown, dependent writes halt, no implicit retry; Phases 2–3. |
| T11 | Decimal precision, names/locale/context, signature/binding changes, insufficient privileges | Proven behavior or blocked capability; no generic-engine parity claims; Phases 2–3. |
| T12 | Explicit invocation with approved inputs and expected output/caller context | Isolated sandbox only; separate test approval and cleanup accounting; Phase 3. |
| T13 | Actual event/table/stage/filter/mode/order and recursion-safe behavior | Only supported combinations; no automatic assumptions from schema; Phase 4. |
| T14 | Native solution export/import round-trip, upgrade, removal, and managed ownership | Graph/behavior preserved or documented blockers; Phase 5. |
| T15 | Application user and connector import/reference/authentication/DLP/isolation | Separate profiles and approvals; external effects isolated; Phase 5. |

Fake tests may simulate native responses to exercise orchestration but MUST NOT be cited as proof of a Microsoft protocol.
Integration tests MUST require explicit sandbox identity, scoped authorization, effect disclosure, approved test data, and bounded cleanup; failure cleanup is not permission for generic deletion.
Run actual automated events only against isolated records with recursion guards/limits established by the verified profile; the runtime limit is not a safety mechanism. [S11]

## 11. Phased plan and gates

### Phase 0 — finite lifecycle discovery and supportability assessment

**Scope:** a separately authorized human-run experiment uses the native editor in a positively identified sandbox; it is not adapter `apply`. This handoff does not authorize those writes, and Phase 1 MUST NOT provide a generic HTTP/replay escape hatch for discovery.
Start with one simple unbound no-connector Function and one isolated automated example; avoid expanding into a full feature survey.
Capture sanitized network evidence and permitted existing-definition reads/exports before and after one create/edit cycle per example; record client/platform versions, metadata, graph diffs, and visible errors.
Sanitized HAR/evidence MUST exclude cookies, tokens, personal/business data, and unrelated requests; keep private source snapshots separate, minimize retention, and never commit raw captures.
Answer U01–U08 and identify each read/save/compile/register/activate/solution-association operation; record which questions remain unanswered rather than extrapolating.
Bound discovery to the two examples and one repeat of each relevant operation; if still unclear, stop, document the blocker, and seek Microsoft clarification instead of unbounded reverse engineering.
**Gate G0 / done:** a reviewed evidence index and capability matrix distinguish proven sandbox behavior, unsupported/private dependencies, unverified operations, and supportability; read-only Phase 1 does not depend on success here.

### Phase 1 — useful read-only/offline adapter; concrete first PR

1. Add the smallest CLI/library structure consistent with the repository, strict versioned spec/target/result/plan schemas, synthetic examples, and test fixtures.
2. Implement source hashing/canonicalization, offline validation, semantic diff/planning, immutable plan hashing, diagnostics, and stable exit codes.
3. Implement authenticated target resolution and bounded metadata reads where a legitimate transport is available; otherwise support explicit snapshots and report live inspection blocked.
4. Implement read-only `inspect`, `validate`, `plan`, and scoped `verify`/`reconcile`; provide clear blocked stubs for mutation commands rather than success mocks.
5. Add target/policy/origin/ownership checks, local journal/approval data contracts, redacted logging, offline tests T01–T07, and concise CLI/setup documentation.
6. CI builds and runs offline tests only; record actual commands/results in the PR, list unrun integrations, and keep tenant/private evidence out of commits.
**Gate G1 / done:** a synthetic spec plus complete snapshot produces a reproducible draft/non-approvable plan; incomplete evidence is explicit; live reads are scoped or honestly blocked; every write/invoke/package operation remains blocked, with no generic HTTP escape.

### Phase 2 — update one existing expression, experimentally

Enable only the proven lifecycle for changing the source of one existing owned sandbox Function; no create, signature change, connectors, automated triggers, or delete.
Require G0 identity/protocol evidence, explicit experimental-risk approval, expected-state/concurrency checks, before-state capture, and the approved immutable plan.
Prove a valid edit, invalid-source rejection behavior, server-derived-state recomputation, complete graph read-back, native designer interoperability, and interrupted-operation reconciliation (T06, T08–T11).
**Gate G2 / done:** the exact update profile passes recorded sandbox tests; unsupported cases remain blocked; no claim of production support or universal update semantics.

### Phase 3 — create one native Function from scratch

Enable creation only when the native compile/register/parameter/solution-association sequence is proven; ordinary Custom API CRUD alone does not satisfy this gate. [S8]
Limit to the unbound primitive no-connector profile; prove duplicate avoidance, desired-state no-op, identity/read-back, and separate explicitly approved invocation tests (T10–T12).
**Gate G3 / done:** a new native Function is usable in the designer and passes the approved runtime case; uncertain creates reconcile without duplicate creation; generic retirement stays blocked.

### Phase 4 — one automated registration profile

Add one verified message/table/stage combination and its proven context/filtering/mode/order semantics; do not infer support for every Create/Update/Delete pre/post combination.
Prove registration effectiveness with isolated explicit event tests, supported filters, recursion control, caller behavior, and editor interoperability; retain all effects and cleanup limitations (T13).
**Gate G4 / done:** the selected profile works end-to-end with bounded effects; untested combinations and lifecycle mutations remain blocked.

### Phase 5 — separate ALM, lifecycle, service-principal, and connector gates

Treat solution round-trip/upgrade/removal, supported retirement/recovery, application-user authentication, and connector behavior as independent capabilities, not one broad “production ready” switch.
Use normal solution ALM only after native component export/import behavior is tested; prove dependency ordering and removal rather than hand-authoring opaque package content (T14–T15).
Obtain documentation or written Microsoft support confirmation before calling any native deployment capability supported; a private endpoint or opaque requirement stops that capability.
**Gate G5 / done:** each enabled capability has its own evidence, acceptance tests, supportability status, permission model, and operational limits; production remains blocked under this preview policy.
A future `SKILL.md` or UI may call the stable adapter only after its contract and gates are proven; UI editing is parse/check/suggest-only until explicit execution approval. [S15][S16]

## 12. Acceptance criteria and completion mapping

| Acceptance ID | Requirement to demonstrate | Gate / tests |
| --- | --- | --- |
| AC01 | Evidence classes and unknowns are preserved; no guessed native protocol or claimed support | G0; E01–E18, U01–U08 |
| AC02 | First PR is useful offline/read-only and every mutation path is blocked | G1; T01–T07 |
| AC03 | Strict neutral contracts preserve source, types, names, dialect, and locale | G1; T01–T03, T11 |
| AC04 | Deterministic semantic ID, exact plan hash/approval, TTL, drift, and no-op rules work | G1–G3; T02, T06, T10 |
| AC05 | Authenticated target, sandbox classification, ownership, audience/origin and production blocks hold | G1–G5; T04–T07 |
| AC06 | Complete read-back proves source, bindings, registration, dependencies, and solution graph | G2–G4; T03, T09–T13 |
| AC07 | Writes are journaled and uncertain outcomes reconcile without blind retry or false atomicity | G2–G3; T06, T08–T10 |
| AC08 | Minimal update, then Function creation, then automated capability pass separately | G2, G3, G4; T08–T13 |
| AC09 | ALM/removal/app-user/connector support is independently proven or explicitly blocked | G5; T14–T15 |
| AC10 | No generated-field guessing, automatic business execution, generic delete, settings changes, or managed Accelerator edits | All gates; negative policy/contract tests |
| AC11 | Native lifecycle experiments and Microsoft supportability are reported separately; no production override exists | All gates; evidence review plus T04/T06 |
| AC12 | Build/test results are actual, unrun tests are labeled, private content is excluded, and adapter is reusable without UI/LLM | G1 onward; PR review and executed CI |

Completion is per phase: do not present Phase 1 as deployment support, and do not delay its delivery waiting for an unproven authoring protocol.
If discovery fails, the correct working product is a deterministic inspector/validator/planner with explicit blockers, not a speculative native deployment engine.

## 13. Source register

References below identify the supplied public documents/source paths; update dates are supplied evidence, not a claim that pages were re-fetched for this handoff.

- **[S1] Dataverse functions (preview)** — Functions overview; updated 2025-04-30. https://learn.microsoft.com/en-us/power-apps/maker/data-platform/functions-overview
- **[S2] Low-code plug-ins** — updated 2026-05-08. https://learn.microsoft.com/en-us/power-apps/maker/data-platform/low-code-plug-ins
- **[S3] Dataverse Accelerator** — updated 2026-02-23. https://learn.microsoft.com/en-us/power-apps/maker/data-platform/dataverse-accelerator/dataverse-accelerator
- **[S4] FxExpression table/entity reference** — updated 2026-09-18; published schema, not a lifecycle contract. https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/fxexpression
- **[S5] Function (msdyn_function) table/entity reference** — published schema. https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/msdyn_function
- **[S6] Plugin (plugin) table/entity reference** — published schema. https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/plugin
- **[S7] Power Fx Rule (powerfxrule) table/entity reference** — published schema. https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/powerfxrule
- **[S8] Create a custom API with code** — updated 2025-06-20. https://learn.microsoft.com/en-us/power-apps/developer/data-platform/create-custom-api-with-code
- **[S9] Invoke Dataverse functions (preview)** — updated 2026-08-13. https://learn.microsoft.com/en-us/power-apps/maker/data-platform/functions-invoke
- **[S10] Create Dataverse functions (preview)** — updated 2025-02-24. https://learn.microsoft.com/en-us/power-apps/maker/data-platform/functions-create
- **[S11] Tips and known issues with low-code plug-ins** — updated 2025-02-14. https://learn.microsoft.com/en-us/power-apps/maker/data-platform/low-code-plug-ins-tips
- **[S12] Microsoft Power Platform CLI power-fx command group** — updated 2026-02-25. https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/power-fx
- **[S13] microsoft/Power-Fx — Discussion #2371** — design proposal dated 2024-05-04, not a shipped contract. https://github.com/microsoft/Power-Fx/discussions/2371
- **[S14] microsoft/Power-Fx-Dataverse** — interpreter/binding source repository; partial research, no complete native authoring contract established. https://github.com/microsoft/Power-Fx-Dataverse
- **[S15] microsoft/power-fx-host-samples — Samples/WebDemo/README.md** — sample architecture. https://github.com/microsoft/power-fx-host-samples/blob/main/Samples/WebDemo/README.md
- **[S16] microsoft/power-fx-host-samples — Samples/WebDemo/ClientApp/src/PowerFxDemoPage.tsx** — source exhibiting evaluation on change. https://github.com/microsoft/power-fx-host-samples/blob/main/Samples/WebDemo/ClientApp/src/PowerFxDemoPage.tsx
- **[S17] Supported Power Fx functions for Dataverse functions** — host-specific reference; reconcile differences, do not assume parity. https://learn.microsoft.com/en-us/power-apps/maker/data-platform/functions-supported-power-fx
- **[S18] Power Fx functions supported by low-code plug-ins** — host-specific reference. https://learn.microsoft.com/en-us/power-apps/maker/data-platform/low-code-plug-ins-powerfx
- **[S19] Formula reference — Dataverse plug-ins** — Power Fx reference with a distinct scope. https://learn.microsoft.com/en-us/power-platform/power-fx/formula-reference-plug-ins
- **[S20] .NET support policy** — supplied as checked on 2026-10-15: .NET 10 active LTS, release 2025-11-11, support ends 2028-11-14; .NET 8/9 support ends 2026-11-10. https://dotnet.microsoft.com/en-us/platform/support/policy

**Handoff instruction:** implement Phase 1, keep native writes fail-closed, and report the next smallest missing proof needed for Phase 2. Do not build a UI, skill, substitute runtime, or speculative deployment protocol.
