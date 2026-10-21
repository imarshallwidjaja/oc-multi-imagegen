# Container testing with real OpenCode agents

This runbook runs OpenCode 1 and OpenCode 2 in containers with the packed plugin and asks a real agent for images in plain terms, without naming the tool or the skill. It is for ad-hoc qualitative checks, such as before a release or after a change to a host adapter. The unit suite (`bun run test`) stays the routine check, and CI only needs the mocked tests. The runbook makes real model and image-generation calls on your ChatGPT account, and, for the OpenAI Images API backend, on the account of an API key you provide.

It is written for a source checkout of this repository. The scripts and this file are not part of the npm package: [scripts/opencode-container.sh](../scripts/opencode-container.sh) builds and packs the checkout itself, [scripts/seed-container-auth.ts](../scripts/seed-container-auth.ts) builds a disposable credential, [scripts/container-skill-probe.sh](../scripts/container-skill-probe.sh) runs inside the OpenCode 2 container for the skill load checks, and [scripts/container-backend-probe.sh](../scripts/container-backend-probe.sh) runs inside either host for the backend registration checks. The procedure below covers the Codex backend, which is the default; "OpenAI Images API backend" describes the other.

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

The container never sees your OpenCode home or credential store. `seed` reads the host's `auth.json` and writes a mode-600 file in a private directory under `$OC_SANDBOX`. The file carries the OpenAI access token, its expiry and account id, with a placeholder refresh token, so the container cannot rotate your session. It carries no other provider's key. The OpenAI Images API key does not enter a host's credential store; when you ask for it, it travels as a separate private env file (see "OpenAI Images API backend").

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

`prepare` writes the host's config: the plugin by absolute path inside the container as a plain entry with no options (the backend is a container environment variable, see "OpenAI Images API backend"), a deny-everything permission rule set, and update checks and sharing turned off (OpenCode 1 `autoupdate: false` and `share: "disabled"`; OpenCode 2 `update: "disable"` and `share: "disabled"`). The permission mode is the second argument:

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

## OpenAI Images API backend

The plugin takes its settings from the environment of the OpenCode process, so a run selects the backend with `OC_MULTI_IMAGEGEN_BACKEND=openai-api` in the container, and the plugin uses `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` as the key ahead of any saved `openai-images` key. `prepare <host> allow openai-api` records the backend for the host, and every container the helper starts for that host receives `-e OC_MULTI_IMAGEGEN_BACKEND=openai-api`; the host's configuration keeps its plain plugin entry. Nothing else of your environment is forwarded.

Agents still need a chat model, which the key cannot authenticate, so the chat sign-in is seeded as before. You provide the key as a dotenv file with an `OPENAI_API_KEY` line, ideally for a key limited to image generation. That name is the file's own, not a plugin setting, and only `scripts/seed-container-auth.ts` reads the file; the plugin reads no dotenv file. `OC_IMAGE_KEY_ENV_FILE` carries its path through the helper. `seed` writes the key to `$OC_SANDBOX/<host>/image-key.env`, a new mode-600 Docker env file that holds `OC_MULTI_IMAGEGEN_OPENAI_API_KEY=<key>`, and `run` and `cases` pass it to their containers with `--env-file`. The key is never a command-line argument and never printed. The host's own store gets a synthetic saved `openai-images` key (`sk-synthetic-decoy-not-a-real-key`) instead, so a generation that succeeds shows the variable took precedence: OpenAI rejects the decoy. `clean` removes the env file, and any `image-key.env.<pid>.tmp` staging fragment an interrupted `seed` left beside it, with the other credential state. Docker records a container's environment in its configuration until `--rm` removes the container when it exits.

```bash
S=scripts/opencode-container.sh
export OC_SANDBOX=$($S init)
bun install --frozen-lockfile && $S pack
for h in v1 v1-floor v2; do $S prepare $h allow openai-api; done   # records the backend the container's environment selects

# No model and no key: what each host registered for the backend.
for h in v1 v1-floor v2; do $S backend $h openai-api; done
$S tools v1; $S tools v1-floor

# One generation and one reference edit per host, at low quality and a size both backends accept.
export OC_IMAGE_KEY_ENV_FILE=/path/to/dotenv OC_MODEL=openai/gpt-6.1-sol-fast
for h in v1 v2; do $S seed $h; done
$S run v2 auth-list -- auth list   # OpenCode 2: the saved key, then the environment connection (names, no values)
$S cases v1 smoke && $S cases v2 smoke
$S clean
```

