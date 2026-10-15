# dv-native — build and deploy Dataverse low-code plug-ins

A small CLI and local UI for **instant** plug-ins (Dataverse Functions) and **automated** plug-ins (table events),
written in Power Fx. Four steps:

1. **Create / load** a plug-in spec (`dv-native.plugin/v1`).
2. **Check** the spec and the Power Fx syntax offline.
3. **Select an environment** — sign-in and environment discovery use the Power Platform CLI (`pac`).
4. **Deploy** — dv-native builds a solution, `pac solution pack`s it and `pac solution import`s it.

> **Status:** preview tooling for a preview feature. The solution layout follows Microsoft's published
> contoso-real-estate-power-platform sample and packs with the real SolutionPackager, but import into a live
> environment has **not yet been verified** (see [What is verified](#what-is-verified)). Try a sandbox first.

## Quick start

Requires Node.js ≥ 22.12 and the [Power Platform CLI](https://aka.ms/PowerPlatformCLI) (`pac`) on PATH.
No runtime npm dependencies.

```powershell
npm install; npm run build
node dist/src/cli/main.js ui --open          # the four steps in your browser

# or the same from the command line
node dist/src/cli/main.js new --kind automated --out private/mine.plugin.json
node dist/src/cli/main.js check --spec private/mine.plugin.json
node dist/src/cli/main.js login              # pac auth create (browser sign-in)
node dist/src/cli/main.js envs               # pac profiles + environments
node dist/src/cli/main.js deploy --spec private/mine.plugin.json --environment https://yourorg.crm.dynamics.com/
```

Exit codes: `0` succeeded · `2` blocked · `3` failed / invalid input. Full reference: [docs/commands.md](docs/commands.md).

## Authentication

dv-native never handles tokens. Every Dataverse interaction is a `pac` command (`auth create/list/select`,
`env list`, `env fetch`, `solution pack/import`) spawned without a shell, with fixed arguments and validated values
(environment URLs must be Dataverse https hosts). Your existing `pac auth` profiles are reused.

## What deploy does

- Instant: `fxexpressions/<name>` + `customapis/<name>` (parameters as Custom API request parameters / response
  properties, bound to the `Microsoft.PowerFx.Evaluator` plug-in type).
- Automated: `fxexpressions/<name>` + `SdkMessageProcessingSteps/{id}.xml` (Create/Update/Delete, pre- or
  post-operation, synchronous). The step id is reused from the environment if one already exists for the expression,
  otherwise derived from the unique name, so redeploys update in place instead of adding duplicate triggers.
- Unmanaged, additive import into the solution named in the spec. It does **not** publish all customizations, activate
  other plug-ins/workflows, or delete anything.

## What is verified

| Item | Evidence |
| --- | --- |
| Component layout (`fxexpression.json`, `customapi.xml`, step XML, parameter type codes) | Matches Microsoft's public contoso-real-estate-power-platform solution source |
| `pac solution pack` accepts the generated folder and keeps all components | Run locally with pac 2.13.1 |
| pac output parsing (`auth list`, `env list`) | Against real pac 2.13.1 output |
| `pac env fetch` output parsing, live import, server-side compile of the expression | **Unverified** — needs one sandbox run |
| Environment type | Shown when `pac env list` prints it, otherwise `Unknown`; informational only |

The offline formula check is syntax-only (brackets, strings, comments, operators, parameter usage). It does not
evaluate anything; the environment compiles the formula during import.

## Advanced: offline planning (Phase 1 adapter)

The original read-only adapter (`validate`, `plan`, `inspect`, `verify`, `apply`, … over `adapter.spec/v1`) is still
available from the CLI for offline drift planning; its native writes remain blocked. See
[docs/commands.md](docs/commands.md#advanced-offline-planning-commands-read-only).

## Phase 1 adapter details

| Capability | State |
| --- | --- |
| Strict spec/target/snapshot/plan/approval/journal/result contracts (duplicate keys, unknown fields, non-integer numbers rejected) | Working, offline |
| Source normalization (declared LF only), adapter.c14n/v1 canonical JSON, SHA-256 spec/source hashing | Working, golden-tested |
| Offline validation against the MVP profile `function.unbound.decimal/v1` | Working |
| Deterministic intent diff + semantic `planId` + immutable `planHash` | Working, reproducible |
| Plan-integrity and approval-envelope verification (hash, target, exact op set/effects, TTL ≤ 30 min, principal) | Working; Phase 1 plans always refused and approver attestation is unverified (fails closed) |
| Target/origin/ownership/classification policy (production + unknown hard-blocked) | Working |
| Trust-boundary read transport (single origin, no redirects, nextLinks bound to the original collection, bounded streaming, bounded retries, audience/tenant checks) | Implemented + fake-tested; **not wired to the CLI** (no approved client ID / token provider yet) |
| Local journal (atomic writes, integrity), single-writer lease, read-only `reconcile` | Working |
| `apply`, `approve`, `test`, `package export/import`, `recover`, `retire` | **Blocked stubs** — never dispatch |

## Phase 1 quick start

Requires Node.js ≥ 22.12 (see [docs/decisions.md](docs/decisions.md) D01–D02). No runtime npm dependencies.

```powershell
npm install          # dev-only: typescript, @types/node
npm test             # builds and runs offline unit + contract tests
node dist/src/cli/main.js --help
```

Offline walkthrough with synthetic examples:

```powershell
# 1. Validate (explicit offline scope; host validation stays unknown)
node dist/src/cli/main.js validate --spec examples/calculation.spec.json --offline --json

# 2. Plan against a converged snapshot -> no-op (convergence still unverified)
node dist/src/cli/main.js plan --spec examples/calculation.spec.json --snapshot examples/converged.snapshot.json --target examples/synthetic.target.json

# 3. Plan against a drifted snapshot -> blocked update.source + update.metadata intent operations
New-Item -ItemType Directory -Force private | Out-Null   # git-ignored private artifacts
node dist/src/cli/main.js plan --spec examples/calculation.spec.json --snapshot examples/drifted.snapshot.json --target examples/synthetic.target.json --out private/plan.json

# 4. Apply is always blocked (exit 2); nothing is dispatched
node dist/src/cli/main.js apply --plan private/plan.json --json
```

Exit codes: `0` succeeded · `2` blocked · `3` failed / invalid input · `4` partial · `5` outcome_unknown.
`plan` succeeding means a plan was produced, not that it is deployable.

## Local UI

```powershell
npm run ui                                   # builds, starts the UI and opens your browser
node dist/src/cli/main.js ui [--port 4873] [--open]
```

The command prints a one-time session link (`http://127.0.0.1:<port>/?session=…`). Open it, and press Ctrl+C in the
terminal to stop. The UI has four steps:

1. **Function** — new instant/automated, open or save a spec file, load an example; form for names, parameters or
   trigger, tables, formula and solution/publisher.
2. **Check** — runs automatically as you type; errors show line/column and jump to the formula.
3. **Environment** — pac profiles (switch or sign in) and environments with their type.
4. **Deploy** — summary, confirmation dialog, then the per-step result (check, environment, resolve, pack, import).

Security model: the server binds to `127.0.0.1` only. Every API call needs the per-session token, a matching `Host`
header (protection against DNS rebinding) and a same-origin `Origin`. It applies a strict CSP, serves only an allowlist
of static files and examples, and never reads user-supplied paths. Bodies are size-bounded and are not logged or
persisted. pac calls are serialized, and deploy requires the environment URL to be confirmed. The previous
document-oriented UI is kept, unserved, in `ui/legacy/`.

## Layout

```text
src/studio/      the four-step flow: plug-in spec, Power Fx syntax check, solution builder, pac wrapper, deploy
src/contracts/   Phase 1 versioned schemas + types, reason codes, capability registry
src/core/        strict JSON, canonicalization/hashing, validators, policy gates, planner, approval, verifier, reconcile, journal, lease, redaction
src/app/         Phase 1 operations layer (document text in, adapter.result/v1 out)
src/dataverse/   Phase 1 trust-boundary read transport, target resolver, BlockedNativeProvider
src/cli/         argument parsing and output (studio.ts = four-step commands)
src/ui/          localhost-only UI server (token, Host/Origin checks, CSP, allowlists)
ui/              browser client: vanilla HTML/CSS/JS, no build step, no third-party code
tests/unit/      deterministic tests, incl. studio.test.ts (fake pac, no process spawned)
tests/contract/  fake transport, CLI contract, and UI server security tests
examples/        synthetic, commit-safe fixtures (*.plugin.json for the four-step flow)
docs/            decisions, evidence/capability matrix, command reference
```

## Safety rules enforced in code

- Deploy is refused for environments not listed by the active pac profile and for specs with check errors. Automated
  deploys fail closed if more than one existing step is linked
  to the expression.
- pac is spawned without a shell; environment URLs, names and FetchXML values are validated or XML-escaped first.
- Spec files and plan files are only written to new files (`wx`); existing files are never overwritten.

Phase 1 adapter (advanced commands):

- No `--force`, environment variable, or config switch can enable Phase 1 writes; unknown CLI options fail (exit 3).
- Offline environment classification is never trusted; effective classification is always `unknown` in Phase 1.
- Snapshot "not found" only means `absent` when the snapshot is complete **and** in scope; otherwise `unknown` (no create).
- Formula bodies are represented by SHA-256 only in plans, results, and logs; stderr is redacted.
- Private targets, plans, journals, snapshots, and captures are git-ignored (see [.gitignore](.gitignore)).

## Next step

One deploy of each example (`examples/instant.plugin.json`, `examples/automated.plugin.json`, with your publisher)
to an owned sandbox, then confirm in the maker portal that the Function / automated plug-in appears, runs, and that a
second deploy updates rather than duplicates it.
