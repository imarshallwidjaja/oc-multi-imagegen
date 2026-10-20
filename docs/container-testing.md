# Container testing with real OpenCode agents

This runbook runs OpenCode 1 and OpenCode 2 in containers with the packed plugin and asks a real agent for images in plain terms, without naming the tool or the skill. It is for ad-hoc qualitative checks, such as before a release or after a change to a host adapter. The unit suite (`bun run test`) stays the routine check, and CI only needs the mocked tests. The runbook makes real model and image-generation calls on your ChatGPT account.

It is written for a source checkout of this repository. The scripts and this file are not part of the npm package: [scripts/opencode-container.sh](../scripts/opencode-container.sh) builds and packs the checkout itself, [scripts/seed-container-auth.ts](../scripts/seed-container-auth.ts) builds a disposable credential, and [scripts/container-skill-probe.sh](../scripts/container-skill-probe.sh) runs inside the OpenCode 2 container for the skill load checks.

## What a run shows

- The packed package, with only its runtime dependencies installed and no OpenCode SDK, loads in each host, registers `imagegen`, and registers the `oc-multi-imagegen` skill with the packaged body.
- With the skill permitted, a real agent loads it before its first generation, calls `imagegen` directly, and the tool call, result and saved PNG match the arguments. With the skill denied, the agent still generates.
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

Because the container holds a usable access token, keep the permission rules that deny everything except `imagegen`, the `oc-multi-imagegen` skill and reading `*.png` files, so the agent has no shell and cannot read the credential. `read` is scoped to PNG files so the agent can look at what it generated; the credential file is not a PNG.

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

`prepare` writes the host's config: the plugin by absolute path inside the container, a deny-everything permission rule set, and update checks and sharing turned off (OpenCode 1 `autoupdate: false` and `share: "disabled"`; OpenCode 2 `update: "disable"` and `share: "disabled"`). The permission mode is the second argument:

| Mode | Permits |
| --- | --- |
| `allow` (default) | `imagegen`, the `oc-multi-imagegen` skill, and reading `*.png` |
| `tool-only` | `imagegen` only, so the skill is denied |
| `ask` | nothing without a prompt; `imagegen` asks (for the permission probe below) |

`OC_TIMEOUT` (a positive whole number of seconds, default 300; `0` is refused) bounds every container the helper starts.

### Interrupting and cleaning up

