# dv-native — build and deploy Dataverse low-code plug-ins

A small CLI (for people and agents) and a local UI for **instant** plug-ins (Dataverse Functions) and **automated**
plug-ins (table events), written in Power Fx:

1. **Create / set** a plug-in spec (`dv-native.plugin/v1`), loading the formula from a script file.
2. **Check** the spec and the Power Fx syntax offline.
3. **Select an environment** — browser sign-in the same way the Power Apps CLI does it; accounts are remembered as
   profiles. Environments (with their type) come from the Power Platform API.
4. **Deploy** — dv-native builds and packs the solution itself, imports it with the Dataverse Web API
   (`ImportSolutionAsync`) and links to the solution in Power Apps.

> **Status:** preview tooling for a preview feature. The solution layout follows Microsoft's published
> contoso-real-estate-power-platform sample; the packed zip matches `pac solution pack` output entry for entry. Try a
> sandbox first.

## Quick start

Requires Node.js ≥ 22.12 only — no Power Platform CLI, no app registration, no runtime npm dependencies.

```powershell
npm install; npm run build
npm run ui                                    # the four steps in your browser

# or from the command line (add --json to any command for machine-readable output)
node dist/src/cli/main.js new --kind instant --out private/fee.plugin.json --prefix contoso --name CalculateFee `
  --params "Amount:input:Decimal,Rate:input:Decimal,Fee:output:Decimal" --formula-file private/fee.fx
node dist/src/cli/main.js set --spec private/fee.plugin.json --solution ContosoPlugins --publisher Contoso
node dist/src/cli/main.js check --spec private/fee.plugin.json
node dist/src/cli/main.js login                # browser sign-in, remembered as a profile
node dist/src/cli/main.js envs                 # profiles + environments
node dist/src/cli/main.js deploy --spec private/fee.plugin.json --environment "Contoso Dev"
```

Run `npm link` once to use `dv-native …` instead of `node dist/src/cli/main.js …`.
Exit codes: `0` ok · `2` blocked · `3` failed / invalid input. Full reference: [docs/commands.md](docs/commands.md).

## Agents

Agents use the same CLI with `--json`. The skill in
[.github/skills/dataverse-plugins-native/SKILL.md](.github/skills/dataverse-plugins-native/SKILL.md)
explains the workflow (write a `.fx` script, `new`/`set`, `check`, `envs`, confirm the environment with the user,
`deploy`).

## Authentication

dv-native signs in exactly like the Power Apps CLI (`codeapp-js-cli` / MSAL): the Power Apps first-party public client
(`9cee029c-6210-4654-90bb-17e6e9d36617`), authority `login.microsoftonline.com/organizations`, authorization code +
PKCE in your default browser, redirected to a one-shot `http://localhost:<random port>` listener, and
`<resource>/.default` scopes (`https://service.powerapps.com/` for the environment list, the org URL for Dataverse).
No app registration or secret is needed.

- **Profiles:** each account you sign in with is remembered (most recently used is active). The refresh token is stored
  in `%USERPROFILE%\.dv-native\profiles.dat`, encrypted for your Windows user with DPAPI via the built-in Windows
  PowerShell (on other OSes, `~/.dv-native/profiles.json` with owner-only permissions). Access tokens stay in memory.
- **Reconnect:** if a saved sign-in has expired or been revoked, the UI shows *Sign-in expired* with a Reconnect button;
  the CLI re-opens the browser once automatically.
- Tokens are never logged or sent to the browser page, and only go to the Power Platform API or a validated Dataverse
  host; HTTP redirects are refused. Commercial cloud only.

The profiles shown by earlier versions came from the Power Platform CLI's own sign-ins (`pac auth list`); dv-native no
longer uses pac.

## What deploy does

- Instant: `fxexpressions/<name>` + `customapis/<name>` (parameters as Custom API request parameters / response
  properties, bound to the `Microsoft.PowerFx.Evaluator` plug-in type).
- Automated: `fxexpressions/<name>` + `SdkMessageProcessingSteps/{id}.xml` (Create/Update/Delete, pre- or
  post-operation, synchronous). The step id is reused from the environment if one already exists for the expression,
  otherwise derived from the unique name, so redeploys update in place instead of adding duplicate triggers.
- Unmanaged, additive import into the solution named in the spec. It does **not** publish all customizations, activate
  other plug-ins/workflows, or delete anything.

The offline formula check is syntax-only (brackets, strings, comments, operators, parameter usage). The environment
compiles the formula during import.

## Safety rules enforced in code

- Deploy is refused for environments not listed for the signed-in account, for ambiguous environment names, and for
  specs with check errors. Automated deploys fail closed if more than one existing step is linked to the expression.
- Environment URLs and FetchXML values are validated or XML-escaped first; Dataverse error text is redacted before it
  is shown. The only process ever started is the in-box Windows PowerShell for DPAPI, with data passed over stdin.
- `new` never overwrites a file; `set` replaces the spec atomically and leaves it untouched when an option is invalid.
- The UI binds to `127.0.0.1` only and requires a per-session token, a matching `Host` and a same-origin `Origin`; it
  has a strict CSP, serves only an allowlist of files, never reads user-supplied paths, and requires the environment
  URL to be confirmed before deploying.

## Layout

```text
src/studio/   plug-in spec, settings, Power Fx syntax check, solution builder + packer, sign-in, profiles, Dataverse client, deploy
src/core/     strict JSON parser and schema validation
src/cli/      commands (new, set, check, envs, deploy, ui)
src/ui/       localhost-only UI server
ui/           browser client: vanilla HTML/CSS/JS, no build step
tests/        unit, CLI and UI server tests (fake Entra/Power Platform/Dataverse transport; no network)
examples/     instant.plugin.json, automated.plugin.json
```
