# oc-multi-imagegen

Image generation and editing for OpenCode agents, exposed through the `imagegen` tool. One package loads in OpenCode 1 and OpenCode 2. It targets OpenCode 1.18.29 and newer and OpenCode 2.0.32 and newer; those versions are the support floors. Container runs with real agents have covered OpenCode 1.19.3 and 2.0.32 with the Codex backend (skill loaded, images generated; run before the `backend` option existed) and with the OpenAI Images API backend (one generation and one reference edit). OpenCode 1.18.29 was checked for plugin load, skill registration and, for the OpenAI Images API backend, sign-in registration only, and versions between the floors and those runs, or newer, are untested.

The package also ships one skill, `oc-multi-imagegen`, with the technique for image work: choosing raster or code, labelling reference images, correcting a result, keeping related images consistent, transparency, and checking what came back. The `imagegen` description tells agents to load it before image work when it is available and permitted, and the tool works without it.

The plugin runs one image backend per load, chosen with the `backend` plugin option:

| `backend` | Calls | Credential |
| --- | --- | --- |
| `codex` (default) | the ChatGPT Codex image backend | OpenCode's ChatGPT sign-in for the `openai` provider |
| `openai-api` | the official OpenAI Images API | an OpenAI Images API key saved in OpenCode as the `openai-images` credential |

The active backend decides the tool's arguments, defaults, limits and description, so an agent sees only the backend that will run. Changing the option and restarting OpenCode switches the tool; there is no per-call backend argument and no fallback from one backend to the other.

## Local setup

Install Bun and OpenCode, then run these commands in this checkout:

```sh
bun install --frozen-lockfile
bun run build
```

Add the checkout's absolute file URL to your OpenCode configuration. OpenCode 1 reads the `plugin` list:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/oc-multi-imagegen"]
}
```

OpenCode 2 reads the `plugins` list:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/oc-multi-imagegen"]
}
```

Replace the example path with your checkout path. Rebuild after changing source files and restart OpenCode to load the new build. This setup uses the local package; it does not assume a registry release exists. Both hosts load the same build: OpenCode 1 calls the default export's `server()`, OpenCode 2 calls its `setup()`, and the package root also exposes `server.js` (the `./server` export) because OpenCode 2 looks for `server` before the package's `main`. The package imports neither OpenCode SDK at runtime.

Both hosts find the skill without skills configuration. OpenCode 1's `config` hook adds the package's absolute `skills/` directory to `skills.paths` once, and keeps your own `paths` and `urls`. OpenCode 2 registers the skill from the plugin and leaves an existing skill with the same id alone. Neither host gets a copy in a user directory. If a skill named `oc-multi-imagegen` also comes from elsewhere, OpenCode 1 keeps one of the two without a defined order. A package whose `skills/` file is missing or malformed fails when the plugin loads, with a message that names the file.

## Choosing a backend

Pass the `backend` option in the plugin entry. The default is `codex`; `openai-api` selects the official API. An unknown value or unknown option makes the plugin fail to load: the host logs `failed to load plugin` with a message that names the problem, and the `imagegen` tool is not registered.

OpenCode 1 takes plugin options as the second element of a `plugin` entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["file:///absolute/path/to/oc-multi-imagegen", { "backend": "openai-api" }]]
}
```

OpenCode 2 takes them in the object form of a `plugins` entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "file:///absolute/path/to/oc-multi-imagegen", "options": { "backend": "openai-api" } }]
}
```

## Authentication

Credentials stay in OpenCode's own store, outside this repository. The plugin reads only the entry of the active backend, on every call, and never writes, refreshes or activates a credential.

### Codex backend

Authenticate OpenCode with ChatGPT before generating. An OpenAI API key is not sufficient for this backend on either host.

OpenCode 1 reads the `openai` OAuth entry from `OPENCODE_AUTH_CONTENT` when set, otherwise from OpenCode's `auth.json` under the XDG data directory.

