# Backends

[README](../README.md) · [Getting started](getting-started.md) · [Tool reference](tool-reference.md)

One backend is active per plugin load. The selected backend controls the registered tools, their arguments and their defaults.

| `OC_MULTI_IMAGEGEN_BACKEND` | Provider | Credential | Tools |
| --- | --- | --- | --- |
| Unset or `codex` | ChatGPT Codex image backend | OpenCode's ChatGPT sign-in for `openai` | `imagegen` |
| `openai-api` | Official OpenAI Images API | `OC_MULTI_IMAGEGEN_OPENAI_API_KEY`, otherwise saved `openai-images` key | `imagegen` |
| `nano-gpt` | NanoGPT normalized image API | `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY`, otherwise saved `nano-gpt-images` key | `imagegen`, `imageedit`, `imagegen_models` |

Changing the backend takes a server restart. A call can't select another backend, and a failure doesn't trigger a retry or fallback to another backend.

## Configuration

The plugin reads three environment variables:

| Variable | Behavior |
| --- | --- |
| `OC_MULTI_IMAGEGEN_BACKEND` | Read once at plugin load. Empty or unknown values fail the load without registering image tools. |
| `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` | Image key for `openai-api` only, resolved on each call. |
| `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` | Image key for `nano-gpt` only, resolved on each call. |

The plugin takes no options and reads no `.env` or other configuration file. Remove a `backend` option left by an older build; it now fails the load with a message naming the environment variable to use. Other plugin options also fail.

Set variables in the environment of the OpenCode **server**. Exporting one in a shell that only starts a client attached to a running server doesn't change that server's environment.

### systemd example

For a system service named `opencode.service`, an OpenAI API configuration can use:

```ini
[Service]
Environment=OC_MULTI_IMAGEGEN_BACKEND=openai-api
EnvironmentFile=/etc/opencode/oc-multi-imagegen.env
```

The environment file contains a placeholder here; store the real file with mode `600`:

```sh
OC_MULTI_IMAGEGEN_OPENAI_API_KEY=<OpenAI Images API key>
```

Run `systemctl daemon-reload` and `systemctl restart opencode.service` after changing the unit or its environment file. For a user unit, use `systemctl --user daemon-reload` and `systemctl --user restart opencode.service`, with an environment file you own, such as `%h/.config/opencode/oc-multi-imagegen.env`.

Use `nano-gpt` and `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` for NanoGPT. Keep keys in restricted environment files rather than readable unit files. These files are read by systemd, not by the plugin.

## Codex

Codex uses OpenCode's ChatGPT sign-in. Access depends on your account and the availability and limits of the ChatGPT Codex image backend; an OpenAI API key doesn't authenticate it.

- **OpenCode 1** reads the `openai` OAuth entry from `OPENCODE_AUTH_CONTENT` when set, otherwise from `auth.json` under OpenCode's XDG data directory.
- **OpenCode 2** resolves the active `openai` connection on every call. It accepts **Codex browser (legacy)** and **Codex device code (legacy)**, with the connection's account ID when present. It rejects the **Sign in with ChatGPT** token-sharing method, API keys, missing connections and unrecognized methods. Host credential lookup or refresh errors propagate unchanged.

OpenCode 2 doesn't read `OPENCODE_AUTH_CONTENT` or `auth.json`, and the plugin doesn't refresh OAuth tokens. Neither image API key variable affects Codex.

