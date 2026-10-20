# Container testing with real OpenCode agents

This runbook runs OpenCode 1 and OpenCode 2 in containers with the packed plugin and asks a real agent to call `imagegen`. It is for ad-hoc qualitative checks, such as before a release or after a change to a host adapter. The unit suite (`bun run test`) stays the routine check, and CI only needs the mocked tests. The runbook makes real model and image-generation calls on your ChatGPT account.

It is written for a source checkout of this repository. The scripts and this file are not part of the npm package: [scripts/opencode-container.sh](../scripts/opencode-container.sh) builds and packs the checkout itself, and [scripts/seed-container-auth.ts](../scripts/seed-container-auth.ts) builds a disposable credential.

## What a run shows

- The packed package, with only its runtime dependencies installed and no OpenCode SDK, loads in each host and registers `imagegen`.
- A real agent calls `imagegen` directly, and the tool call, result and saved PNG match the arguments.
- OpenCode 2 gets its credential from its own connection store, not from `OPENCODE_AUTH_CONTENT`.
- The permission request happens inside the plugin, so a rejected request writes no file.

It does not cover the OpenCode desktop or TUI clients, token refresh, or models other than the one you pick. A model that follows the prompt is part of what you are testing, so a failed run can be the agent's fault rather than the plugin's.

## Prerequisites

- Linux (or WSL) with Bash 4.4 or newer, GNU coreutils (the scripts use `timeout`, `stat`, `seq`, `mktemp` and `sha256sum`), `git` and `tar`, plus Docker, Bun, npm, `python3` and `jq`.
- Network access: the images, the npm install, and the OpenCode 1 first-start SDK install all fetch.
- The host's OpenCode is signed in with ChatGPT. The seed needs its OpenAI access token to be valid for at least the run (the default requirement is 24 hours; pass a smaller number to `seed`). The host auth file is `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json`.
- A model your ChatGPT account can use for the agent. In the validated run this was `openai/gpt-6.1-sol-fast`. On the same account, `openai/gpt-5.4-mini` and `openai/gpt-5.5` failed with "model is not supported when using Codex with a ChatGPT account", and `opencode/deepseek-v4-flash` failed with a 403 "Model access is disabled". List candidates with `scripts/opencode-container.sh run v1 models -- models openai`, which needs a seeded `v1`.

## Pinned hosts

| Host | Version |
| --- | --- |
| `v1` | 1.19.3 |
| `v1-floor` | 1.18.29 (documented minimum) |
| `v2` | 2.0.32 (documented minimum) |

The image digests live in `scripts/opencode-container.sh` and nowhere else. The images hold the OpenCode binary only, with no Node, Bun or git on the path. They run as your user (`--user $(id -u):$(id -g)`) with all capabilities dropped. To validate a newer release, change the digests in the script and record the new versions in this table.

## Credential safety

The container never sees your OpenCode home or credential store. `seed` reads the host's `auth.json` and writes a mode-600 file in a private directory under `$OC_SANDBOX`. The file carries the OpenAI access token, its expiry and account id, with a placeholder refresh token, so the container cannot rotate your session. It carries no other provider's key.

The seed script prints validity facts only, and its errors name paths and reasons, never file contents. It creates the file exclusively: an existing path, symlink or hard link at the output path (including the host auth file) is refused and left as it was, and the file appears only after the host file is confirmed unchanged since it was read. It does not create or change directories; the output directory must already be private and yours.

Hold to these rules in any variation of this setup:

- Do not mount `~/.local/share/opencode`, `~/.config/opencode` or your home directory, and do not pass `-e` flags that forward your host environment.
- Do not run `opencode auth export` or print `auth.json`, the container environment or a config that contains a key. Print only counts and validity.
- Check `stat -c '%y' "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"` before and after a run. The modification time must not change.
- When the access token expires, the run stops working until you sign in on the host again and start a new sandbox. Nothing in the container refreshes it.

Because the container holds a usable access token, keep the permission rule that denies everything except `imagegen`, so the agent cannot read the credential with a shell tool.