OpenCode 2 asks the host for the active `openai` connection on every call, so a refreshed token or a switched account applies to the next call:

- It accepts OAuth credentials created with the **Codex browser (legacy)** or **Codex device code (legacy)** sign-in methods, and sends the credential's `metadata.accountID`, when present, as the ChatGPT account.
- It rejects a **Sign in with ChatGPT** (token-sharing) connection, an API key, any other connection type, a missing connection, and an unrecognized sign-in method. The error names the two supported sign-in methods.
- It does not read `OPENCODE_AUTH_CONTENT` or `auth.json`, and it does not refresh tokens itself. When the host fails to look up or refresh the connection, that error is reported unchanged.

### OpenAI Images API backend

This backend uses its own credential, `openai-images`, separate from the `openai` chat provider. A key saved under `openai` would also be the chat provider's key, so a separate credential lets you create a key at OpenAI that is limited to image generation. Whatever permissions the key has are yours to set; the plugin does not inspect them and sends the key only to `https://api.openai.com/v1/images/generations` and `https://api.openai.com/v1/images/edits`, when an image is requested. Loading the plugin makes no network request and checks no key.

With `backend` set to `openai-api`, the plugin registers a sign-in method for `openai-images`, so OpenCode stores the key itself:

- OpenCode 1: run `opencode auth login --provider openai-images` and enter the key, or choose **Other** in the provider list and enter the id `openai-images`. OpenCode saves it as an `api` entry in `auth.json`. The plugin reads that entry from `OPENCODE_AUTH_CONTENT` when set (content that does not parse falls through to `auth.json`, as in OpenCode), otherwise from `auth.json`. It registers no provider or model, so chat model selection is unchanged.
- OpenCode 2: run `opencode auth login openai-images`, or connect the **OpenAI Images API** integration in the host, and enter the key. The plugin asks the host for the active `openai-images` connection and resolves it on every call. It does not read `OPENCODE_AUTH_CONTENT`, `auth.json`, environment variables or `.env` files.

A missing or non-key credential fails the call with the sign-in command to run. The OpenAI chat sign-in is never used as an image key, and the image key is never used for chat. An error from the API is reported with its status and body, with the key removed from the text.

## Permissions

Both hosts ask for the `imagegen` permission once per call, before the plugin reads credentials or reference images or contacts the provider, so a deny rule stops the call without spending quota. A rule set that denies everything and allows this tool and the skill runs without prompts. In OpenCode 1:

```json
{
  "permission": {
    "*": "deny",
    "imagegen": "allow",
    "skill": { "*": "deny", "oc-multi-imagegen": "allow" }
  }
}
```

In OpenCode 2, the same rules go in `permissions`, with the broad rule first and the narrower ones last:

```jsonc
{
  "permissions": [
    { "action": "*", "resource": "*", "effect": "deny" },
    { "action": "imagegen", "resource": "*", "effect": "allow" },
    { "action": "skill", "resource": "oc-multi-imagegen", "effect": "allow" }
  ]
}
```

The `skill` rule is optional. The skill is guidance, and the plugin never asks for the `skill` permission: with `imagegen` allowed and `skill` denied, the agent still generates images, using only the guidance in the tool description. An allowed `skill` rule with `imagegen` denied lets the agent load the guidance but not generate.

The permission resource is the active backend's id, `codex` or `openai-api`, so a grant saved for one backend (for example "always allow" in a prompt) does not cover the other. The `*` rules above match both. To allow only the official API, write the rule on that resource: in OpenCode 1 `"imagegen": { "*": "deny", "openai-api": "allow" }`, in OpenCode 2 `{ "action": "imagegen", "resource": "openai-api", "effect": "allow" }`. A call that uses billed API credit asks nothing beyond this permission.

The permission covers the whole operation. It does not contain file access: `out` and `images` accept absolute paths, including paths outside the project directory. An agent that should look at the result needs a `read` rule too; scope it to the files you mean (for example `*.png`), because `read` opens whatever its rule matches.