The default request names `gpt-image-2` with `quality: auto`. Model and quality overrides are sent as requested, but the Codex response doesn't identify the settings it applied. In a direct-request study on one ChatGPT Pro account on 2026-10-20, requests accepted nonexistent model names and didn't reliably honor requested quality tiers. Treat these controls as **requested, not verified**; a call using either override reports that distinction. See [sizes and output](tool-reference.md#sizes) for the similar distinction between requested and returned dimensions.

## OpenAI Images API

This backend uses a key separate from the `openai` chat provider. The plugin sends it only to OpenAI's `/v1/images/generations` or `/v1/images/edits` endpoint when an image is requested. Loading the plugin doesn't check the key or make a network request.

The request defaults to model `gpt-image-2.5-sunburst` and quality `auto`. Any `model` or `quality` string is passed through; the API decides whether the model exists, the key can use it and the settings are supported. API calls bill the key's account. HTTP errors include the status and response body, with the key removed.

### Key precedence

1. If `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` is **present**, it is the credential. A present empty value or a value unsuitable for an HTTP header fails the call without consulting a saved key. A rejected key is reported once, without trying another credential.
2. Otherwise, the plugin uses the `openai-images` key saved in OpenCode.

It never reads `OPENAI_API_KEY`, which might be a chat key, or loads a dotenv file.

### Save a key in OpenCode

- **OpenCode 1:** run `opencode auth login --provider openai-images`, or choose **Other** in the provider list and enter `openai-images`. The host saves an `api` entry. The plugin registers an API sign-in method, not a chat provider or model.
- **OpenCode 2:** run `opencode auth login openai-images`, or connect the **OpenAI Images API** integration. It registers key and environment methods. When the variable is present, the plugin asks the host to resolve that environment connection directly, even if the host lists a saved key first. Otherwise it resolves the active saved connection.

OpenCode 1 reads the variable itself after permission. Without it, it follows the host's stored-auth behavior: `OPENCODE_AUTH_CONTENT`, falling through to `auth.json` if that content doesn't parse. OpenCode 2 only checks variable presence and lets the host read the value; it never falls back to those files. Missing or non-key credentials produce a message naming the variable or sign-in command. Chat credentials are never used as an image key.

## NanoGPT

Select `nano-gpt` and provide `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` in the server environment, or save a key under `nano-gpt-images`:

- **OpenCode 1:** `opencode auth login --provider nano-gpt-images`.
- **OpenCode 2:** `opencode auth login nano-gpt-images`, or connect the **NanoGPT API** integration.

Environment-over-saved precedence, failure behavior and per-host resolution work as for the OpenAI image key. The plugin doesn't read the other backends' keys, `NANOGPT_API_KEY` or dotenv files. It sends the key only to `https://api.nano-gpt.com/api/v1/images`. Result downloads carry no key.

### Generation and editing models

Every image call names an exact supported model ID. `imagegen` creates from text; `imageedit` requires references. Use the local `imagegen_models` tool to find the right model and its input schema without a key, file access or network request.

| Family | `imagegen` model | `imageedit` model | Optional controls | Edit references |
| --- | --- | --- | --- | --- |
| GPT Image 2.5 Flare | `openai/gpt-image-2.5/flare/text-to-image` | `openai/gpt-image-2.5/flare/edit` | `resolution`, `aspect_ratio`, `quality`, `background` | Up to 16 |
| Nano Banana Pro | `nano-banana-pro` | `nano-banana-pro-edit` | `resolution`, `aspect_ratio` | Up to 10 |
| FLUX.3 Image | `black-forest-labs/flux-3/text-to-image` | `black-forest-labs/flux-3/edit` | `resolution`, `aspect_ratio` | Up to 10 |
| Seedream 5.0 Pro | `bytedance/seedream-v5.0-pro` | `bytedance/seedream-v5.0-pro` or `bytedance/seedream-v5.0-pro/edit` | `resolution`, including ratios such as `16:9` | Up to 10, each at most 10 MiB |
| Qwen Image 2.1 | `qwen-image-2.1/text-to-image` | `qwen-image-2.1/edit` | `resolution`, `aspect_ratio`, `seed` | Up to 10 |
| Qwen Image 3 Pro | `qwen-image-3-pro` | `qwen-image-3-pro` | `resolution` (`1k`, `2k`), `aspect_ratio` (including `auto`) | Up to 3, each at most 10 MiB |
| WAN 2.7 Image Pro | `wan2.7-image-pro` | `wan2.7-image-pro` | `resolution`; generation includes `4k`, editing excludes it | Up to 9 |
| Muse Image | `meta/muse-image/text-to-image` | `meta/muse-image/text-to-image` | `resolution` carries the aspect ratio | Up to 10 |

The last three families and Seedream's base ID use the same exact ID with both tools. The tool and reference list select the operation; IDs are sent verbatim. Seedream's explicit `/edit` ID remains an additional edit route, not a generation route or a rewritten alias. The catalogue contains 17 operation entries for 13 distinct IDs. An exact-ID lookup describes every matching operation and returns separate argument schemas keyed by `imagegen` and `imageedit` when both apply.

Qwen Image 3 Pro limits a trimmed prompt to 800 Unicode code points. Its provider documents reference dimensions of 384 to 2048 pixels per side; the plugin does not enforce those pixel sizes. Seedream, WAN and Muse have no established prompt-length limit in this table. WAN's model page states 4K generation and 2K editing, so the plugin conservatively excludes `4k` from editing despite the endpoint's combined value list. WAN and Muse have no separate `aspect_ratio`, seed or output-format control. Muse's page describes WebP as its default; native output handling saves the returned format.

Controls left out of a call aren't sent, so NanoGPT applies its defaults. An unsupported control, value, model, operation or unknown argument is rejected before a provider request. No generic passthrough or runtime catalogue fetch is provided; new NanoGPT models need an update to the plugin's table.

Agents are guided to respect the operator's model choice, otherwise pick a supported model and give a short reason. Missing inputs or conflicts with a requested model, capability, cost or requirement need the operator's decision. Errors never silently change a model. Authentication, balance and rate-limit failures aren't retried; an agent should only correct an input when the error identifies a demonstrable mistake.

The curated table follows NanoGPT documentation and public metadata, which are incomplete and inconsistent between sources. A missing control means this plugin doesn't send it, rather than proving the provider lacks it. [Response handling and limits](tool-reference.md#nanogpt-responses-and-errors) explain the supported result shapes.

### NanoGPT live workflow coverage

On 2026-11-02, standalone OpenCode 1.19.0 with chat model `openai/gpt-6-astra` ran one three-call chain per family below: a scene, a rainy reference edit and a character extraction using the preceding returned path. All 12 calls completed without retries; the scene generations and rainy edits worked. Each extraction prompt requested transparency without a `background` argument, which these four families do not expose.

| Family | Controls used | Observed native outputs | Extraction outcome |
| --- | --- | --- | --- |
| Nano Banana Pro | `resolution: 1k`, `aspect_ratio: 16:9` for scenes, `1:1` for extraction | PNG 1376x768, then PNG 1024x1024 | Opaque painted checkerboard. |
| FLUX.3 Image | `resolution: 1k`, `aspect_ratio: 16:9` for scenes, `1:1` for extraction | PNG 1360x768, then PNG 1024x1024 | RGBA with every pixel opaque and a painted checkerboard. |
| Seedream 5.0 Pro | `resolution: 16:9` for scenes, `1:1` for extraction | JPEG 2730x1536, then JPEG 2048x2048 | Opaque near-white background. Requested `.png` paths became `.jpg` and the returned paths chained successfully. |
| Qwen Image 2.1 | `resolution: 1k`, `aspect_ratio: 16:9` for scenes, `1:1` for extraction | PNG 1376x768, then PNG 1024x1024 | Real alpha: 334,292 transparent, 493,113 partial and 221,171 opaque pixels. The requested envelope appeared on the office door in the scenes and was absent from the extraction. |

An earlier, separately run GPT Image 2.5 Flare three-call chain produced a transparent PNG cut-out, confirmed by inspection of the retained file. That chain was not rerun on the candidate used for the four chains above. Flare is the only supported family exposing `background`; Qwen's result came from the prompt alone, not a background control.

These are single-chain observations, not guarantees of transparency or reliability. They do not cover every parameter, resolution or native output format, or establish OpenCode 2 live parity. Actual image and chat charges were not measured. Inspect alpha and the visual result: a PNG, RGBA channel or checkerboard appearance alone does not prove transparency.

#### Same-ID generation and editing sample

Also on 2026-11-02, the direct-tool runner at `scripts/nanogpt-live.ts` exercised code commit `ba3223105b4737d89b0649f1e5aa42dc055a59a4` in a separate Bun process. It used the real backend's shared `tool.run` flow and existing credential resolver after its permission hook. All ten serial image requests returned HTTP 200 and one image, with no retries. Two deterministic 512x512 PNGs supplied the edits: a teal circular subject with white eyes, purple rectangular mouth and red torso, followed by a blue-and-yellow checker pattern. Those specific attributes were absent from the edit prompt, which assigned subject identity to Image 1 and the umbrella pattern to Image 2.

| Exact ID | Generation controls and output | Edit controls and output | Visual observation |
| --- | --- | --- | --- |
| `qwen-image-3-pro` | `resolution: 1k`, `aspect_ratio: auto`; PNG 1024x1024 | `resolution: 1k`; PNG 1024x1024 | Copper robot, watering can and three sunflowers in the generation. Edit kept the reference face, colors and red torso, added a blue-and-yellow checker umbrella and rainy garden. |
| `bytedance/seedream-v5.0-pro` | `resolution: 1k`; JPEG 1024x1024 | `resolution: 1k`; JPEG 864x1152 | Generation followed the robot/garden prompt. Edit kept the distinctive subject and pattern, added limbs and a rainy garden; composition changed to portrait. |
| `wan2.7-image-pro` | `resolution: 4k`; PNG 4096x4096 | `resolution: 2k`; PNG 2048x2048 | Generation followed the robot/garden prompt. Edit kept the reference face, colors and red torso under the checker umbrella in rain. All three WAN results arrived as download URLs; signed URLs were omitted from evidence. |
| `meta/muse-image/text-to-image` | `resolution: 1:1`; WebP 1600x1600 | `resolution: 1:1`; WebP 1600x1600 | Generation followed the robot/garden prompt. Edit kept the distinctive face and colors, interpreted the red torso as a coat, and applied the checker pattern to the umbrella in a rainy garden. |
| `bytedance/seedream-v5.0-pro/edit` | Edit-only route | `resolution: 1k`; JPEG 1024x1024 | Kept the reference face, colors and red torso, added legs, checker umbrella and rainy garden. The exact `/edit` ID was transmitted. |

An additional `wan2.7-image-pro` generation with `resolution: auto` returned PNG 2048x2048 and a readable robot/garden illustration. It included a crescent moon despite the sunrise prompt. The explicit probe establishes acceptance of `auto` for this sample, not a fixed output size or complete prompt adherence. All ten outputs were opened for visual inspection. Edits regenerated the scene and added details; none establishes pixel-identical preservation.

Local evidence is retained at `/tmp/opencode/nanogpt-both-live-20261102/live/report.json`, with output files, input PNGs, safe request summaries and hashes, plus `visual-review.md` in its parent directory. A separate `preflight/report.json` retains the deliberately failed synthetic transport run. The live run used the source module directly, not either running host adapter or the generated bundle. Both adapters' exact requests are covered by mocked tests; this sample does not establish live host parity. Actual charges were not measured. No output format was forced on these routes, and JPEG/WebP bytes were saved with matching extensions.

## Compatibility and recorded coverage

| Host | Support floor | Recorded coverage |
| --- | --- | --- |
| OpenCode 1 | 1.18.29 | 1.19.3: real-agent Codex and OpenAI API runs. Floor: plugin/skill load and OpenAI API sign-in registration only. |
| OpenCode 2 | 2.0.32 | 2.0.32: real-agent Codex and OpenAI API runs. |

The Codex container runs covered skill loading and image generation before backend selection existed. OpenAI API runs covered generation and a reference edit on each host, including environment-key precedence and, in an earlier run, saved keys. Intermediate or newer host versions aren't established by those runs. The [container runbook](https://github.com/imarshallwidjaja/oc-multi-imagegen/blob/main/docs/container-testing.md) retains the recorded evidence and source identities.

The README artwork is a separate live Codex example chain, not a new container compatibility run. NanoGPT's standalone live coverage is described above and does not establish container or OpenCode 2 parity.

## Account access and data

Prompts and reference images go to the active provider. Calls may consume ChatGPT quota or API credit, and the plugin doesn't probe key scope or model availability beforehand. Credentials are resolved per call after permission and are never written, activated or refreshed by the plugin.

This is an unofficial integration, not an OpenAI or OpenCode product. The MIT license covers the software, not provider access or service terms.
