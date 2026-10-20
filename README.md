# oc-multi-imagegen

Image generation and editing for OpenCode agents, exposed through the `imagegen` tool.

The current implementation uses ChatGPT OAuth and the Codex image backend. Provider-agnostic agentic image generation is the intended direction; additional providers, API-key authentication, and provider selection are not implemented.

## Local setup

Install Bun and OpenCode, then run these commands in this checkout:

```sh
bun install --frozen-lockfile
bun run build
```

Add the checkout's absolute file URL to your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/oc-multi-imagegen"]
}
```

Replace the example path with your checkout path. Rebuild after changing source files and restart OpenCode to load the new build. This setup uses the local package; it does not assume a registry release exists.

Authenticate OpenCode with ChatGPT before generating. The plugin reads the `openai` OAuth entry from `OPENCODE_AUTH_CONTENT` when set, otherwise from OpenCode's `auth.json` under the XDG data directory. An OpenAI API key is not sufficient. Keep credentials outside this repository.

## Use

Ask your agent, for example:

> Use imagegen to create a mountain lake illustration at images/lake.png, size 1672x941.

The tool accepts:

- `prompt`: description of the image to generate or the edit to make.
- `out`: destination path. Relative paths resolve against the OpenCode project directory; absolute paths are accepted. The content written is PNG.
- `size`: one of the supported sizes below.
- `images`: optional list of up to five local reference-image paths, resolved like `out`. Their contents are sent to the provider.
- `background`: optional `opaque` or `transparent`; defaults to `opaque`.

Supported sizes are `1254x1254` (1:1), `1536x1024` (3:2), `1024x1536` (2:3), `1448x1086` (4:3), `1086x1448` (3:4), `1672x941` (16:9), and `941x1672` (9:16).

Each call returns one saved image. Requests with references use the backend's image-editing endpoint. The tool reports the saved path and actual PNG dimensions; dimensions can differ from the requested size by a pixel. Resize or crop afterwards when exact dimensions are required.

If the destination exists, the plugin chooses a `-v2`, `-v3`, or later suffix, up to `-v999`. This is best-effort collision avoidance, not an atomic guarantee: concurrent calls targeting the same path can overwrite each other. Use distinct output paths for parallel calls.

## Current limits

The plugin relies on the ChatGPT Codex backend and its availability, account permissions, and usage limits. It sends `gpt-image-2` as the model identifier, with automatic quality and backend size settings; the requested dimensions are added to the prompt. Provider identifiers in the implementation describe the current integration, not a multi-provider interface.

Generation sends prompts and reference images to OpenAI and may consume account quota. This is an unofficial integration, not an OpenAI or OpenCode product. The MIT software license does not grant access to a provider service or replace that service's terms.

## Development checks

```sh
bun run test
bun run typecheck
bun run check
bun run build
npm pack --dry-run
```

`test` runs only the mocked unit suite. `check` checks formatting and lint without rewriting files. The package includes the built entry point, README, license, and package metadata; local source references under `.tmp` are ignored.

The optional `bun run test:e2e` suite launches OpenCode and makes real authenticated image-generation calls. Run it only when you intend to use account quota. Set `OPENCODE_MODEL` to select the agent model, or leave it unset to use OpenCode's default. Live generation is separate from unit checks and CI.

## License

[MIT](./LICENSE). The original copyright and permission notice are retained as required by that license.