In OpenCode 2, `imagegen` is a direct tool, so allowing it does not require allowing the `execute` tool.

## Use

Ask your agent for an image; naming the tool is not required. In the recorded container runs (one model, one account), requests that named neither `imagegen` nor the skill made the agent load the skill and then call `imagegen`. For example:

> Create a wide illustration of a mountain lake at dawn and save it as images/lake.png.

To edit or combine existing images, name the files in the request:

> Add a wooden pier on the left of images/lake.png and save the result as images/lake-pier.png.

The agent chooses any size you leave out and passes existing files as `images`. The tool accepts:

- `prompt`: description of the image to generate, or of the edit to make when `images` is set.
- `out`: destination path. Relative paths resolve against the OpenCode project directory; absolute paths are accepted.
- `size`: required. A preset on the Codex backend, a native `WIDTHxHEIGHT` on the OpenAI Images API backend (see "Size").
- `images`: optional list of local reference-image paths, resolved like `out`: up to five on Codex, up to 16 PNG, JPEG or WebP files on the OpenAI Images API.
- `background`: optional `opaque` or `transparent`; defaults to `opaque`.
- `model` and `quality`: optional strings, sent to the backend unchanged. Without them the backend's defaults apply (see "Model and quality").

Each call sends one request and saves one image. The sections below describe what the plugin does with each argument. Statements marked as recorded come from runs against the Codex backend (recorded OpenCode container runs with real agents, and a direct-request study on one ChatGPT Pro account on 2026-10-20); that backend can change without notice.

### Size

On the OpenAI Images API backend, `size` is a native `WIDTHxHEIGHT` in pixels, sent to the API unchanged, for example `1536x864`. The plugin checks only the documented syntax before spending anything: both numbers are positive multiples of 16 and the aspect ratio is between 1:3 and 3:1. Pixel and edge limits depend on the model, so the API enforces them and its error is reported. The documentation marks resolutions above 2560x1440 as experimental and gives 3840x2160 as the maximum; larger sizes also cost more. The plugin does not map, round or clamp the size.

On the Codex backend, `size` is one of `1254x1254` (1:1), `1536x1024` (3:2), `1024x1536` (2:3), `1448x1086` (4:3), `1086x1448` (3:4), `1672x941` (16:9), and `941x1672` (9:16). The plugin requests it only in the prompt: it appends a sentence such as "Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio)." The request's own `size` field is always `auto`.

In both cases the returned image is saved without resizing, cropping or padding, and the tool message reports its actual pixel dimensions. Recorded on Codex: the presets have come back at the requested dimensions, except that some runs returned an edge 1px off (for example 1672x940 for 1672x941). In the direct-request study, a sentence asking for 2048x2048 returned 1254x1254, so naming a larger size in the prompt did not produce a larger image. Resize or crop afterwards when exact dimensions are required.

### Model and quality

On the OpenAI Images API backend, the defaults are model `gpt-image-2.5-sunburst` and quality `auto`. Any `model` or `quality` string is sent as given, with no local allowlist, so the API decides whether it exists and whether the key may use it; its error is reported unchanged. Access to a model depends on the account and is not checked beforehand.

On the Codex backend, the requests name `gpt-image-2` with `quality: auto` unless `model` or `quality` is given, in which case that value replaces the default. These are the fields the plugin sends, not settings the backend is known to apply. Recorded in the direct-request study: model names that do not exist were accepted, no observed response metadata identified the model that ran, and requests for `high` or `max` quality returned low or medium quality. When a call sets either value, the result text says the setting was requested and that the Codex response does not report which settings it applied.

### Reference images