`backend <host> openai-api` starts a private server in the container and fails unless the host registered what the backend needs and no provider entry for it. On OpenCode 1 that is a `/provider/auth` entry under `openai-images` whose one method has type `api`, an absent `/config` provider entry and the tool. On OpenCode 2 it is an `openai-images` integration whose methods are exactly the key method and an env method that names only `OC_MULTI_IMAGEGEN_OPENAI_API_KEY`. The probe sets a placeholder for that variable (not a credential) in its own server, and requires the host to list it as a connection of the integration. Run `backend` in a sandbox that has not been seeded, because a saved credential is listed ahead of the environment connection and the probe expects the connection first. `backend <host> codex` checks that the Codex backend registers no sign-in, provider entry, integration or connection, after `prepare <host> allow codex`. The probe's arguments name what the sandbox should have selected; the selection itself comes from the container's `OC_MULTI_IMAGEGEN_BACKEND`, so a backend that is not selected fails the check.

`cases <host> smoke` runs two cases, G and E, in the same way as the four-case run: G asks the agent to use `imagegen` for one flat illustration at `quality low` and size `1536x1024` (a size both backends accept), and E edits that file with `images`. Check them as in "Check the results": both `imagegen` calls `completed`, `images` naming G's file in E, and two PNGs at the requested size. A completed call with the decoy as the only saved key shows the environment key was used.

To check the load failures without a model, give a host an unusable backend value and run the load checks. `prepare` records the backend in `$OC_SANDBOX/<host>/backend` (the helper forwards its text as the variable), so write the value there; an empty file gives an empty variable, which fails too:

```bash
printf dall-e >"$OC_SANDBOX/v1/backend"; printf dall-e >"$OC_SANDBOX/v2/backend"
$S tools v1                  # the ids no longer include imagegen
$S run v2 load -- run --standalone --print-logs --log-level info --model nonexistent/model hi 2>&1 | grep -E 'loading plugin|failed to load'
```

Expect `failed to load plugin` with `OC_MULTI_IMAGEGEN_BACKEND is not a known backend` (or `is empty`); the message does not repeat the value. To check the earlier option, remove the `backend` files and put `["file:///pluginpkg", { "backend": "openai-api" }]` in the OpenCode 1 config's `plugin` list, or `{ "package": "/pluginpkg", "options": { "backend": "openai-api" } }` in the OpenCode 2 config's `plugins`, and run the same commands: the load fails with a message that names `OC_MULTI_IMAGEGEN_BACKEND`.

`lifecycle v2` edits the default Codex configuration, so run it on a sandbox prepared without a backend.

## Last validated run

Codex backend, run on 2026-10-20 with the pinned versions above, plugin source at commit `a183e39` (clean worktree), built `dist/index.js` sha256 `7e0ffb0354539d4a4210abfce51b11459083a50ef02140d27b892a8a9d50ce04`, tarball sha256 `d9964c9ebb259dd74aa5db48e288d337386087ece8a7ec2c737f433e2639d31c`, agent model `openai/gpt-6.1-sol-fast`. The package under test came from `npm pack` with `npm install --omit=dev`; no `@opencode*` package was installed. This is one model on one ChatGPT account, so it shows what happened in these runs and says nothing about other models.