Press Ctrl-C or send SIGTERM to the helper and wait for it to return. It stops the container it started (tracked by the id Docker writes to a per-run `--cidfile`, so it never touches a container it did not create), checks with Docker that the container is gone, deletes a pending `seed v2` directory, and exits 130 or 143. When `OC_TIMEOUT` stops a container, the helper's status is 124; `run`, `tools`, `seed` and `cases` all pass that status on. Any other nonzero status is the container's own (the status of `docker run`, so 125 to 127 are Docker's errors).

If Docker cannot confirm that the container is gone, because the stop and kill failed or the daemon stopped answering, the helper prints `Could not confirm that container <id> is gone`, exits nonzero (keeping the container's own status when it had one), starts no further container (`cases` skips the remaining cases) and keeps the `seed.XXXXXX` directory, telling you where it is. Check the container, stop it by id, then delete that directory yourself. The same applies if the helper process was killed outright (SIGKILL, power loss), when a container can survive:

```bash
docker ps -a --filter "label=ocimg.sandbox=$OC_SANDBOX"   # only this sandbox's containers
docker stop <id>                                           # stop each one by id
```

`clean` refuses while a container labelled with the sandbox is running, or when it cannot list them. Do not use sweeping commands such as `docker rm $(docker ps -aq)`; other containers on the machine are not yours.

If a case fails or times out, read its `.err` log, then start over in a new sandbox instead of retrying: `cases` refuses a work directory or logs from an earlier attempt, because a rerun would version the earlier outputs again and later cases would reference the wrong files. Once `docker ps -a --filter "label=ocimg.sandbox=$OC_SANDBOX"` shows nothing, run `$S clean` on the old sandbox so its credentials and session state do not linger, then `init` the new one (`export OC_SANDBOX=$($S init)`). `clean` leaves the old sandbox's images, logs and package where they are.

### 1. Load checks (no model, no quota)

```bash
$S tools v1                   # 1.19.3: the printed tool ids must include "imagegen"
$S tools v1-floor             # 1.18.29: same
$S skills v1                  # JSON list: includes oc-multi-imagegen at /pluginpkg/skills/oc-multi-imagegen/SKILL.md
$S skills v1-floor            # same on 1.18.29
$S skills v2                  # JSON list: oc-multi-imagegen with autoinvoke true and the same path
$S run v2 load -- run --standalone --print-logs --log-level info --model nonexistent/model hi 2>&1 \
  | grep -E 'loading plugin|failed to load'
```

`skills v1` runs `opencode debug skill`. `skills v2` runs [scripts/container-skill-probe.sh](../scripts/container-skill-probe.sh) in the container: it starts a private OpenCode 2 server and polls `GET /api/skill` (a request made before the location boots returns empty lists) until one successful reply lists `oc-multi-imagegen` exactly once, then prints that reply. The built-in skills alone do not satisfy it. If a request fails, a reply is not a complete skill list, or the skill is not listed once within 30 polls, the command exits 1 and prints the last reply and the server log. Compare each listed body with `skills/oc-multi-imagegen/SKILL.md` below its frontmatter (OpenCode 1 keeps a leading newline).

For OpenCode 2, expect a `loading plugin ... entrypoint=file:///pluginpkg/server.js` line and no `failed to load plugin` line. The command then ends with `Model unavailable: nonexistent/model`, which is expected. OpenCode 2 has no tool listing, so this check shows the plugin loaded; the agent run below shows `imagegen` registered.

To check that user skill configuration survives, add a `skills.paths` entry that points at a skill directory you created under `$OC_SANDBOX/v1/work`, to `$OC_SANDBOX/v1/config/opencode/opencode.json` and rerun `skills v1`: both the user's skill and `oc-multi-imagegen` are listed.

#### Skill lifecycle (no model, no quota)

Do this in a separate `init` sandbox after `pack` and `prepare v2`, because it edits the sandbox's package and config.

```bash
$S lifecycle v2
```

It runs the same probe script. The probe starts a private OpenCode 2 server, appends a marker line to the sandbox copy of `SKILL.md` and a comment to `server.js`, and then removes the plugin from the config, polling at most 30 times after each change (each request is bounded to 5 seconds, so 30 attempts is not 30 seconds of wall time). Expect `loaded: entries=1 marker=0`, `updated: entries=1 marker=1` (a changed `server.js` made OpenCode 2 reload the plugin, which read the new file, and the skill was not registered twice) and `removed: entries=0`. Each line comes from one successful skill-list reply and counts only the `oc-multi-imagegen` entry, so a marker in another skill does not count and a failed request does not read as an empty list. A state that does not arrive in time exits 1 with the last reply and the server log; a plugin that never loaded fails at `loaded`. On OpenCode 1, which reads skills when an instance starts, change the sandbox package or config and run `skills v1` again.

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

Restore `allow`, then run the four cases on one host after the other. Later cases use earlier outputs. The prompts live in `case_prompt` in the script. They ask in plain terms and name neither `imagegen` nor the skill: a wide lighthouse illustration (A), a sticker with a transparent background (B), a stormy-sky edit of A's file (C), and two screens of one meal-planning app (D).

```bash
for h in v1 v2; do $S prepare $h; done
$S cases v1 && $S cases v2
```

`cases` runs A, B, C and D in order for one host, each in its own container with its own timeout, writing `logs/<host>-case-<X>.out` and `.err` (each `.out` holds the images base64-encoded, several MB per case). A non-zero case stops that host's remaining cases, and `&&` stops the other host. It refuses to start unless `<host>/work` is empty and the host has no case logs. A case takes about a minute (4 minutes for the four cases on OpenCode 1 and 6.5 on OpenCode 2 in the recorded run).

To check the skill-denied path, use another new sandbox (`init`, `pack`, `prepare <host> tool-only`, `seed`) and run case A's prompt once per host. The run command is the one `cases` uses for case A, with the prompt from `case_prompt`:

```bash
P="Create a wide illustration of a lighthouse on a rocky coast at dusk, in a hand-drawn 90s Japanese animation style. Save it as lighthouse.png in the project folder."
for h in v1 v2; do $S prepare $h tool-only; done
$S run v1 denied-A -- run --format json --dir /work --model "$OC_MODEL" "$P" >"$OC_SANDBOX/logs/v1-denied-A.out" &&
  $S run v2 denied-A -- run --standalone --format json --model "$OC_MODEL" "$P" >"$OC_SANDBOX/logs/v2-denied-A.out"
```

### 4. Check the results

An exit code of 0 only means the agent finished. Check the tool calls in order, then the images.

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

The agent chooses the size and the file paths within what the prompt says, so check each result against its own call. Pass criteria, per host:

| Case | Tool calls, in order | PNG |
| --- | --- | --- |
| A | `skill` (`oc-multi-imagegen`), then `imagegen` with a valid `size`, status `completed` | the size the output reports, RGB |
| B | `skill`, then `imagegen` with `background: transparent` | RGBA |
| C | `skill`, then `imagegen` with `images` naming A's file | RGB, same size as A |
| D | `skill`, then `imagegen` for one screen, then `imagegen` for the other with `images` naming the first screen | two RGB portrait screens |
| skill denied (A) | `imagegen` with no `skill` call, status `completed` | RGB |

The agent may also `read` files; a refused `read` of the project directory is a permission result, not a plugin fault. The first `imagegen` must come after the `skill` call in the event order. In the `.out` log, OpenCode 1 reports the skill input as `{"name": ...}` and OpenCode 2 as `{"id": ...}`.

Then look at the images, not just the numbers:

- A is a wide dusk lighthouse on a rocky coast.
- B is an isolated red lantern with clear margin. Composite it on a dark and a light background: the surrounding area is transparent, and the white outline belongs to the sticker artwork. Measure the alpha distribution; a soft alpha (most subject pixels at 224 to 254, not 255) is the backend's behavior, not a plugin fault.
- C keeps A's composition and changes the sky to storm clouds with the lamp lit. The backend regenerates the whole image, so compare it with A and note what else moved.
- D shows two screens of one app with the same colours, type and navigation. Read the visible text on each: generated UI copy can contradict itself (for example item counts that do not match the list), which is the model's output and not a plugin fault.

The plugin's result is the output text plus the structured pair `{ out, versioned }`. What each host's event stream shows around it was observed, not specified by the plugin: in the validated run, OpenCode 1 reported `state.metadata` as `{ out, versioned, truncated }`, and OpenCode 2 2.0.32 reported the same three keys under `state.metadata.metadata` next to the text content (`state.metadata.content`). `truncated` comes from OpenCode.

### 5. Clean up

```bash
$S clean                                                # credentials, OpenCode 2 database, session state
docker ps -a --filter "label=ocimg.sandbox=$OC_SANDBOX" # should list nothing
stat -c '%y' "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"   # unchanged from before the run
```

`clean` removes the credential seed, any `seed.*` directory a run kept, the OpenCode 2 database that holds the imported credential, and session state for each host. The `work` directories (images), `logs`, `pkg` and `identity.txt` stay for review, and the hosts cannot run again until `prepare`. The helper never deletes the sandbox itself; remove `$OC_SANDBOX` yourself when you have finished reviewing it.

## Last validated run

Run on 2026-10-20 with the pinned versions above, plugin source at commit `a183e39` (clean worktree), built `dist/index.js` sha256 `7e0ffb0354539d4a4210abfce51b11459083a50ef02140d27b892a8a9d50ce04`, tarball sha256 `d9964c9ebb259dd74aa5db48e288d337386087ece8a7ec2c737f433e2639d31c`, agent model `openai/gpt-6.1-sol-fast`. The package under test came from `npm pack` with `npm install --omit=dev`; no `@opencode*` package was installed. This is one model on one ChatGPT account, so it shows what happened in these runs and says nothing about other models.

- Load, no model: `tools v1` (1.19.3) and `tools v1-floor` (1.18.29) listed `imagegen`. `skills v1`, `skills v1-floor` and `skills v2` each listed `oc-multi-imagegen` with the packaged body (compared after trimming), from `/pluginpkg/skills/oc-multi-imagegen/SKILL.md`; OpenCode 2 listed it with `autoinvoke: true`. With a user `skills.paths` entry added, both OpenCode 1 versions listed the user's skill and ours. On OpenCode 1, a marker appended to the sandbox `SKILL.md` appeared on the next start, and an empty `plugin` list removed the skill. `lifecycle v2` on 2.0.32 printed `loaded: entries=1 marker=0`, `updated: entries=1 marker=1`, `removed: entries=0`. The OpenCode 2 load line was logged with no failure.
- Package from an unrelated working directory: loading `server.js` from the extracted production package with plain `node` registered `imagegen` and the skill, resolved the skills directory inside that package, and added it once to a config that already held a path and a URL.
- Image scenarios (A to D, skill allowed, plain-language prompts): on OpenCode 1.19.3 and OpenCode 2.0.32 the agent called the `skill` tool for `oc-multi-imagegen` before its first `imagegen` in all eight cases, then called `imagegen` successfully, then read the result. B used `background: transparent` and the sticker came back RGBA (about 66 to 67% of pixels at alpha 0, 32 to 33% at 224 to 254, about 1% in between, 0.1% at 255). C passed the generated A as `images`, and D passed the first screen as `images` when generating the second. The returned sizes were the requested ones (1672x941 for A and C, 1254x1254 for B, 1024x1536 on OpenCode 1 and 941x1672 on OpenCode 2 for D).
- Qualitative result: A and B matched their prompts, and the sticker looked clean on a dark background with a soft white outline. In C the sky and lamp changed as asked and the cliffs, cottage and lighthouse were mostly kept, but the regeneration also moved things (OpenCode 1's result lowered the horizon and rearranged the rocks; OpenCode 2's dropped the sun glint on the water). D's two screens shared one app's colours, type and navigation. Their text was coherent on OpenCode 2: the shopping screen listed 10 rows, 2 of them checked, under "8 items to pick up". It was not on OpenCode 1, whose shopping screen showed "3 of 12 items checked" over nine listed rows; the agent did not comment on that.
- Skill denied (`tool-only`, case A prompt on both hosts): the agent called `imagegen` first and only, the result was 1536x1024 RGB, and no `skill` call appeared.
- Permission and credentials: the `read` rule let agents open the generated PNGs; a `read` of the project directory was refused once per host in case C. The host `auth.json` kept its modification time (2026-10-20 19:08:47) from before the first seed to after `clean`.
- Retained for review (local and temporary, outside the repository): the event logs, the images, the packed identity, both hosts' configs, and the scripts used to read them are under `/tmp/oc-multi-imagegen-evidence/`. Nothing in them is a credential.

After the load-check probe was moved into `scripts/container-skill-probe.sh` (2026-10-21), `skills v2` and `lifecycle v2` were rerun on 2.0.32 in new sandboxes with no model and no credential. The plugin and skill were unchanged: `dist/index.js` had the same sha256 as above. With the plugin loaded, `skills v2` listed `oc-multi-imagegen` once at `/pluginpkg/skills/oc-multi-imagegen/SKILL.md` with `autoinvoke: true` and exited 0, and `lifecycle v2` printed `loaded: entries=1 marker=0`, `updated: entries=1 marker=1`, `removed: entries=0` and exited 0. With the plugin absent from the config, both commands now exit 1 after about 31 seconds, print "Probe failed: timed out waiting for oc-multi-imagegen to be listed once (saw entries=0 ...)" with the last reply and the server log, and print nothing to stdout. The earlier inline probe exited 0 in that state, and `lifecycle v2` printed `loaded: entries=0 marker=0`, `updated: entries=0 marker=0`, `removed: entries=0`. The model-driven results above did not involve the probe and were not rerun.

Earlier runs with explicit prompts and no skill covered the same hosts with the four-case scenario. The helper's lifecycle handling (a normal exit, a timeout with status 124, SIGTERM, a `seed v2` import, a timed-out import, an unreachable daemon, and `OC_TIMEOUT=0`) was checked against the pinned images with a synthetic credential and no model; a stop that Docker cannot confirm is covered only by the unit tests' fake `docker`.

## Limits

- The agent must choose to load the skill and to call the tool. The case prompts name neither, so a run shows what one model did with them, not that every model will.
- The permission probe still names `imagegen`, because it tests the plugin's permission request and not discovery.
- Token-sharing, missing-connection and API-key credentials on OpenCode 2 are covered by the unit tests with a fake host, not by this runbook. Exercising them in a container needs a model that does not depend on the same OpenAI sign-in.
- OpenCode 1 installs its own SDK into the config directory on first start, so a run without network can start slowly or fail.
- The runbook pins one version per host. Versions between the documented minimum and the pins, and newer releases, are untested until you change the pins and run it.
- A container that ignores SIGTERM adds about 5 to 10 seconds to a timeout or interrupt while Docker waits before killing it.
