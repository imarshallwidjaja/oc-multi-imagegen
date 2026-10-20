# oc-multi-imagegen

Image generation and editing for OpenCode agents, exposed through the `imagegen` tool. One package loads in OpenCode 1 and OpenCode 2. It targets OpenCode 1.18.29 and newer and OpenCode 2.0.32 and newer; those versions are the support floors. Container runs with real agents have covered OpenCode 1.19.3 and 2.0.32 (images generated). OpenCode 1.18.29 was checked for plugin load only, and versions between the floors and those runs, or newer, are untested.

The current implementation uses ChatGPT OAuth and the Codex image backend. Provider-agnostic agentic image generation is the intended direction; additional providers, API-key authentication, and provider selection are not implemented.

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

## Authentication

Authenticate OpenCode with ChatGPT before generating, and keep credentials outside this repository. An OpenAI API key is not sufficient on either host.

OpenCode 1 reads the `openai` OAuth entry from `OPENCODE_AUTH_CONTENT` when set, otherwise from OpenCode's `auth.json` under the XDG data directory.

OpenCode 2 asks the host for the active `openai` connection on every call, so a refreshed token or a switched account applies to the next call:

- It accepts OAuth credentials created with the **Codex browser (legacy)** or **Codex device code (legacy)** sign-in methods, and sends the credential's `metadata.accountID`, when present, as the ChatGPT account.
- It rejects a **Sign in with ChatGPT** (token-sharing) connection, an API key, any other connection type, a missing connection, and an unrecognized sign-in method. The error names the two supported sign-in methods.
- It does not read `OPENCODE_AUTH_CONTENT` or `auth.json`, and it does not refresh tokens itself. When the host fails to look up or refresh the connection, that error is reported unchanged.

## Permissions

Both hosts ask for the `imagegen` permission once per call, before the plugin reads credentials or reference images or contacts the provider, so a deny rule stops the call without spending quota. A rule set that denies everything and allows only this tool runs without prompts. In OpenCode 1:

```json
{
  "permission": { "*": "deny", "imagegen": "allow" }
}
```

In OpenCode 2, the same rules go in `permissions`, with the broad rule first and the narrower one last:

```jsonc
{
  "permissions": [
    { "action": "*", "resource": "*", "effect": "deny" },
    { "action": "imagegen", "resource": "*", "effect": "allow" }
  ]
}
```

The permission covers the whole operation. It does not contain file access: `out` and `images` accept absolute paths, including paths outside the project directory.

In OpenCode 2, `imagegen` is a direct tool, so allowing it does not require allowing the `execute` tool.

## Use

Ask your agent, for example:

> Use imagegen to create a mountain lake illustration at images/lake.png, size 1672x941.

To edit or combine existing images, pass them as references:

> Use imagegen with images/lake.png as a reference to add a wooden pier on the left, saved to images/lake-pier.png, size 1672x941.

The tool accepts:

- `prompt`: description of the image to generate, or of the edit to make when `images` is set.
- `out`: destination path. Relative paths resolve against the OpenCode project directory; absolute paths are accepted.
- `size`: one of the supported sizes below.
- `images`: optional list of up to five local reference-image paths, resolved like `out`. Each file must be an image.
- `background`: optional `opaque` or `transparent`; defaults to `opaque`.

Supported sizes are `1254x1254` (1:1), `1536x1024` (3:2), `1024x1536` (2:3), `1448x1086` (4:3), `1086x1448` (3:4), `1672x941` (16:9), and `941x1672` (9:16).

Each call sends one request and saves one image. The sections below describe what the plugin does with each argument. Statements marked as recorded come from runs against the backend (recorded OpenCode container runs with real agents, and a direct-request study on one ChatGPT Pro account on 2026-10-20); the backend can change without notice.

### Size

The plugin requests the size only in the prompt: it appends a sentence such as "Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio)." The request's own `size` field is always `auto`. The returned image is saved without resizing, cropping or padding, and the tool message reports its actual pixel dimensions.

