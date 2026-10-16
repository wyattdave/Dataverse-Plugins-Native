---
name: dataverse-plugins-native
description: "Use when: creating, editing, syntax-checking or deploying a Dataverse low-code plug-in (instant plug-in / Dataverse Function / Custom API, or automated plug-in on a table Create/Update/Delete event) written in Power Fx, using the dv-native CLI. Covers writing the .fx script, setting solution/publisher/parameters/trigger, check, browser sign-in, environment selection and deploy."
---

# Deploy Dataverse low-code plug-ins with dv-native

dv-native turns a Power Fx script plus a few settings into a solution and imports it through the Dataverse Web API.
The state lives in one spec file (`*.plugin.json`); you change it only through the CLI.

## Running the CLI

- Run it with `npx -y dv-native <command> …` (`-y` skips npx's install prompt, which would block a non-interactive
  run). Needs Node.js ≥ 22.12 only; nothing else has to be installed.
- Sign-in is a browser sign-in the user completes themselves (same as the Power Apps CLI, no app registration). The
  account is remembered as a profile, so later commands usually don't open the browser again.
- Always pass `--json`. stdout is then one JSON object; failures are `{ "error": "…" }`.
- Exit codes: `0` ok · `2` blocked (nothing was imported) · `3` failed or invalid input.
- `npx -y dv-native <command> --help` prints the exact options.
- Keep the `.fx` and `.plugin.json` files in the user's workspace (e.g. a `plugins/` folder) unless they name another
  location; they are the source of truth for redeploys.

## Workflow

### 1. Write the formula as a script file

Create a `.fx` file with the Power Fx formula. Do not hand-edit the spec JSON; use `--formula-file`.

- **Instant** plug-in: inputs are referenced by parameter name; return outputs as a record:
  `{ Fee: Amount * Rate }`.
- **Automated** plug-in: read the triggering row with `NewRecord` (and `OldRecord` on Update), e.g.
  `If(IsBlank(NewRecord.name), Error({ Kind: ErrorKind.Validation, Message: "Name is required." }))`.
- Not supported: `Set`, `UpdateContext`, `Navigate`, `Notify`.

### 2. Create the spec with all settings in one call

```powershell
npx -y dv-native new --kind instant --out plugins/fee.plugin.json `
  --prefix contoso --name CalculateFee --display-name "Calculate fee" --description "Amount x Rate" `
  --solution ContosoPlugins --solution-display-name "Contoso plug-ins" --publisher Contoso --publisher-display-name "Contoso" `
  --params "Amount:input:Decimal,Rate:input:Decimal,Fee:output:Decimal" `
  --tables none --formula-file plugins/fee.fx --json
```

```powershell
npx -y dv-native new --kind automated --out plugins/rule.plugin.json `
  --prefix contoso --name AccountNameRequired --display-name "Account name required" `
  --solution ContosoPlugins --publisher Contoso `
  --trigger-table account --message Create --stage preOperation --tables account `
  --formula-file plugins/rule.fx --json
```

Settings (for `new` and `set`):

| Option | Notes |
| --- | --- |
| `--formula-file <path>` | Power Fx script; replaces the formula |
| `--name` | Prefix is added when missing (`Fee` → `contoso_Fee`) |
| `--display-name`, `--description` | Free text |
| `--params` | Instant only. `Name:input\|output:Boolean\|DateTime\|Decimal\|Float\|Integer\|String`, comma separated, or `none`. Replaces all parameters |
| `--trigger-table`, `--message`, `--stage` | Automated only. Table logical name; `Create\|Update\|Delete`; `preOperation` (validate/change the row before save) or `postOperation` (after save) |
| `--tables` | Logical names the formula reads/writes, or `none`. The trigger table is added automatically |
| `--solution`, `--solution-display-name`, `--solution-version` | Target unmanaged solution (created if missing) |
| `--publisher`, `--publisher-display-name`, `--prefix`, `--option-value-prefix` | Must match the existing publisher in the environment if the solution already exists. `--prefix` also renames the plug-in |

Ask the user for the solution, publisher and prefix if they are not known — the starter values (`SampleLowCodePlugins`,
`SamplePublisher`, `sample`) are placeholders and should not be deployed. Prefixes starting with `ms` and `adx` are
reserved.

### 3. Fix issues, then check

`new` and `set` return `check: { ok, issues }`. Errors block deploy; warnings do not. Each issue has a `code`, a
`message`, and either `line`/`column` (formula) or `path` (spec field). Fix the script or settings and re-apply:

```powershell
npx -y dv-native set --spec plugins/fee.plugin.json --formula-file plugins/fee.fx --json
npx -y dv-native check --spec plugins/fee.plugin.json --json
```

The check is syntax-only; the environment compiles the formula during import, so say so when reporting success.

### 4. Choose the environment

```powershell
npx -y dv-native envs --json
```

If there is no profile yet it opens a browser sign-in the user must complete themselves (tell them to expect it).
Returns `active` (the profile in use), `profiles` (remembered accounts, `needsReauth` when a saved sign-in expired) and
`environments` (`name`, `id`, `url`, `type` — Production, Sandbox, Developer, Default, Trial, Teams or Unknown).

- Wrong account: `npx -y dv-native envs --profile <username> --json`, or `npx -y dv-native login --select-account`
  to add another account.
- Show the user the candidate environments with their `type`, and get them to confirm which one to use.

### 5. Deploy (only after the user confirms)

Deploying imports into a real environment. Before running it, state the plug-in, solution and environment (name, URL
and type) and get explicit confirmation — be especially careful with `Production` or `Default` environments.

```powershell
npx -y dv-native deploy --spec plugins/fee.plugin.json --environment https://contoso-dev.crm.dynamics.com/ --json
```

`--environment` accepts the URL (preferred), the id, or the exact display name; ambiguous names are blocked.
The result has `status` (`succeeded` / `blocked` / `failed`) and `steps` (`check`, `environment`, `resolve`
(automated only), `pack`, `import`) each with `status` and `detail`, plus `solutionUrl` (a Power Apps link to the
solution) on success — give that link to the user. Report the failing step's `detail` to the user —
import errors (e.g. publisher prefix mismatch, formula compile errors) come straight from Dataverse.

Redeploying the same spec updates the plug-in in place. Deploy never deletes, publishes all customizations, or
activates anything else.

## Changing an existing plug-in

Use `set` with only the options that change, then `check`, then deploy again. `set` writes atomically and leaves the
file untouched if an option value is invalid. Changing `--name` (or `--prefix`) of a plug-in that is already deployed
creates a second plug-in instead of updating the first — only do that when the user asks for it.