Name each reference's role in the prompt ("Image 1: style; Image 2: layout"); the references are sent in the order given. The contents of each reference image are uploaded to the provider. A nonempty `images` list sends the request to the backend's image-editing endpoint, and the backend generates a new image guided by the references and the prompt. The plugin makes no pixel-preservation guarantee: recorded Codex edits changed areas outside the region the prompt asked to change. Use a local image editor when untouched areas must stay identical.

The OpenAI Images API backend sends the references as base64 data URLs in the documented JSON body. It rejects a reference that is not PNG, JPEG or WebP, or whose data URL is longer than the documented 20,971,520 characters, before any request.

### Background

`background` is passed to the backend as requested, with `opaque` as the default. The plugin does not check or modify the alpha channel of the result.

Recorded on Codex: opaque requests returned RGB PNGs and transparent requests returned RGBA PNGs with real transparency. The alpha was soft rather than a hard mask, and in the direct-request study most subject pixels sat at alpha 252 to 253 instead of fully opaque. Post-process the alpha channel when a hard cut-out or a fully opaque subject is needed.

### Output file

The file always contains the PNG bytes the backend returned. The OpenAI Images API request asks for PNG output. The extension in `out` does not select or convert the format: saving to `photo.jpg` writes PNG data under that name. Data that is not a PNG is rejected before any directory or file is created.

If the destination exists, the plugin chooses a `-v2`, `-v3`, or later suffix, up to `-v999`. This is best-effort collision avoidance, not an atomic guarantee: concurrent calls targeting the same path can overwrite each other. Use distinct output paths for parallel calls.

The result carries the saved path and whether it was versioned as `out` and `versioned` metadata on both hosts. OpenCode 2 also returns them as structured output (`{ out, versioned }`) next to the text message.

### Controls the tool does not expose

There are no image-count or output-format arguments. The OpenAI Images API request always asks for one PNG image without streaming, and no backend receives other arguments: the plugin's validation removes unknown arguments such as `n`, so they never reach the provider. A host can also drop or reject them before the call.

### Validation, cancellation and failures

Arguments are validated before any permission request or provider call. Stopping the call forwards the cancellation to the provider request, and an image that arrives after cancellation is not saved. A cancelled or failed call is not retried and does not fall back to the other backend.

## Current limits

The Codex backend relies on the ChatGPT Codex backend and its availability, account permissions, and usage limits. The OpenAI Images API backend relies on the official API: its calls bill the key's account, and model access, rate limits and size limits are the API's. The plugin does not probe the key's scope or a model's availability; those show up as the API's error on the call that needs them.

In OpenCode 2, relative `out` and `images` paths resolve against the directory of the session that made the call, which can differ from the directory the plugin loaded in.

Generation sends prompts and reference images to OpenAI and may consume account quota or API credit. This is an unofficial integration, not an OpenAI or OpenCode product. The MIT software license does not grant access to a provider service or replace that service's terms.

## Development checks

```sh
bun run test
bun run typecheck
bun run check
bun run build
npm pack --dry-run
```

`test` runs only the mocked unit suite. It includes a check that packs the package, bundles the entry point into the extracted copy, and resolves the skill from there; it shows the skill ships and is found relative to the module, and it does not exercise the exact built `dist/index.js` or its dependencies, which the container runbook covers. `check` checks formatting and lint without rewriting files. The package includes the built entry point, `server.js`, the `skills/` directory, README, license, and package metadata; local source references under `.tmp` are ignored.

The optional `bun run test:e2e` suite launches OpenCode and makes real authenticated image-generation calls. Run it only when you intend to use account quota. Set `OPENCODE_MODEL` to select the agent model, or leave it unset to use OpenCode's default. Live generation is separate from unit checks and CI.

To try the plugin with real agents in OpenCode 1 and OpenCode 2 containers, follow `docs/container-testing.md` in a source checkout of this repository. The runbook and its `scripts/` helpers are not part of the npm package. It is an ad-hoc procedure that also uses account quota, not an automated check.

## License

[MIT](./LICENSE). The original copyright and permission notice are retained as required by that license.