- Load, no model: `tools v1` (1.19.3) and `tools v1-floor` (1.18.29) listed `imagegen`. `skills v1`, `skills v1-floor` and `skills v2` each listed `oc-multi-imagegen` with the packaged body (compared after trimming), from `/pluginpkg/skills/oc-multi-imagegen/SKILL.md`; OpenCode 2 listed it with `autoinvoke: true`. With a user `skills.paths` entry added, both OpenCode 1 versions listed the user's skill and ours. On OpenCode 1, a marker appended to the sandbox `SKILL.md` appeared on the next start, and an empty `plugin` list removed the skill. `lifecycle v2` on 2.0.32 printed `loaded: entries=1 marker=0`, `updated: entries=1 marker=1`, `removed: entries=0`. The OpenCode 2 load line was logged with no failure.
- Package from an unrelated working directory: loading `server.js` from the extracted production package with plain `node` registered `imagegen` and the skill, resolved the skills directory inside that package, and added it once to a config that already held a path and a URL.
- Image scenarios (A to D, skill allowed, plain-language prompts): on OpenCode 1.19.3 and OpenCode 2.0.32 the agent called the `skill` tool for `oc-multi-imagegen` before its first `imagegen` in all eight cases, then called `imagegen` successfully, then read the result. B used `background: transparent` and the sticker came back RGBA (about 66 to 67% of pixels at alpha 0, 32 to 33% at 224 to 254, about 1% in between, 0.1% at 255). C passed the generated A as `images`, and D passed the first screen as `images` when generating the second. The returned sizes were the requested ones (1672x941 for A and C, 1254x1254 for B, 1024x1536 on OpenCode 1 and 941x1672 on OpenCode 2 for D).
- Qualitative result: A and B matched their prompts, and the sticker looked clean on a dark background with a soft white outline. In C the sky and lamp changed as asked and the cliffs, cottage and lighthouse were mostly kept, but the regeneration also moved things (OpenCode 1's result lowered the horizon and rearranged the rocks; OpenCode 2's dropped the sun glint on the water). D's two screens shared one app's colours, type and navigation. Their text was coherent on OpenCode 2: the shopping screen listed 10 rows, 2 of them checked, under "8 items to pick up". It was not on OpenCode 1, whose shopping screen showed "3 of 12 items checked" over nine listed rows; the agent did not comment on that.
- Skill denied (`tool-only`, case A prompt on both hosts): the agent called `imagegen` first and only, the result was 1536x1024 RGB, and no `skill` call appeared.
- Permission and credentials: the `read` rule let agents open the generated PNGs; a `read` of the project directory was refused once per host in case C. The host `auth.json` kept its modification time (2026-10-20 19:08:47) from before the first seed to after `clean`.
- Retained for review (local and temporary, outside the repository): the event logs, the images, the packed identity, both hosts' configs, and the scripts used to read them are under `/tmp/oc-multi-imagegen-evidence/`. Nothing in them is a credential.

After the load-check probe was moved into `scripts/container-skill-probe.sh` (2026-10-21), `skills v2` and `lifecycle v2` were rerun on 2.0.32 in new sandboxes with no model and no credential. The plugin and skill were unchanged: `dist/index.js` had the same sha256 as above. With the plugin loaded, `skills v2` listed `oc-multi-imagegen` once at `/pluginpkg/skills/oc-multi-imagegen/SKILL.md` with `autoinvoke: true` and exited 0, and `lifecycle v2` printed `loaded: entries=1 marker=0`, `updated: entries=1 marker=1`, `removed: entries=0` and exited 0. With the plugin absent from the config, both commands now exit 1 after about 31 seconds, print "Probe failed: timed out waiting for oc-multi-imagegen to be listed once (saw entries=0 ...)" with the last reply and the server log, and print nothing to stdout. The earlier inline probe exited 0 in that state, and `lifecycle v2` printed `loaded: entries=0 marker=0`, `updated: entries=0 marker=0`, `removed: entries=0`. The model-driven results above did not involve the probe and were not rerun.

OpenAI Images API backend with the earlier `backend` plugin option and a key saved in each host's store, run on 2026-10-21 with the pinned versions above and plugin source at commit `6e2149e` (clean worktree). That configuration no longer exists, so this run is history: it does not show the environment source, and its `dall-e` option message is superseded by the one in the next run. `dist/index.js` sha256 `54abdf31e6a10938e3b21b77eb69ec53a732364483c98cbb926565db65bef1f9`, tarball sha256 `dfd7b0c1b819e299aa5bef58a548fb4ac67df6e4a01f16f8a2a91ff2cae4b1e0` (later commits that only change documentation change the README inside the tarball, not `dist/index.js`). The key came from an image-only dotenv file through `OC_IMAGE_KEY_ENV_FILE`; the agent model was `openai/gpt-6.1-sol-fast`.