Recorded: the presets have come back at the requested dimensions, except that some runs returned an edge 1px off (for example 1672x940 for 1672x941). In the direct-request study, a sentence asking for 2048x2048 returned 1254x1254, so naming a larger size in the prompt did not produce a larger image. Resize or crop afterwards when exact dimensions are required.

### Reference images

The contents of each reference image are uploaded to the provider. A nonempty `images` list sends the request to the backend's image-editing endpoint, and the backend generates a new image guided by the references and the prompt. The plugin makes no pixel-preservation guarantee: recorded edits changed areas outside the region the prompt asked to change. Use a local image editor when untouched areas must stay identical.

### Background

`background` is passed to the backend as requested, with `opaque` as the default. The plugin does not check or modify the alpha channel of the result.

Recorded: opaque requests returned RGB PNGs and transparent requests returned RGBA PNGs with real transparency. The alpha was soft rather than a hard mask, and in the direct-request study most subject pixels sat at alpha 252 to 253 instead of fully opaque. Post-process the alpha channel when a hard cut-out or a fully opaque subject is needed.

### Output file

The file always contains the PNG bytes the backend returned. The extension in `out` does not select or convert the format: saving to `photo.jpg` writes PNG data under that name.

If the destination exists, the plugin chooses a `-v2`, `-v3`, or later suffix, up to `-v999`. This is best-effort collision avoidance, not an atomic guarantee: concurrent calls targeting the same path can overwrite each other. Use distinct output paths for parallel calls.

The result carries the saved path and whether it was versioned as `out` and `versioned` metadata on both hosts. OpenCode 2 also returns them as structured output (`{ out, versioned }`) next to the text message.

### Controls the tool does not expose

There are no model, quality, image-count or output-format arguments. Every request names `gpt-image-2` as the model, with `quality: auto` and `size: auto`. These are the fields the plugin sends, not settings the backend is known to apply. Recorded in the direct-request study: model names that do not exist were accepted, no observed response metadata identified the model that ran, and requests for `high` or `max` quality returned low or medium quality.

The plugin's validation removes unknown arguments such as `quality`, so they never reach the provider. A host can also drop or reject them before the call.

### Validation, cancellation and failures

Arguments are validated before any permission request or provider call. Stopping the call forwards the cancellation to the provider request, and an image that arrives after cancellation is not saved. A cancelled or failed call is not retried.

## Current limits

The plugin relies on the ChatGPT Codex backend and its availability, account permissions, and usage limits. The fixed request fields and recorded backend behavior are described under "Use". Provider identifiers in the implementation describe the current integration, not a multi-provider interface.

In OpenCode 2, relative `out` and `images` paths resolve against the directory of the session that made the call, which can differ from the directory the plugin loaded in.

Generation sends prompts and reference images to OpenAI and may consume account quota. This is an unofficial integration, not an OpenAI or OpenCode product. The MIT software license does not grant access to a provider service or replace that service's terms.

## Development checks

```sh
bun run test
bun run typecheck
bun run check
bun run build
npm pack --dry-run
```

`test` runs only the mocked unit suite. `check` checks formatting and lint without rewriting files. The package includes the built entry point, `server.js`, README, license, and package metadata; local source references under `.tmp` are ignored.

The optional `bun run test:e2e` suite launches OpenCode and makes real authenticated image-generation calls. Run it only when you intend to use account quota. Set `OPENCODE_MODEL` to select the agent model, or leave it unset to use OpenCode's default. Live generation is separate from unit checks and CI.

To try the plugin with real agents in OpenCode 1 and OpenCode 2 containers, follow `docs/container-testing.md` in a source checkout of this repository. The runbook and its `scripts/` helpers are not part of the npm package. It is an ad-hoc procedure that also uses account quota, not an automated check.

## License

[MIT](./LICENSE). The original copyright and permission notice are retained as required by that license.
