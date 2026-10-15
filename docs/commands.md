# Command reference

Executable: `dv-native` (`node dist/src/cli/main.js`).

## The four-step flow

Sign-in, environment discovery, FetchXML lookups, packing and import all go through the Power Platform CLI (`pac`),
spawned without a shell and with fixed argument arrays. dv-native never sees or stores a token.

| Step | Command | What it does | Exit |
| --- | --- | --- | --- |
| 1 | `new --kind instant\|automated --out <file>` | Writes a starter `dv-native.plugin/v1` spec. Never overwrites. | 0 / 3 |
| 2 | `check --spec <file> [--json]` | Strict spec rules + offline Power Fx syntax check (brackets, strings, comments, operator sequences, unused inputs, unassigned outputs, unsupported functions). Does not evaluate the formula. | 0 pass / 3 errors |
| 3 | `login` | `pac auth create` (browser sign-in). | 0 / 3 |
| 3 | `envs [--select <index>] [--json]` | `pac auth list` + `pac env list`. `--select` runs `pac auth select --index`. | 0 / 3 |
| 4 | `deploy --spec <file> --environment <url> [--json]` | check → environment must be listed by `pac env list` → (automated) resolve message id and existing step via `pac env fetch` → build unpacked solution → `pac solution pack` → `pac solution import`. | 0 / 2 blocked / 3 failed |
| – | `build --spec <file> --out <new folder>` | Same solution build without importing, for review. Automated Delete triggers need `deploy` (message id is resolved from the environment). | 0 / 2 / 3 |
| – | `ui [--port <n>] [--open]` | The same four steps in a localhost-only browser UI. | 0 on stop |

What deploy does **not** do: publish all customizations, activate other plug-ins/workflows, delete anything, or change
environment settings. Import is unmanaged and additive.

### Spec: `dv-native.plugin/v1`

| Field | Instant | Automated |
| --- | --- | --- |
| `kind` | `instant` | `automated` |
| `uniqueName` | `<prefix>_Name` | `<prefix>_Name` |
| `displayName`, `description?` | ✓ | ✓ |
| `solution` | `{ uniqueName, displayName?, version?, publisher: { uniqueName, displayName?, prefix, optionValuePrefix } }` | same |
| `parameters` | required (may be empty): `{ name, direction: input\|output, type: Boolean\|DateTime\|Decimal\|Float\|Integer\|String }` | not allowed |
| `trigger` | not allowed | `{ table, message: Create\|Update\|Delete, stage: preOperation\|postOperation }` |
| `tables` | logical names used by the formula | same (trigger table is added automatically) |
| `formula` | Power Fx; return outputs as `{ Out: ... }` | Power Fx; read the row via `NewRecord` / `OldRecord` |

