# Command reference

Executable: `dataverse-plugins-native` after `npm install --global dataverse-plugins-native@0.1.0`, or use
`npx -y dataverse-plugins-native@0.1.0 <command>` without a global install. For source development, build then run
`npm run dataverse-plugins-native -- <command>`. Workflow and skill commands accept `--json`: stdout is then exactly one JSON object,
and errors are returned as `{ "error": "…" }`. Help/version are text and `ui` does not accept `--json`.
`<command> --help` shows one command. Only `ui` starts a persistent local server.

| Step | Command | What it does | Exit |
| --- | --- | --- | --- |
| 1 | `new --kind instant\|automated --out <file> [settings]` | Writes a starter spec with the settings applied. Never overwrites. | 0 / 3 |
| 1 | `set --spec <file> [settings]` | Applies settings to an existing spec (atomic replace). Invalid option values leave the file untouched. | 0 / 3 |
| 2 | `check --spec <file>` | Strict spec rules + offline Power Fx syntax check. Does not evaluate the formula. | 0 pass / 3 errors |
| 3 | `login [--select-account]` | Browser sign-in; the account is remembered as a profile and becomes active. `--select-account` shows the account picker to add another account. | 0 / 3 |
| 3 | `envs [--profile <username\|id>]` | Lists remembered profiles and the Dataverse environments (with type) from the Power Platform API. `--profile` switches the active profile. Signs in first if there is no profile. | 0 / 3 |
| 4 | `deploy --spec <file> --environment <url\|name\|id> [--profile …]` | check → environment must be listed (exactly one match) → (automated) resolve message id and existing step via Web API FetchXML → build and pack the solution → `ImportSolutionAsync` + poll → maker portal link to the solution. | 0 / 2 blocked / 3 failed |
| – | `ui [--port <n>] [--open]` | The same steps in a localhost-only browser UI. | 0 on stop |
| – | `skill install [options]` | Copy all bundled skill assets; refuse existing installs unless `--backup` is explicit. | 0 / 3 |
| – | `skill status [options]` | Exact destinations, state/version, changed/extra files, running CLI version and executable on PATH. | 0 / 3 |
| – | `skill update [options]` | Use this CLI package's skill version; protect modifications, retain a full sibling backup. | 0 / 3 |
| – | `skill uninstall [options]` | Remove unchanged managed files only; preserve unrelated content and backups. | 0 / 3 |
| – | `--version` | Running package version. | 0 |
| – | `--help`, `help <command>`, `<command> --help` | General or command-specific usage. | 0 |

Skill options: `--target shared|codex|claude|vscode|opencode|all` (default `shared`),
`--project <directory>` (explicit project scope), `--json`, and `--backup` (install/update only).
Without project scope, destinations are under your home directory, not the current project.
See [distribution](distribution.md) for paths, source documentation, backup/manifest behaviour and release instructions.
`ui` port range is 0–65535; 0 (the default) chooses a free port. Startup errors return 3.

`new` and `set` print the check result too, so mistakes show up immediately; they still exit `0` when the file was
written.

If the active profile's saved sign-in has expired, `envs` and `deploy` re-open the browser once (with the account
pre-filled) and retry.

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

## Spec: `dataverse-plugins-native.plugin/v1`

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

## Local UI API (`dataverse-plugins-native ui`)

For the bundled UI only. Every endpoint requires the `X-Dataverse-Plugins-Native-Session` header plus an allowed `Host`; errors are
`{ "error": "…" }`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/examples/<name>` | Content of `instant.plugin.json` or `automated.plugin.json`. |
| `GET /api/studio/meta` | Tool version, parameter types, trigger messages/stages, example names. |
| `POST /api/studio/check` | `{ "spec" }` → `{ ok, issues }`. Offline. |
| `GET /api/studio/session` | `{ state: signed-out\|pending\|signed-in, active?, profiles[], authorizeUrl?, error? }`; profiles carry `needsReauth`. Never contains tokens. |
| `POST /api/studio/login` · `POST /api/studio/login/cancel` | `{ selectAccount?, reconnect? }` starts a browser sign-in (opened by the server; `authorizeUrl` is the fallback link). `{}` cancels. |
| `POST /api/studio/profiles/select` · `POST /api/studio/profiles/remove` | `{ id }` switches the active profile / forgets a profile. |
| `GET /api/studio/environments` | `{ environments }`, or `{ environments: [], error, signInRequired }`. |
| `POST /api/studio/deploy` · `GET /api/studio/deploy` | `{ "spec", "environmentUrl", "confirmEnvironmentUrl" }`; both URLs must match exactly. Starts in the background (202, 409 while one is running); poll `GET` for `{ running, steps, result? }`. |