OpenCode 1 reads the seed as its `auth.json`, and it stays in the sandbox until `clean`. For OpenCode 2, `seed v2` writes the seed into a new private `seed.XXXXXX` directory under `$OC_SANDBOX`, imports it with `opencode auth import`, and deletes that directory on every exit path: success, a failed import, a timeout, Ctrl-C or SIGTERM. The directory is the only thing the run deletes; a `seed` file or directory already in the sandbox is left as it was. The one exception is a container that Docker cannot confirm is gone, covered below: the directory is kept because that container may still read it. The plugin on OpenCode 2 reads only that imported connection. The `run` command also sets a decoy `OPENCODE_AUTH_CONTENT` for OpenCode 2; generation succeeds regardless, which shows the variable is not a fallback.

Observation on 2.0.32 (image digest in the script, dummy credentials, 2026-10-20): with a legacy `auth.json` already in the data directory before the first start on a brand-new database, `opencode auth list` showed no integrations on that start or the next. `opencode auth import` of the same dummy credential then reported "Imported 1 credential" and the list showed it. The runbook relies on the explicit import only; it does not establish whether or when OpenCode 2 imports a legacy file by itself.

## Procedure

Run these from the repository root. Each attempt uses a new sandbox, and every command after `init` needs `OC_SANDBOX` set to it. The helper accepts only a sandbox that `init` made: a private directory outside this repository and its worktrees, spelled as its canonical path. Anything else is refused before a file is created or changed. Never run two cases, hosts or helper commands at the same time, and do not background them: each case spends quota, and an interrupted background job keeps spending it.

```bash
S=scripts/opencode-container.sh
export OC_SANDBOX=$($S init)  # a new private directory under $TMPDIR (default /tmp)

bun install --frozen-lockfile
$S pack                       # bun run build, npm pack, extract, npm install --omit=dev: a consumer's view of the package
cat "$OC_SANDBOX/identity.txt"  # commit, uncommitted path count, sha256 of dist/index.js and the tarball

for h in v1 v1-floor v2; do $S prepare $h; done
for h in v1 v2; do $S seed $h; done   # v1-floor is a load check only and needs no credential
```

`prepare` writes the host's config: the plugin by absolute path inside the container, a deny-everything permission rule that allows `imagegen`, and update checks and sharing turned off (OpenCode 1 `autoupdate: false` and `share: "disabled"`; OpenCode 2 `update: "disable"` and `share: "disabled"`). `prepare <host> ask` writes `ask` instead, for the permission probe below. `OC_TIMEOUT` (a positive whole number of seconds, default 300; `0` is refused) bounds every container the helper starts.

### Interrupting and cleaning up