Generated solution layout (matches Microsoft's published contoso-real-estate-power-platform sample):
`fxexpressions/<name>/fxexpression.json` + `expression.yaml`; instant adds `customapis/<name>/…` (bound to the
`Microsoft.PowerFx.Evaluator` plug-in type); automated adds `SdkMessageProcessingSteps/{id}.xml` with a stable id so a
redeploy updates the same step.

## Advanced: offline planning commands (read-only)

Every command below accepts `--json`; JSON mode writes exactly one
`adapter.result/v1` object to stdout. Non-info diagnostics are written to stderr as redacted JSON lines.
Unknown options, duplicates, positional arguments, and missing values fail with exit `3`. There is no force/override option.

| Command | Options | Phase 1 behavior | Typical exit |
| --- | --- | --- | --- |
| `validate` | `--spec` (req), `--target`, `--offline` | Schema + policy (+ ownership if `--target`). With `--offline`, metadata is `skipped`; without it, metadata is requested and blocked. Host validation is always `unknown`. | 0 offline / 2 live / 3 invalid |
| `plan` | `--spec` (req), `--snapshot`, `--target`, `--out` | Deterministic draft plan; `--out` writes a new private file (never overwrites). Snapshot/target identity mismatch blocks. | 0 / 2 / 3 |
| `inspect` | `--snapshot` and/or `--target` | `--snapshot`: offline summary (hashes only). `--target` alone: live inspection, blocked. Both: snapshot cross-checked against target. | 0 / 2 |
| `verify` | `--spec` (req), `--snapshot`, `--target` | Informational comparison; read-back is `unknown` without live graph reads, so never succeeds. | 2 |
| `apply` | `--plan` (req), `--approval` | Verifies plan integrity, fingerprints, and approval; always blocked; dispatches nothing. | 2 / 3 |
| `approve` | `--plan` (req) | Refuses draft/ineligible plans; issues nothing. | 2 |
| `reconcile` | `--journal` (req), `--snapshot` | Read-only journal analysis; never retries or repairs. Journaled completions cap at `blocked` without live read-back. | 0 (empty) / 2 / 3 / 4 / 5 |
| `test` | — | Blocked: `INVOCATION_REQUIRES_SEPARATE_TEST_GATE`. | 2 |
| `package export` / `package import` | — | Blocked: not enabled (Phase 5). | 2 |
| `recover` | — | Blocked: `RECOVERY_PROTOCOL_UNVERIFIED`. | 2 |
| `retire` | — | Blocked: `GENERIC_DELETE_DISABLED`, `DEACTIVATION_PROFILE_UNVERIFIED`. | 2 |
| `ui` | `--port <number>`, `--open` | Starts the localhost-only browser UI (random port by default) until Ctrl+C. It hosts the same operations; every gated operation stays blocked. | 0 on stop / 3 on bad port or start failure |

Status precedence: `outcome_unknown` > `partial` > `failed` > `blocked` > `succeeded`.

## Local UI API (`dv-native ui`)

The API is for the bundled UI only, and every endpoint requires the `X-DV-Session` header plus an allowed `Host`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/meta` | Tool version, the operations table (required/optional documents), the capability registry, and example names. |
| `GET /api/examples/<name>` | Content of one allowlisted synthetic example. |
| `POST /api/run` | Body `{ "operation", "documents": { spec?, target?, snapshot?, plan?, approval?, journal? }, "offline"? }` (strict JSON, unknown fields rejected). Returns `adapter.result/v1`. |
| `GET /api/studio/meta` | Parameter types, trigger messages/stages, plug-in example names. |
| `POST /api/studio/check` | `{ "spec" }` → `{ ok, issues }`. Offline. |
| `GET /api/studio/profiles` · `POST /api/studio/login` · `POST /api/studio/select` | pac profiles, `pac auth create`, `pac auth select { index }`. |
| `GET /api/studio/environments` | `pac env list`. |
| `POST /api/studio/deploy` | `{ "spec", "environmentUrl", "confirmEnvironmentUrl" }`; both URLs must match exactly. pac calls are serialized (409 while busy). |

## Contracts

| Contract | Schema | Notes |
| --- | --- | --- |
| `adapter.spec/v1` | `src/contracts/spec.ts` | Neutral Function spec (§4). Example: `examples/calculation.spec.json`. |
| `adapter.target/v1` | `src/contracts/target.ts` | Private target expectations (§5). Template: `examples/target.template.json` (intentionally fails validation until placeholders are replaced in a private, git-ignored copy). |
| `adapter.snapshot/v1` | `src/contracts/snapshot.ts` | Observed-state projection with identity, `acquiredAt`, completeness, projection version, evidence fingerprints. Formula by hash only. |
| `adapter.plan/v1` | `src/contracts/plan.ts` | Draft plan; `planId` = semantic hash, `planHash` = whole-plan hash excluding itself. No timestamps inside. |
| `adapter.approval/v1` | `src/contracts/approval.ts` | Detached envelope binding `planHash`, target, operations/effects, approver, principal, issuance/expiry; `approvalHash` over all fields. |
| `adapter.journal/v1`, `adapter.lease/v1` | `src/contracts/journal.ts` | Identifiers, hashes, and concurrency values only — never code bodies. |
| `adapter.result/v1` | `src/contracts/result.ts` | Stable result envelope with `runId`, `generatedAt`, fingerprints, validation phases, per-operation outcomes. |

## Snapshot authoring note

`snapshot.components[].formula.sha256` is the SHA-256 (lowercase hex, UTF-8) of the formula source after the declared
normalization (`lf` = CRLF/CR → LF; `none` = exact bytes). Compute it with the library:

```powershell
node -e "import('./dist/src/index.js').then(m => console.log(m.sha256Hex(m.normalizeFormulaSource('Amount * Rate', 'lf'))))"
```
