# @stimulir/code-runtime-*

Stimulir-maintained additive packages on top of upstream `@rivet-dev/agent-os-*`.

Published to **GitHub Packages** (private) under the `@stimulir` scope on every
push of a `stimulir-v*` tag.

## Install

In your consumer project (one-time setup):

```bash
# 1. Get a GitHub Personal Access Token with read:packages scope:
#    https://github.com/settings/tokens/new?scopes=read:packages
export GITHUB_TOKEN=ghp_xxx

# 2. Tell npm to use GitHub Packages for the @stimulir scope:
cat >> .npmrc <<EOF
@stimulir:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
always-auth=true
EOF

# 3. Install whichever packages you need:
npm i @stimulir/code-runtime-pi @stimulir/code-runtime-host
```

If you're in CI, `secrets.GITHUB_TOKEN` (the auto-provisioned token) has
`read:packages` for the same org by default — no PAT needed.

## Available packages

| Package | Purpose |
|---|---|
| `@stimulir/code-runtime-core` | Wire-up helper `createStimulirAgentSession(spec)` — explicit AuthStorage/ModelRegistry/SettingsManager/ResourceLoader to eliminate the silent-no-engagement footgun. |
| `@stimulir/code-runtime-host` | Portable host runtime utilities: `TrajectoryWriter`, per-tool-call watchdog (`collectShellDescendants` / `killShellDescendants`), end-of-run cleanup (`killProcessesReferencingPath`), and a hand-rolled ACP JSON-RPC client (`spawnAcpClient` + `defaultAcpTranslate`). |
| `@stimulir/code-runtime-pi` | In-process Pi adapter (`createPiAdapter`) with per-session config materialization. |
| `@stimulir/code-runtime-codex` | Codex ACP subprocess adapter (`createCodexAdapter`). |
| `@stimulir/code-runtime-claude-code` | Claude Code SDK ACP subprocess adapter (`createClaudeCodeAdapter`). |
| `@stimulir/code-runtime-opencode` | OpenCode ACP subprocess adapter (`createOpenCodeAdapter`). |
| `@stimulir/code-runtime-vibe` | Mistral Vibe ACP subprocess adapter (`createVibeAdapter`) — composes default + user AGENTS.md (Vibe REPLACES rather than appends). |
| `@stimulir/code-runtime-fs` | Filesystem driver aggregator (`createFsBackend(kind, options)` for s3 / google-drive / local). |
| `@stimulir/code-runtime-git` | git WASM software + JS helper (`gitClone` / `gitCommit` / `gitDiff` / `gitStatus` / `gitBranch`). |
| `@stimulir/code-runtime-sandbox` | Re-exports `@rivet-dev/agent-os-sandbox` toolkit. |
| `@stimulir/code-runtime-software` | Meta-bundle of WASM software (`codingAgentBundle`, `dataAnalysisBundle`, `networkingBundle`, `archiveBundle`, `buildBundle`, `everythingBundle`). |

## Releasing a new version

1. Bump every `@stimulir/code-runtime-*/package.json` `version` field.
2. Commit and push to `main`.
3. Tag and push:
   ```bash
   git tag stimulir-vX.Y.Z
   git push origin stimulir-vX.Y.Z
   ```
4. `.github/workflows/publish-stimulir.yml` fires automatically on the tag.
5. `.github/workflows/verify-stimulir-install.yml` runs on workflow success to
   prove the new versions are installable from the registry.

## License

Apache-2.0 (inherited from upstream `@rivet-dev/agent-os-*`).