- Registration, no model and no key: `backend <host> openai-api` exited 0 on 1.18.29, 1.19.3 and 2.0.32. OpenCode 1 reported `"openai-images":[{"type":"api","label":"OpenAI Images API"}]` from `/provider/auth`, no `openai-images` string in `/config`, and the API tool description; OpenCode 2 reported `{"id":"openai-images","name":"OpenAI Images API","methods":[{"type":"key"}]}`. After `prepare <host> allow codex`, `backend <host> codex` exited 0 on all three hosts and reported no sign-in method, provider entry or integration. `tools` listed `imagegen` on both OpenCode 1 versions. A `backend` option of `dall-e` made both OpenCode 1.19.3 and 2.0.32 log `failed to load plugin` with the message `Invalid oc-multi-imagegen options. ... expected one of "codex"|"openai-api"`; on OpenCode 1 the tool list then had no `imagegen` and `skills v1` no `oc-multi-imagegen`.
- Seeded run: with both the chat sign-in and the image key in the OpenCode 1 store, `models openai` still listed the OpenAI chat models (24 ids).
- `cases v1 smoke` on 1.19.3 and `cases v2 smoke` on 2.0.32 each exited 0 in about 58 seconds. These runs asked for 1024x1024, which the API backend accepts but Codex does not list as a preset; the smoke prompts now ask for 1536x1024. On both hosts the agent loaded the skill and called `imagegen` for G with `size 1024x1024` and `quality low`, then for E with `images` naming `smoke-generate.png` and the same size and quality; all four calls had status `completed`, and the results reported 1024x1024 pixels. The four PNGs are 1024x1024 RGB. Of the images, only OpenCode 1's G (a red paper lantern on a light background) and OpenCode 2's E (the lantern now blue, with its cap, base and cord also changed, so the edit regenerated the image rather than recolouring it) were looked at. The agent's `read` of each result also completed.
- Credentials: the host `auth.json` modification time (2026-10-21 13:20:14 +1100) was the same before the first seed and after `clean`. A scan for key-shaped strings (`sk-` followed by 20 or more key characters) found none in the case logs, the host logs or the retained evidence; it found one in the OpenCode 2 database, which holds the imported credential and is removed by `clean`.
- Retained for review (local and temporary, outside the repository): `/tmp/opencode/evidence/openai-images-backend/` holds the commands' output, the case logs, the four images, the three host configs and the packed identity. Nothing in it is a credential.

OpenAI Images API backend with the namespaced environment variables, run on 2026-10-22 with the pinned versions above and plugin source at commit `2458a1b` (clean worktree): `dist/index.js` sha256 `60b16723f63eb8dd972e0b49518f3155633489c0601bc8534a04ee788dd097ea`, tarball sha256 `a9c1333577bf431bffd9e6e70217fc7d25d46a6fd494dcefde653203f1d9d29d` (later commits that only change documentation change the README inside the tarball, not `dist/index.js`). The plugin entries were plain. The key came from an image-only dotenv file through `OC_IMAGE_KEY_ENV_FILE`; the agent model was `openai/gpt-6.1-sol-fast`.

