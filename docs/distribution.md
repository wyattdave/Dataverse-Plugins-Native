# Skill and CLI distribution

Package and executable: **dataverse-plugins-native**. Skill: **dataverse-plugins-native**. Current release: **0.1.0**.
Installing a skill copies instructions/assets; installing the CLI makes an executable available. Neither operation
installs the other globally. Only `ui` requires a persistent loopback server. Authentication uses a bounded, one-shot
loopback callback during browser sign-in; workflow commands otherwise run in short-lived processes.

The preview rename does not provide a previous executable alias or automatically migrate previous local state.
The spec identifier is now `dataverse-plugins-native.plugin/v1`; use the CLI to recreate older preview specs from
their formula/settings. Profiles use `~/.dataverse-plugins-native` (sign in again); earlier profile files remain
untouched. Skill manifests use `.dataverse-plugins-native-install.json`; reinstall an earlier preview skill with
`skill install --backup` to preserve its existing files before replacement. Browser theme/session storage keys and
the bundled UI API session header also use the new name.

## Three journeys

```sh
npx -y dataverse-plugins-native@0.1.0 skill install
npx -y dataverse-plugins-native@0.1.0 check --spec fee.plugin.json --json
npm install --global dataverse-plugins-native@0.1.0
```

Prerequisites: Node >= 22.12, npm/npx (npm 10+ recommended), and access to an approved npm registry for downloads.
No Power Platform CLI, native installer, service, app registration or administrator access is required.
Microsoft network access and solution-import privileges are required only for online operations.

`npx -y` suppresses the installation prompt, not download/network failures. It downloads and executes package code
when not cached. Missing npm, unsupported Node, network and registry errors are reported by Node/npm before our CLI
can run; the CLI cannot catch those bootstrap failures. Do not retry indefinitely or bypass corporate controls.

## Destinations and authoritative compatibility sources

Verified against official documentation on **2026-10-18**:

| Tool | User-level parent | Project-level parent | Official source |
| --- | --- | --- | --- |
| Codex | `~/.agents/skills` | `.agents/skills` | [Codex local skills](https://developers.openai.com/codex/skills) |
| Claude Code | `~/.claude/skills` | `.claude/skills` | [Claude skills locations](https://code.claude.com/docs/en/skills#where-skills-live) |
| VS Code / Copilot | `~/.copilot/skills` | `.github/skills` | [VS Code skill locations](https://code.visualstudio.com/docs/agent-customization/agent-skills#_create-a-skill) |
| OpenCode | `~/.agents/skills` | `.agents/skills` | [OpenCode skill discovery](https://opencode.ai/docs/skills/) |

Each parent contains `dataverse-plugins-native/SKILL.md` and its adjacent resources.
VS Code also supports `.agents/skills` at both scopes; OpenCode explicitly supports that shared location.
The safe non-interactive default is `shared`: `.agents/skills` under `os.homedir()`.
It serves Codex, OpenCode and VS Code; Claude Code has a separate explicit target.
`--target all` installs into the three distinct selected locations, deduplicating Codex/OpenCode.
The mapping is maintained in [targets.ts](../src/skills/targets.ts), not inferred from installed-tool executables.
No XDG/native OpenCode directory is needed because its verified shared location works across operating systems.

`--project <directory>` explicitly opts into project scope; relative paths resolve from the current directory.
There is no automatic project detection and no custom arbitrary destination flag.

```sh
npx -y dataverse-plugins-native@0.1.0 skill status --target all --json
npx -y dataverse-plugins-native@0.1.0 skill install --target all --project .
```

Status prints selected locations even when missing. It reports the running CLI version and the first executable
found on PATH; it does not execute an unrelated detected command or assume that command has the running version.
It is not a recursive scan of every possible legacy/custom agent directory.

## Safe lifecycle

- **Install:** stage and hash-validate the entire packaged directory, then rename it into place. Create missing parents.
  Existing destinations fail without an explicit `--backup`. No prompts are required, including in non-interactive use.
- **Manifest:** `.dataverse-plugins-native-install.json` records schema, package, skill, version, destination, installation timestamp,
  and SHA-256 hashes. It contains no credentials.
- **Update:** use the skill bundled with this exact CLI version, never an implicit `latest`. An unmodified managed
  installation can be updated directly; modified/unmanaged installations require `--backup`.
  Every replacement, including a clean update, keeps a complete uniquely named sibling backup.
- **Uninstall:** validate manifest ownership and hashes; refuse modified/missing managed files. Remove only unchanged
  managed files and empty managed directories. Extra user files, siblings and previous backups remain untouched.
  Missing installs return success with `removed: false`. An unmanaged install is never deleted.
- **Path checks:** reject symlink/junction destinations or ancestors, symlink assets, traversal and malformed manifest
  file names. A malformed manifest is a hard error, not permission to overwrite.
- **Multiple targets:** operations run sequentially and stop at the first failure. Earlier successful targets remain
  installed; this is not a cross-directory transaction. Use status to inspect them before retrying.

```sh
npx -y dataverse-plugins-native@0.1.0 skill update --target claude --backup
npx -y dataverse-plugins-native@0.1.0 skill uninstall --target claude
```

For a modified unmanaged/manifest-corrupt directory, manually preserve and move it aside before a fresh install.
After uninstall leaves unrelated files, a later install requires `--backup` or manually moving that leftover directory.
Backups live outside the discovery folder name and are never automatically removed; inspect/remove them manually
when no longer needed.

## Agent runtime selection

The [skill](../.github/skills/dataverse-plugins-native/SKILL.md) attempts `dataverse-plugins-native --version`, then checks the local
project's documented npm script, then uses the exact fallback in its adjacent `references/runtime.json`.
When working inside this CLI repository, prefer its own built version. Do not assume fixed global npm paths or
install globally as part of ordinary skill use.

`package.json` is the version source. `npm run build` regenerates the packaged runtime reference; `npm pack` /
`npm publish` invoke the build via `prepack`. Maintainers do not hand-update a second pinned version inside SKILL.md.
README release examples still need updating when releasing a new version.

Use `--json` for workflow/skill commands, not `ui`, help or version. JSON stdout is exactly one object;
diagnostics go to stderr. Exit 0 means success, 2 means blocked deployment, and 3 means invalid usage or failure.
No server or detached background process is started for skill operations.

## Global npm permissions

Prefer npx if the default global prefix is not writable. Otherwise set a user-owned prefix and add its executable
directory to your user PATH. Restart your terminal afterward. Do not run as administrator/sudo by default.

PowerShell:

```powershell
npm config set prefix "$HOME\.npm-global"
$env:Path = "$HOME\.npm-global;$env:Path"
npm install --global dataverse-plugins-native@0.1.0
dataverse-plugins-native --version
```

The example adjusts only the current process PATH; add `%USERPROFILE%\.npm-global` to your user PATH through your
OS settings for future terminals.

Bash / zsh:

```sh
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
npm install --global dataverse-plugins-native@0.1.0
dataverse-plugins-native --version
```

Add that export to your shell's profile to persist it. Node version managers may already provide a writable prefix.
With restrictive PowerShell policy, use `npm.cmd`, `npx.cmd` and `dataverse-plugins-native.cmd` where allowed; do not weaken policies.

Update by explicitly selecting a published version with `npm install --global dataverse-plugins-native@<version>`; uninstall with
`npm uninstall --global dataverse-plugins-native`. Skill copies and authentication profiles remain until separately removed.

## Publishing (maintainers)

Implementation does **not** publish the package. For release 0.1.0:

1. Review the MIT license and metadata. Check npm ownership/name availability (`npm view dataverse-plugins-native`); a 404 means
   no public package was found, not a guaranteed reservation.
2. For later releases, select an explicit version with `npm version <version> --no-git-tag-version`. Update the
   README/distribution examples. Build regenerates the skill runtime reference from that package version.
3. Run `npm ci`, `npm test`, `npm pack --dry-run` and `npm publish --dry-run`. `prepack` builds automatically.
   Verify there are no private specs, credentials, tests or source-only tooling in the tarball.
4. Commit and push release files and screenshot assets to `main` so the npm README's absolute image URLs resolve.
   Review [CI](../.github/workflows/ci.yml) on all three operating systems.
5. Authenticate to npm using your account's approved login/2FA or trusted publishing workflow. Confirm the registry
   with `npm config get registry` and identity with `npm whoami`.
6. Run **`npm publish --access public`** only when ready. This first version is not usable from the public registry
   until publication succeeds. A version cannot normally be republished; use a new version for later changes.
7. From a clean directory verify `npx -y dataverse-plugins-native@0.1.0 --version`, then install the skill for a deliberately selected
   test user/project and verify discovery in the intended agent.

Packaged files include compiled runtime modules, UI, examples, complete skill, docs/screenshots, README and LICENSE.
There are no runtime dependencies. `prepack` uses development dependencies in the checkout; registry consumers do
not need TypeScript. Package integration tests use the packed artifact offline, a temporary cache/global prefix,
and temporary project directories, never your real user-level skills.
