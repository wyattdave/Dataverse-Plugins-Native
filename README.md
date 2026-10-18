# Dataverse Plug-ins Native

**Build, check and deploy Dataverse low-code plug-ins with Power Fx — from your terminal, AI agent, or browser.**

Create **instant plug-ins (Dataverse Functions / Custom APIs)** and **automated plug-ins (table events)**.
The `dataverse-plugins-native` CLI builds the solution, packs it, and imports it through the Dataverse Web API. No Power Platform CLI,
app registration, client secret, executable installer, or runtime npm dependencies.

> Preview tooling for a preview feature. Start with a sandbox. The offline check validates syntax, not execution;
> Dataverse compiles your formula during import. Deployment changes a real environment and requires appropriate
> Dataverse solution-import privileges.

## Choose how to use it

Requires **Node.js >= 22.12**, **npm with npx** (npm 10+ recommended), and registry access for package downloads.
Sign-in and deployment also require a browser, a Microsoft work account and access to Microsoft Entra,
Power Platform and your Dataverse environment. Windows, macOS and Linux are supported; no admin rights are needed
for skill installation or on-demand CLI use.

| Mode | Command | What stays installed |
| --- | --- | --- |
| Skill only | `npx -y dataverse-plugins-native@0.1.0 skill install` | Agent instructions in your home directory; no global CLI |
| On demand | `npx -y dataverse-plugins-native@0.1.0 --help` | No permanent CLI; npm may cache the package |
| Repeated CLI use | `npm install --global dataverse-plugins-native@0.1.0` | The `dataverse-plugins-native` executable on your npm PATH |

Installing the **skill** and installing the **CLI** are separate operations. The skill teaches your agent the workflow;
it checks for an installed CLI, prefers a project's own CLI when working on this repository, and otherwise uses a
version-pinned npx fallback. It never installs globally on your behalf.

All commands below use the executable from a global install. Without one, replace `dataverse-plugins-native` with
`npx -y dataverse-plugins-native@0.1.0`. npx downloads and executes this package when the requested version is not cached.

## Browser UI

```sh
npx -y dataverse-plugins-native@0.1.0 ui --open
```

The four-step UI lets you edit a function, check Power Fx, sign in and select an environment, then confirm deployment.
Load the bundled instant or automated examples, open/save spec JSON, and switch between light and dark mode.
The server binds only to `127.0.0.1`; keep its session link private. Stop it with **Ctrl+C**.
Use `ui --port 43817 --open` to choose a port (the default is a free random port).

### Instant function editor