- Registration, no model and no key (one sandbox): `backend <host> openai-api` exited 0 on 1.18.29, 1.19.3 and 2.0.32 with `OC_MULTI_IMAGEGEN_BACKEND=openai-api` in the container's environment. Both OpenCode 1 versions reported the `api` method under `openai-images`, no provider entry and the OpenAI Images API tool description. OpenCode 2 reported `{"id":"openai-images","name":"OpenAI Images API","methods":[{"type":"key"},{"type":"env","names":["OC_MULTI_IMAGEGEN_OPENAI_API_KEY"]}],"connections":[{"type":"env","name":"OC_MULTI_IMAGEGEN_OPENAI_API_KEY"}]}` with the probe's placeholder set. After `prepare <host> allow codex`, `backend <host> codex` exited 0 on all three and reported no sign-in method, provider entry, integration or connection. `tools` listed `imagegen` on both OpenCode 1 versions.
- Load failures, no model: a backend value of `dall-e`, and an empty one, made 1.19.3 and 2.0.32 log `failed to load plugin` with `OC_MULTI_IMAGEGEN_BACKEND is not a known backend` and `OC_MULTI_IMAGEGEN_BACKEND is empty`; the tool ids on 1.19.3 then had no `imagegen`. A `backend` option left in the plugin entry made both hosts log `failed to load plugin` with `The oc-multi-imagegen "backend" plugin option is no longer supported. Remove it from the plugin entry and set OC_MULTI_IMAGEGEN_BACKEND=codex|openai-api ...`. These failures were not run on 1.18.29.
- Live generation and edit with the environment key (a new sandbox): each host's store held only the synthetic saved `openai-images` key. `auth list` on 2.0.32 listed the saved API key (`stored`) before the `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` connection (`environment`), the saved-before-environment order the plugin works around; on 1.19.3 it listed `openai-images` as an `api` credential. `cases v1 smoke` on 1.19.3 and `cases v2 smoke` on 2.0.32 each exited 0. On both hosts the agent loaded the skill and called `imagegen` for G with `size 1536x1024` and `quality low`, then for E with `images` naming `smoke-generate.png`, and all four calls had status `completed` and reported 1536x1024 pixels. Because OpenAI rejects the decoy, the completed calls show the environment key was the one sent. The four PNGs are RGB 1536x1024. Of the images, only the two edits were looked at: each shows a blue lantern on a light background, and the two edits differ in the lantern's details, so the edit regenerated the lantern.
- Credentials: the host `auth.json` modification time (2026-10-22 07:19:09 +1100) was the same before the seeds, after the cases and after `clean`. `image-key.env` was absent from both host directories after `clean`, and no container was left. A scan that compares the dotenv file's key with every retained file and with key-shaped strings (`sk-` followed by 20 or more key characters) found no match in the 68 retained evidence files or in the 4,647 files of the sandbox after `clean`.
- The saved-key fallback (no variable, key saved in OpenCode) was not rerun: its code, `loadStoredCredential` on OpenCode 1 and the `active` and `resolve` calls on OpenCode 2, is unchanged apart from error text, and the 2026-10-21 run above covers it.
- Retained for review (local and temporary, outside the repository): `/tmp/opencode/evidence/imagegen-env-config/` holds the commands' output, the case logs, the images, the identity and the scripts that drove the run. Nothing in it is a credential.

Earlier runs with explicit prompts and no skill covered the same hosts with the four-case scenario. The helper's lifecycle handling (a normal exit, a timeout with status 124, SIGTERM, a `seed v2` import, a timed-out import, an unreachable daemon, and `OC_TIMEOUT=0`) was checked against the pinned images with a synthetic credential and no model; a stop that Docker cannot confirm is covered only by the unit tests' fake `docker`.

## Limits

- The agent must choose to load the skill and to call the tool. The case prompts name neither, so a run shows what one model did with them, not that every model will.
- The permission probe still names `imagegen`, because it tests the plugin's permission request and not discovery.
- Token-sharing, missing-connection and API-key credentials on OpenCode 2 are covered by the unit tests with a fake host, not by this runbook. Exercising them in a container needs a model that does not depend on the same OpenAI sign-in.
- The documented systemd unit and environment file were not run. The runs set the variables through the container environment, which is the same process environment the plugin reads.
- The interactive sign-in prompts for `openai-images` (`opencode auth login` on either host, the TUI's **Other** entry) were not driven in a container. The runs show that each host registers the method, and the seed writes the key in the format each host's store uses; they do not show a person typing a key into the prompt.
- OpenCode 1 installs its own SDK into the config directory on first start, so a run without network can start slowly or fail.
- The runbook pins one version per host. Versions between the documented minimum and the pins, and newer releases, are untested until you change the pins and run it.
- A container that ignores SIGTERM adds about 5 to 10 seconds to a timeout or interrupt while Docker waits before killing it.