Press Ctrl-C or send SIGTERM to the helper and wait for it to return. It stops the container it started (tracked by the id Docker writes to a per-run `--cidfile`, so it never touches a container it did not create), checks with Docker that the container is gone, deletes a pending `seed v2` directory, and exits 130 or 143. When `OC_TIMEOUT` stops a container, the helper's status is 124; `run`, `tools`, `seed` and `cases` all pass that status on. Any other nonzero status is the container's own (the status of `docker run`, so 125 to 127 are Docker's errors).

If Docker cannot confirm that the container is gone, because the stop and kill failed or the daemon stopped answering, the helper prints `Could not confirm that container <id> is gone`, exits nonzero (keeping the container's own status when it had one), starts no further container (`cases` skips the remaining cases) and keeps the `seed.XXXXXX` directory, telling you where it is. Check the container, stop it by id, then delete that directory yourself. The same applies if the helper process was killed outright (SIGKILL, power loss), when a container can survive:

```bash
docker ps -a --filter "label=ocimg.sandbox=$OC_SANDBOX"   # only this sandbox's containers
docker stop <id>                                           # stop each one by id
```

`clean` refuses while a container labelled with the sandbox is running, or when it cannot list them. Do not use sweeping commands such as `docker rm $(docker ps -aq)`; other containers on the machine are not yours.

If a case fails or times out, read its `.err` log, then start over in a new sandbox instead of retrying: `cases` refuses a work directory or logs from an earlier attempt, because a rerun would version `character.png` again and later cases would reference the wrong files. Once `docker ps -a --filter "label=ocimg.sandbox=$OC_SANDBOX"` shows nothing, run `$S clean` on the old sandbox so its credentials and session state do not linger, then `init` the new one (`export OC_SANDBOX=$($S init)`). `clean` leaves the old sandbox's images, logs and package where they are.

### 1. Load checks (no model, no quota)

```bash
$S tools v1                   # 1.19.3: the printed tool ids must include "imagegen"
$S tools v1-floor             # 1.18.29: same
$S run v2 load -- run --standalone --print-logs --log-level info --model nonexistent/model hi 2>&1 \
  | grep -E 'loading plugin|failed to load'
```

For OpenCode 2, expect a `loading plugin ... entrypoint=file:///pluginpkg/server.js` line and no `failed to load plugin` line. The command then ends with `Model unavailable: nonexistent/model`, which is expected. OpenCode 2 has no tool listing, so this check shows the plugin loaded; the agent run below shows `imagegen` registered.

### 2. Permission probe (one cheap model call per host, no image quota)

```bash
export OC_MODEL=openai/gpt-6.1-sol-fast
P="Use the imagegen tool to generate an image at probe.png. Content: a red lantern. Size: 1254x1254."
for h in v1 v2; do $S prepare $h ask; done
$S run v1 ask -- run --format json --dir /work --model "$OC_MODEL" "$P" >"$OC_SANDBOX/logs/v1-ask.out" &&
  $S run v2 ask -- run --standalone --format json --model "$OC_MODEL" "$P" >"$OC_SANDBOX/logs/v2-ask.out"
jq -c 'select(.type=="tool_use") | .part | {tool, status: .state.status, error: .state.error}' "$OC_SANDBOX"/logs/v?-ask.out
ls -A "$OC_SANDBOX"/v1/work "$OC_SANDBOX"/v2/work
```

Expect `imagegen` called with status `error` ("rejected permission" on OpenCode 1, "non-interactive run cannot ask" on OpenCode 2) and empty work directories. The tool is visible and runs, and the plugin's own permission request stops it before credentials or the provider are touched. A rule that denies `imagegen` outright hides the tool from the agent instead, which shows nothing about the plugin.

### 3. Image scenarios (real quota)

Restore `allow`, then run the four cases on one host after the other. Later cases use earlier outputs. The prompts match `tests/e2e/imagegen.test.ts` and live in the script.

```bash
for h in v1 v2; do $S prepare $h; done
$S cases v1 && $S cases v2
```

`cases` runs A, B, C and D in order for one host, each in its own container with its own timeout, writing `logs/<host>-case-<X>.out` and `.err`. A non-zero case stops that host's remaining cases, and `&&` stops the other host. It refuses to start unless `<host>/work` is empty and the host has no case logs. Each case takes 30 to 45 seconds.

### 4. Check the results

An exit code of 0 only means the agent finished. Check the tool calls and then the images.

```bash
jq -c 'select(.type=="tool_use") | .part | {tool, status: .state.status, input: (.state.input | del(.prompt)), output: .state.output, metadata: .state.metadata}' \
  "$OC_SANDBOX"/logs/v?-case-?.out

python3 -I - "$OC_SANDBOX"/v1/work/*.png "$OC_SANDBOX"/v2/work/*.png <<'EOF'
import struct, sys
for p in sys.argv[1:]:
    b = open(p, "rb").read()
    w, h, depth, ctype = struct.unpack(">IIBB", b[16:26])
    print(p, b[:8].hex() == "89504e470d0a1a0a", f"{w}x{h}", {2: "RGB", 6: "RGBA"}.get(ctype, ctype))
EOF
```

Pass criteria, per host:

| Case | Tool call | PNG |
| --- | --- | --- |
| A | `imagegen`, `out: character.png`, `size: 1024x1536`, status `completed` | PNG magic, 1024x1536, RGB |
| B | `out: character.png`, `size: 1536x1024`; output says it was versioned to `character-v2.png` and the metadata has `versioned: true` | `character-v2.png`, 1536x1024 |
| C | `images` lists `./character.png` and `./character-v2.png`, `size: 1672x941` | `together.png`, 1672x941 (1 px tolerance) |
| D | `size: 1254x1254`, `background: transparent` | RGBA |

Then look at the images, not just the numbers:

- A shows a man in a navy samue and red hachimaki among cherry blossoms, in a hand-drawn 90s anime style.
- B shows a woman in a yellow yukata holding a red wagasa at night with fireflies.
- C shows both characters together with the outfits and props of A and B. Compare against the references: the same clothes, the woman's hairstyle and hair ornament, and the man's headband.
- D shows an isolated red lantern with clear margin. View it on a dark and a light background: the surrounding area is transparent, and the white outline belongs to the sticker artwork.

The plugin's result is the output text plus the structured pair `{ out, versioned }`. What each host's event stream shows around it was observed, not specified by the plugin: in the validated run, OpenCode 1 reported `state.metadata` as `{ out, versioned, truncated }`, and OpenCode 2 2.0.32 reported the same three keys under `state.metadata.metadata` next to the text content (`state.metadata.content`). `truncated` comes from OpenCode.

### 5. Clean up

```bash
$S clean                                                # credentials, OpenCode 2 database, session state
docker ps -a --filter "label=ocimg.sandbox=$OC_SANDBOX" # should list nothing
stat -c '%y' "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"   # unchanged from before the run
```

`clean` removes the credential seed, any `seed.*` directory a run kept, the OpenCode 2 database that holds the imported credential, and session state for each host. The `work` directories (images), `logs`, `pkg` and `identity.txt` stay for review, and the hosts cannot run again until `prepare`. The helper never deletes the sandbox itself; remove `$OC_SANDBOX` yourself when you have finished reviewing it.

## Last validated run

Run on 2026-10-20 with the pinned versions above, plugin source at commit `5118fe7`, built `dist/index.js` sha256 `1505ea10ebf9013b2646887125882792a98c4e834085109a90285dd226a5a17f`, agent model `openai/gpt-6.1-sol-fast`. The package under test came from `npm pack` with `npm install --omit=dev`, so the OpenCode SDKs were absent.

- Load: `v1` 1.19.3 and `v1-floor` 1.18.29 listed `imagegen` among their tool ids. 1.18.29 was checked for load and registration only; no agent ran on it. OpenCode 2.0.32 logged the plugin load with no failure.
- Image scenarios: on both hosts the agent called `imagegen` directly, once per case, and every case completed. B was versioned to `character-v2.png` with `versioned: true`. Sizes were exactly 1024x1536, 1536x1024, 1672x941 and 1254x1254. A to C were RGB. D was RGBA, with about two thirds of pixels fully transparent and almost all of the rest at alpha 224 or higher.
- Qualitative result: all eight images matched their prompts. In C, both characters carried the outfits and props of A and B, including the woman's hairstyle and hair ornament, which differ between the two hosts' runs because each host generated its own A and B.
- Permission probe: both hosts rejected the call at the plugin's permission request and wrote no file.
- OpenCode 2 generated successfully while `OPENCODE_AUTH_CONTENT` held the decoy, so its credential came from the connection store.

That run used earlier driver scripts. The current `scripts/` helpers were exercised afterwards without a model or a real credential: load checks on 1.19.3, 1.18.29 and 2.0.32, the OpenCode 2 import with a dummy credential, a timeout, an interrupt, and a failed import. The four-case scenario has not been repeated with the current helpers, because the plugin build is the same (identical `dist/index.js` hash) and a repeat would only spend quota.

After the helper began confirming removal by listing the container (`docker ps -a --filter id=<id>`) and giving each `seed v2` its own directory, the lifecycle was run again against the pinned images with a synthetic credential and no model: a normal exit, a timeout (status 124), SIGTERM (143), a `seed v2` import and a timed-out one (124), an unreachable daemon, and `OC_TIMEOUT=0`. Afterwards no container labelled with the sandbox and no `seed.*` directory remained. A stop that Docker cannot confirm is covered only by the unit tests' fake `docker`; it was not forced on a real daemon.

## Limits

- The agent must choose to call the tool. The prompts name `imagegen` explicitly; a vaguer prompt tests the model, not the plugin.
- Token-sharing, missing-connection and API-key credentials on OpenCode 2 are covered by the unit tests with a fake host, not by this runbook. Exercising them in a container needs a model that does not depend on the same OpenAI sign-in.
- OpenCode 1 installs its own SDK into the config directory on first start, so a run without network can start slowly or fail.
- The runbook pins one version per host. Versions between the documented minimum and the pins, and newer releases, are untested until you change the pins and run it.
- A container that ignores SIGTERM adds about 5 to 10 seconds to a timeout or interrupt while Docker waits before killing it.