![Instant function editor with input/output parameters, Power Fx formula and solution settings](https://raw.githubusercontent.com/wyattdave/LowCode-Plugins/main/docs/screenshots/instant-function.png)

### Automated table-event plug-in (dark mode)

![Automated plug-in editor with table, message and stage configuration in dark mode](https://raw.githubusercontent.com/wyattdave/LowCode-Plugins/main/docs/screenshots/automated-plugin.png)

### Offline check

![Offline syntax check showing a passing formula before choosing an environment](https://raw.githubusercontent.com/wyattdave/LowCode-Plugins/main/docs/screenshots/syntax-check.png)

Screenshots show bundled examples, not a live tenant. Images use absolute URLs so they also render on npm;
commit and push these assets before publishing.

## Install the agent skill

```sh
# Safe, non-interactive default: shared user-level .agents/skills
npx -y dataverse-plugins-native@0.1.0 skill install

# Explicit tool (or use --target all)
npx -y dataverse-plugins-native@0.1.0 skill install --target claude
npx -y dataverse-plugins-native@0.1.0 skill install --target vscode

# Share a skill with a project instead of installing in your home directory
npx -y dataverse-plugins-native@0.1.0 skill install --target codex --project .

# Inspect, replace from this package version, or remove
npx -y dataverse-plugins-native@0.1.0 skill status --target all --json
npx -y dataverse-plugins-native@0.1.0 skill update --target claude
npx -y dataverse-plugins-native@0.1.0 skill uninstall --target claude
```

Supported targets: `shared` (default), `codex`, `claude`, `vscode`, `opencode`, `all`.
The installed folder is always named `dataverse-plugins-native`:

| Target | User-level skill parent | With `--project <directory>` |
| --- | --- | --- |
| `shared`, `codex`, `opencode` | `~/.agents/skills` | `<directory>/.agents/skills` |
| `claude` | `~/.claude/skills` | `<directory>/.claude/skills` |
| `vscode` / GitHub Copilot | `~/.copilot/skills` | `<directory>/.github/skills` |
| `all` | The three distinct user-level parents above | The three distinct project-level parents above |

`~` means your actual home directory, including on Windows. The shared path is discovered by Codex, OpenCode and
VS Code; use the explicit Claude target for Claude Code. `all` deduplicates identical destinations; it does not guess
which tools you installed. Restart/reload your agent if the new skill does not appear.

**Existing skills are protected.** `install` refuses an existing directory. `update` replaces only a clean managed
installation unless you explicitly pass `--backup`. Every replacement keeps the entire old directory in a uniquely
named sibling backup and prints its exact path. The installer copies all nested assets, validates them and writes
a hash manifest. Uninstall refuses modified/missing managed files and leaves unrelated files and backups untouched.

```sh
npx -y dataverse-plugins-native@0.1.0 skill update --target claude --backup
```

`update` installs the skill bundled with the invoked CLI version; it does not query npm for the newest release.
To upgrade later, invoke the desired published version and run `skill update` again with the same target and scope.
See [distribution, compatibility sources and troubleshooting](https://github.com/wyattdave/LowCode-Plugins/blob/main/docs/distribution.md).

Then ask your agent, for example:

> Use dataverse-plugins-native to create an instant CalculateFee function with Amount and Rate decimal inputs and
> a Fee decimal output. Check it offline, then ask me which environment to deploy to.

## CLI quick start

Install once if you want a stable command:

```sh
npm install --global dataverse-plugins-native@0.1.0
dataverse-plugins-native --version
dataverse-plugins-native --help
```

Create `fee.fx` containing `{ Fee: Amount * Rate }` in your current folder, then run:

```sh
dataverse-plugins-native new --kind instant --out fee.plugin.json --prefix contoso --name CalculateFee --solution ContosoPlugins --publisher Contoso --params "Amount:input:Decimal,Rate:input:Decimal,Fee:output:Decimal" --formula-file fee.fx
dataverse-plugins-native check --spec fee.plugin.json
dataverse-plugins-native login
dataverse-plugins-native envs
dataverse-plugins-native deploy --spec fee.plugin.json --environment "Contoso Dev"
```

Use your own publisher and solution settings, matching any existing publisher exactly. `new` never overwrites a file.
After editing the script, apply it with `set` and check again:

```sh
dataverse-plugins-native set --spec fee.plugin.json --formula-file fee.fx
dataverse-plugins-native check --spec fee.plugin.json --json
```

For an automated plug-in, write `rule.fx` using `NewRecord` / `OldRecord`, then:

```sh
dataverse-plugins-native new --kind automated --out rule.plugin.json --prefix contoso --name AccountRule --solution ContosoPlugins --publisher Contoso --trigger-table account --message Create --stage preOperation --tables account --formula-file rule.fx
```

## All commands

| Command | Purpose / options |
| --- | --- |
| `new --kind instant\|automated --out <file> [settings]` | Create a spec with your settings and report its initial check. Never overwrite. |
| `set --spec <file> [settings]` | Update only supplied settings or load `--formula-file`; atomic replacement, invalid options leave the spec unchanged. |
| `check --spec <file>` | Offline spec and Power Fx syntax validation. Does not execute or fully type-check the formula. |
| `login [--select-account]` | Browser sign-in, remembered as a profile. Use the account picker to add another account. |
| `envs [--profile <username\|id>]` | List profiles and accessible environments with their types; optionally switch the active profile. Signs in if needed. |
| `deploy --spec <file> --environment <url\|name\|id> [--profile <username\|id>]` | Check, resolve the accessible environment, build/pack/import, and return a Power Apps solution link. Ambiguous names are blocked. |
| `ui [--port <0-65535>] [--open]` | Start the local browser UI. `0` chooses a free port; `--open` launches the browser. Ctrl+C stops it. |
| `skill install [options]` | Copy the complete packaged skill to the selected user/project directories. |
| `skill status [options]` | Report exact destinations, installed versions, modifications, the running CLI version and command discovery on PATH. Does not execute another detected CLI. |
| `skill update [options]` | Replace a managed skill with the version bundled in this CLI; keep a rollback backup. |
| `skill uninstall [options]` | Remove only unchanged installer-managed files; preserve unrelated content. |
| `--version` | Show the running package version. |
| `--help`, `help <command>`, `<command> --help` | Show general or command-specific usage. `skill --help` covers lifecycle options. |

Skill options: `--target <shared|codex|claude|vscode|opencode|all>`, `--project <directory>`, `--json`,
and `--backup` (install/update only).

All workflow and skill commands accept `--json`: stdout contains exactly one JSON object; errors are
`{ "error": "..." }`. Diagnostics, such as browser sign-in instructions, go to stderr.
Help/version are text; `ui` is an interactive long-running command and does not accept `--json`.
Exit codes: **0** success, **2** deployment blocked, **3** operational failure or invalid input.
`new`/`set` return 0 when they write the file, even if their included check reports issues.

### Settings for `new` and `set`

| Option | Meaning |
| --- | --- |
| `--formula-file <path>` | Read a UTF-8 Power Fx script (BOM stripped, LF line endings). |
| `--name <name>` | Unique name; add the publisher prefix if missing. |
| `--display-name <text>`, `--description <text>` | Plug-in display name and description. |
| `--params <list>` | Instant only: comma-separated `Name:input\|output:Boolean\|DateTime\|Decimal\|Float\|Integer\|String`, or `none`. Replaces all parameters. |
| `--trigger-table <logical-name>` | Automated plug-in's table. |
| `--message Create\|Update\|Delete` | Automated table event. |
| `--stage preOperation\|postOperation` | Run before or after the table operation (synchronous). |
| `--tables <list>` | Logical names the formula reads/writes, comma-separated, or `none`. The trigger table is included automatically. |
| `--solution <name>`, `--solution-display-name <text>`, `--solution-version <version>` | Target unmanaged solution; created if absent. |
| `--publisher <name>`, `--publisher-display-name <text>` | Solution publisher identity. |
| `--prefix <prefix>` | Publisher prefix; also renames the plug-in if it used the old prefix. |
| `--option-value-prefix <number>` | Publisher option value prefix, 10000–99999. |

Changing the name/prefix after deployment creates another plug-in rather than renaming the deployed one.
Full spec and UI API reference: [commands](https://github.com/wyattdave/LowCode-Plugins/blob/main/docs/commands.md).

## Authentication and deployment safety

- Browser authorization code + PKCE uses the Power Apps public client; no app registration or secret required.
  Accounts are remembered as profiles. Expired sign-ins reconnect once through the browser.
- Refresh tokens are stored under your home `.dataverse-plugins-native` directory: Windows DPAPI-encrypted `profiles.dat`,
  or owner-only `profiles.json` on macOS/Linux. Access tokens stay in memory; no tokens go to the UI page.
- Commercial Microsoft cloud only. Environment URLs are validated; deploy requires exactly one environment listed
  for the signed-in account and a spec without check errors.
- Instant plug-ins are packaged as expressions + Custom APIs; automated ones as expressions + synchronous
  Create/Update/Delete processing steps. Redeploy updates the existing step rather than duplicating it.
- Imports are **unmanaged and additive**. Deploy does not delete resources, publish all customizations, activate
  unrelated plug-ins/workflows, or change environment settings.
- The local UI uses a per-session token, same-origin checks, strict CSP and an allowlist of served files.
  Deploy requires environment confirmation.

## Updating and removing the global CLI

This preview uses the new package/command name only. Specs use `dataverse-plugins-native.plugin/v1`,
profiles live in `~/.dataverse-plugins-native`, and skill manifests are `.dataverse-plugins-native-install.json`.
If you used an earlier preview, sign in again and recreate its specs/skill installation with this CLI (preserve your
formulas and use `skill install --backup` for an existing skill). Earlier profile files are left untouched.

To reinstall this release (or update, replacing the version with your chosen published release):

```sh
npm install --global dataverse-plugins-native@0.1.0
npm uninstall --global dataverse-plugins-native
```

Removing the CLI does not remove skills, saved profiles, or your source files. Uninstall the skill separately.
If npm's global prefix is not writable, use npx or a user-owned npm prefix; do not default to administrator/sudo.

## Troubleshooting

- **Node/npm/npx not found:** install a supported Node.js LTS distribution with npm, reopen your terminal, then check
  `node --version`, `npm --version` and `npx --version`.
- **PowerShell blocks npm.ps1:** use the shipped `npm.cmd` / `npx.cmd` shims where policy permits; do not change or
  bypass organization execution policies.
- **Registry/download blocked:** check the exact error, approved proxy/registry and package allowlists with your
  administrator. An already installed CLI or approved cached package may work; do not bypass controls.
- **Global permission/PATH errors:** use `npx -y dataverse-plugins-native@0.1.0 ...`, or configure a
  [user-owned npm prefix](https://github.com/wyattdave/LowCode-Plugins/blob/main/docs/distribution.md#global-npm-permissions).
- **Modified/existing skill:** run `skill status` with the same target/project scope, inspect its changes, then
  explicitly use `skill update --backup` or `skill install --backup`. Backups are never automatically deleted.
- **Skill not discovered:** choose a documented target, reload the agent, and check its skill permissions/settings.
  Unsupported target names fail explicitly; custom skill paths are not guessed.
- **UI won't start:** inspect stderr, check whether the requested port is occupied, or omit `--port` to choose a free
  one. Open the printed session URL if automatic browser launching is unavailable. Only `ui` needs this server.
- **Sign-in/import failure:** verify account/environment and solution-import permissions. Dataverse reports formula
  compilation and publisher mismatches during import; the offline syntax check cannot guarantee deployment.

## Development and publishing

```sh
npm ci
npm test
npm run ui
```

`npm run build` compiles TypeScript and regenerates the skill's version-pinned runtime reference from `package.json`.
`npm run dataverse-plugins-native -- <command>` runs the built local CLI. Tests use temporary skill directories and fake Microsoft
transports; package integration tests exercise a tarball offline and a temporary global prefix.
CI covers Windows, macOS and Linux on Node 22.12 and 24.

Release checklist and manual npm publication steps:
[distribution guide](https://github.com/wyattdave/LowCode-Plugins/blob/main/docs/distribution.md#publishing-maintainers).
`npm pack` builds automatically and includes the CLI, UI, examples, complete skill and documentation.

## License

[MIT](https://github.com/wyattdave/LowCode-Plugins/blob/main/LICENSE)
