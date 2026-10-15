# Command reference

Executable: `dv-native` (`node dist/src/cli/main.js`). Every command except `ui` accepts `--json`: stdout is then
exactly one JSON object, and errors are returned as `{ "error": "…" }`. `<command> --help` shows one command.

| Step | Command | What it does | Exit |
| --- | --- | --- | --- |
| 1 | `new --kind instant\|automated --out <file> [settings]` | Writes a starter spec with the settings applied. Never overwrites. | 0 / 3 |
| 1 | `set --spec <file> [settings]` | Applies settings to an existing spec (atomic replace). Invalid option values leave the file untouched. | 0 / 3 |
| 2 | `check --spec <file>` | Strict spec rules + offline Power Fx syntax check. Does not evaluate the formula. | 0 pass / 3 errors |
| 3 | `login` | `pac auth create` (browser sign-in by the user). | 0 / 3 |
| 3 | `envs [--select <index>]` | `pac auth list` + `pac env list`. `--select` runs `pac auth select --index` first. | 0 / 3 |
| 4 | `deploy --spec <file> --environment <url\|name\|id>` | check → environment must be listed by `pac env list` (exactly one match) → (automated) resolve message id and existing step via `pac env fetch` → build solution → `pac solution pack` → `pac solution import`. | 0 / 2 blocked / 3 failed |
| – | `ui [--port <n>] [--open]` | The same steps in a localhost-only browser UI. | 0 on stop |

`new` and `set` print the check result too, so mistakes show up immediately; they still exit `0` when the file was
written.

## Settings (`new` / `set`)

| Option | Sets |
| --- | --- |
| `--formula-file <path>` | `formula` ← content of a Power Fx script file (UTF-8; BOM stripped, line endings → LF) |
| `--name <name>` | `uniqueName`; the publisher prefix is added when missing (`Fee` → `contoso_Fee`) |
| `--display-name`, `--description` | `displayName`, `description` |
| `--params <list>` | instant only: `Name:input\|output:Boolean\|DateTime\|Decimal\|Float\|Integer\|String`, comma separated, or `none` |
| `--trigger-table`, `--message`, `--stage` | automated only: `trigger.table`, `trigger.message` (`Create\|Update\|Delete`), `trigger.stage` (`preOperation\|postOperation`) |
| `--tables <list>` | tables the formula reads/writes: logical names, comma separated, or `none` |
| `--solution`, `--solution-display-name`, `--solution-version` | `solution.uniqueName`, `.displayName`, `.version` |
| `--publisher`, `--publisher-display-name` | `solution.publisher.uniqueName`, `.displayName` |
| `--prefix` | `solution.publisher.prefix`; also renames `uniqueName` if it used the old prefix |
| `--option-value-prefix <n>` | `solution.publisher.optionValuePrefix` (10000–99999) |

Solution and publisher settings are applied before `--name`, so `--prefix` and `--name` can be combined in one call.

## Spec: `dv-native.plugin/v1`

| Field | Instant | Automated |
| --- | --- | --- |
| `kind` | `instant` | `automated` |
| `uniqueName` | `<prefix>_Name` | `<prefix>_Name` |
| `displayName`, `description?` | ✓ | ✓ |
| `solution` | `{ uniqueName, displayName?, version?, publisher: { uniqueName, displayName?, prefix, optionValuePrefix } }` | same |
| `parameters` | required (may be empty): `{ name, direction: input\|output, type }` | not allowed |
| `trigger` | not allowed | `{ table, message: Create\|Update\|Delete, stage: preOperation\|postOperation }` |
| `tables` | logical names used by the formula | same (trigger table is added automatically) |
| `formula` | Power Fx; return outputs as `{ Out: ... }` | Power Fx; read the row via `NewRecord` / `OldRecord` |

Generated solution layout (matches Microsoft's published contoso-real-estate-power-platform sample):
`fxexpressions/<name>/fxexpression.json` + `expression.yaml`; instant adds `customapis/<name>/…` (bound to the
`Microsoft.PowerFx.Evaluator` plug-in type); automated adds `SdkMessageProcessingSteps/{id}.xml` with a stable id so a
redeploy updates the same step.

What deploy does **not** do: publish all customizations, activate other plug-ins/workflows, delete anything, or change
environment settings. Import is unmanaged and additive.

## Local UI API (`dv-native ui`)

For the bundled UI only. Every endpoint requires the `X-DV-Session` header plus an allowed `Host`; errors are
`{ "error": "…" }`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/examples/<name>` | Content of `instant.plugin.json` or `automated.plugin.json`. |
| `GET /api/studio/meta` | Tool version, parameter types, trigger messages/stages, example names. |
| `POST /api/studio/check` | `{ "spec" }` → `{ ok, issues }`. Offline. |
| `GET /api/studio/profiles` · `POST /api/studio/login` · `POST /api/studio/select` | pac profiles, `pac auth create`, `pac auth select { index }`. |
| `GET /api/studio/environments` | `pac env list`. |
| `POST /api/studio/deploy` | `{ "spec", "environmentUrl", "confirmEnvironmentUrl" }`; both URLs must match exactly. pac calls are serialized (409 while busy). |
