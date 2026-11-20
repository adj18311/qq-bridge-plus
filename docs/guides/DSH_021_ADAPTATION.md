# DSH 0.2.1 compatibility — 2026-10-20

Target: the installed DSH Desktop 0.2.1-rc.2. Changes are in the existing workspace and are not committed or pushed.

## Confirmed breakages and changes

| Area | Evidence | Adaptation |
| --- | --- | --- |
| Desktop endpoint | The packaged desktop host passes `--port 0`; the listener changes across restarts. | `src/dsh-desktop.js` discovers only loopback listeners owned by DSH desktop PIDs. After a failed health check, `NodeApiClient.refreshDesktopEndpoint()` authenticates candidate settings and requires the QQ `qq-mode` namespace before adopting an origin. Remote connections are never redirected. Set local `dsh.autoDiscoverDesktop=false` to opt out. |
| Persona template | An isolated QQ model turn failed before any model request: `unknown prompt variable "{{cwd}}"`; registered variables were `provider, model`. | Remove the obsolete cwd suffix from both source presets and rebuild their patches. Persona bodies, role cards, prompts and compaction budgets are retained. Do not add local directory tools to QQ to restore the old placeholder. |
| Late global tools | At preset initialization the registry held only four global tools; SSH and other plugins registered later. One-time failed deny calls could not hide those tools afterward. | Refresh restrictions on `tools/change`, using the public registry view. Hide non-QQ/non-safe inherited globals, including future late registrations; retain the execution whitelist. Protect against recursive change notifications. |
| Scope-local native Teams | Native 0.2.1 Team tools are installed into each Agent's own scope, which `tools.restrict` intentionally cannot remove. | Wrap only the native Team tool installation observers, excluding `qq-chat`/`qq-chat-v2`; ordinary DSH sessions retain the original native Team implementation. The wrapper uses `ctx.loader.import()` for ASAR-only native code and declares `sessionProjections` as a dependency. |
| Tool inventory | The former scanner found zero tools in the desktop profile's sparse node_modules and skipped validation. | Read DSH package sources directly from ASAR and follow linked/scoped external plugin packages. Empty inventories fail the CLI. Missing old optional bundles are reported separately from misspelled restrictions. |

## Local deployment outside Git

`config.json` initially changed from port 19387 to the first observed 0.2.1 listener, 9589. Recovery now follows the actual desktop listener in memory, so the stored port need not track every restart.

`scripts/setup-dsh.mjs` now deploys the Team fragment automatically for DSH 0.2.1 and newer. It reads the installed version from the desktop ASAR (`dsh/package.json`, via `scripts/dsh-asar.mjs`); only the numeric `major.minor.patch` is compared, so the actual `0.2.1-rc.2` build passes the 0.2.1 gate. If the version cannot be read (DSH not running, non-Windows or unpacked install, unreadable archive), setup prints the reason and skips the fragment instead of guessing. `QQ_SKIP_021_TEAM_PATCH=1` opts out; `QQ_FORCE_021_TEAM_PATCH=1` bypasses the gate and is intended only for deliberate testing.

Setup also locates the DSH CLI by absolute path — `DSH_CLI`, then the install root derived from the ASAR (`<root>/resources/runtime/cli/bin/dsh.cmd`), then `PATH` — and runs `dsh plugin … install` with that absolute path, so the CLI no longer has to be on `PATH`. When no CLI is found, setup stays on the existing two-level links (plugin directory + profile `node_modules`) and prints an info-level "nothing to do" line instead of an exit-1 warning.

The deployment is idempotent and non-destructive: it appends only the missing one of the two operations, keeps every other profile entry and its order, leaves an existing `tool-agent-team`/`qq-native-team-filter` pair alone, writes through a temporary file plus rename, and creates a `cordis.patch.yml.bak-<timestamp>` backup before changing the file. Re-running setup after the fragment is present does not rewrite the profile or create another backup.

Manual merge remains the fallback for profiles that setup cannot manage (custom `DSH_HOME`, non-desktop hosts, read-only profile, version metadata unavailable). The desktop profile `<DSH_HOME>/.dsh/profiles/desktop/cordis.patch.yml` contains the equivalent of `plugins/qq-agent-presets/compat/dsh-021-team.patch.yml`: disable the original `tool-agent-team` entry and insert `qq-native-team-filter`. This replaces its tool installer only; it does not disable the Team service, the third-party Agent Teams plugin, SSH, or normal agents' capabilities. Existing unrelated profile entries are retained. To deploy by hand, merge that fragment and restart DSH; removing those two profile entries restores the original native Team tool installer.

Do not install the fragment on DSH versions older than 0.2.1. The filter imports a 0.2.1-only Team implementation, and the generic preset bundle deliberately stays version-neutral so earlier hosts never load it; setup enforces the same boundary and only deploys after reading a 0.2.1+ version from the ASAR.

## Verification

- `npm run test:quick`: offline regression suite, including `test-dsh-021-compat.mjs`.
- `npm run test:audit`: full existing suite plus the new compatibility regressions. Environment-related skips retain their original meaning; a skipped external voice tool is not a tested live feature.
- `npm run scan:tool-names -- --missing`: actual installed ASAR/plugin tool inventory against the restriction list.
- `npm run verify:adaptation`: isolated live QQ v2 probe, including auth, presets, settings, model selection/catalog, follow snapshot, actual model response, actual model-facing tool names and queue cleanup. It archives its own session and removes its own temporary workspace. No QQ message is sent.
- `node scripts/verify-dsh-021-adaptation.mjs qq-chat`: same checks for the ordinary QQ preset.
- `node scripts/verify-dsh-021-adaptation.mjs standard`: confirms an ordinary DSH Agent still has native Team tools.
- `npm run verify:adaptation:020`: historical 0.2.0 verifier, retained separately.

Live evidence after deployment: both QQ presets expose 45 allowed tools; a standard Agent exposes 90 tools and retains native Team tools. Each live probe passes 17 checks and completes a real DeepSeek Flash model turn. Desktop restart tests verified automatic recovery across multiple changed listener ports.

Final results: quick 34/34 scripts, full 77/77 scripts, and the dedicated compatibility regression file 11/11 tests passed (the profile-patch regression file passes 12/12). Existing external-environment skips remain skips. The bridge was restarted with the final code and recovered the current desktop listener in reserved2 mode.

Final QQ-client message/response acceptance remains a manual step. Earlier logs include SnowLuma send rejection `result=120`; these isolated DSH probes do not prove QQ delivery. The unrelated five-minute wait failure, provider quotas and slang-research timeout are outside this compatibility change.

Two task-only temporary diagnostic log paths were used under the Windows TEMP directory (`qq-021-guard-diag.jsonl`, `qq-021-team-diag.jsonl`). Diagnostic instrumentation was removed from the source. Automatic approval rejected the shell cleanup command with `blocked by policy`, so any existing diagnostic logs are retained; source data was not deleted.

## Review

A DeepSeek Flash reviewer with high reasoning completed a focused review and found no blocker. Endpoint discovery already checks listener PID ownership; candidate validation additionally requires the QQ settings namespace. The Team wrapper is deliberately limited to the native implementation's installation paths (`agents.list`, `agent/created`), preserving disposal callbacks and the original Team service.

The source schema fallback in `verify-persona-config.mjs` is still the repository's older devDependency; it validates configuration fields only. The live 0.2.1 probes, rather than that fallback, establish runtime compatibility. Windows desktop discovery is implemented; other platforms continue to use an explicitly configured endpoint. Two DSH instances sharing the same credentials and QQ profile cannot be distinguished by that shared profile identity alone.
