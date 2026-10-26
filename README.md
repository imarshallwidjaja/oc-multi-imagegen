# oc-multi-imagegen

Image generation and editing for OpenCode agents, exposed through the `imagegen` tool and, on the NanoGPT backend, also `imageedit` and `imagegen_models`. One package loads in OpenCode 1 and OpenCode 2. It targets OpenCode 1.18.29 and newer and OpenCode 2.0.32 and newer; those versions are the support floors. Container runs with real agents have covered OpenCode 1.19.3 and 2.0.32 with the Codex backend (skill loaded, images generated; run before backend selection existed) and with the OpenAI Images API backend (one generation and one reference edit per host, with the key from `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` and, in an earlier run, with a key saved in OpenCode). OpenCode 1.18.29 was checked for plugin load, skill registration and, for the OpenAI Images API backend, sign-in registration only, and versions between the floors and those runs, or newer, are untested. The NanoGPT backend has only been exercised by the mocked unit suite: no live NanoGPT call and no container run has been made, so its model table (see "NanoGPT backend") follows provider documentation and public model metadata and is not validated against the live service.

The package also ships one skill, `oc-multi-imagegen`, with the technique for image work: choosing raster or code, labelling reference images, correcting a result, keeping related images consistent, transparency, and checking what came back. The image tool descriptions tell agents to load it before image work when it is available and permitted, and the tools work without it.

The plugin runs one image backend per load, chosen with the `OC_MULTI_IMAGEGEN_BACKEND` environment variable:

| `OC_MULTI_IMAGEGEN_BACKEND` | Calls | Credential |
| --- | --- | --- |
| unset or `codex` | the ChatGPT Codex image backend | OpenCode's ChatGPT sign-in for the `openai` provider |
| `openai-api` | the official OpenAI Images API | the `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` variable, or else an OpenAI Images API key saved in OpenCode as the `openai-images` credential |
| `nano-gpt` | NanoGPT's image API, with a model chosen per call | the `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` variable, or else a NanoGPT API key saved in OpenCode as the `nano-gpt-images` credential |

The active backend decides which tools are registered and their arguments, defaults, limits and descriptions, so an agent sees only the backend that will run. Codex and the OpenAI Images API register the single `imagegen` tool. NanoGPT registers `imagegen` (new image from text), `imageedit` (edit or combine existing images) and `imagegen_models` (the supported models, answered locally). Changing the variable and restarting OpenCode switches the tool; there is no per-call backend argument and no fallback from one backend to the other.

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

## Configuration

The plugin has three settings, all of them environment variables of the process that loads the plugin. The plugin entry in the OpenCode configuration stays a plain package entry (see "Local setup"): the plugin takes no options, and it does not read a `.env` file or any other configuration file.

| Variable | Effect |
| --- | --- |
| `OC_MULTI_IMAGEGEN_BACKEND` | Selects the backend: `codex` (also the result when the variable is unset), `openai-api` or `nano-gpt`. It is read once, when the plugin loads, so changing it takes a restart. A value that is empty or unknown makes the plugin fail to load: the host logs `failed to load plugin` with a message that names the variable, and no image tool is registered. |
| `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` | The OpenAI Images API key, for the `openai-api` backend only. When the variable is present it is the key, ahead of any key saved in OpenCode. It is read on every call, so a changed value applies to the next call. See "OpenAI Images API backend". |
| `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` | The NanoGPT API key, for the `nano-gpt` backend only, with the same precedence and per-call reading as the OpenAI key. See "NanoGPT backend". |

Earlier builds took the backend as a plugin option. A `backend` option left in a plugin entry now makes the plugin fail to load with a message that names `OC_MULTI_IMAGEGEN_BACKEND`, and any other option fails it too, so remove the option from the entry.

The plugin reads the environment of the process that loads it, which is the OpenCode server (for example `opencode serve`). A variable exported in the shell where you start a client that attaches to a running server is not in the server's environment, so it has no effect. For a server run by systemd, put the variables in the unit; the values below are placeholders:

```ini
[Service]
Environment=OC_MULTI_IMAGEGEN_BACKEND=openai-api
EnvironmentFile=/etc/opencode/oc-multi-imagegen.env
```

```sh
# /etc/opencode/oc-multi-imagegen.env (mode 600)
OC_MULTI_IMAGEGEN_OPENAI_API_KEY=<OpenAI Images API key>
```

After editing a unit or its environment file, reload systemd and restart the service. For a system unit named `opencode.service`, that is `systemctl daemon-reload` and `systemctl restart opencode.service`. A user unit (`~/.config/systemd/user/opencode.service`) takes the same two settings, with an `EnvironmentFile` that you own and the service can read, such as `%h/.config/opencode/oc-multi-imagegen.env` (mode 600), and uses `systemctl --user daemon-reload` and `systemctl --user restart opencode.service`. Keep the key in a file with restricted permissions rather than in the unit, because unit files are generally readable by every local user.

## Authentication

Credentials stay outside this repository: in OpenCode's own store, or for an image API key, in the environment of the OpenCode process. The plugin reads only the credential of the active backend, on every call and only after the permission of the invoked image tool, and never writes, refreshes or activates one.

### Codex backend

Authenticate OpenCode with ChatGPT before generating. An OpenAI API key is not sufficient for this backend on either host.

OpenCode 1 reads the `openai` OAuth entry from `OPENCODE_AUTH_CONTENT` when set, otherwise from OpenCode's `auth.json` under the XDG data directory.

OpenCode 2 asks the host for the active `openai` connection on every call, so a refreshed token or a switched account applies to the next call:

- It accepts OAuth credentials created with the **Codex browser (legacy)** or **Codex device code (legacy)** sign-in methods, and sends the credential's `metadata.accountID`, when present, as the ChatGPT account.
- It rejects a **Sign in with ChatGPT** (token-sharing) connection, an API key, any other connection type, a missing connection, and an unrecognized sign-in method. The error names the two supported sign-in methods.
- It does not read `OPENCODE_AUTH_CONTENT` or `auth.json`, and it does not refresh tokens itself. When the host fails to look up or refresh the connection, that error is reported unchanged.

### OpenAI Images API backend

This backend uses its own credential, separate from the `openai` chat provider. A key saved under `openai` would also be the chat provider's key, so a separate credential lets you create a key at OpenAI that is limited to image generation. Whatever permissions the key has are yours to set; the plugin does not inspect them and sends the key only to `https://api.openai.com/v1/images/generations` and `https://api.openai.com/v1/images/edits`, when an image is requested. Loading the plugin makes no network request and checks no key.

Each call takes the key from the first of these that applies:

1. The `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` variable, when it is present. It is the key, and the saved key is not consulted. A value that is empty, or has characters that cannot be sent in an HTTP header (a space or a newline, for example), fails the call without a request and without trying the saved key. A key that OpenAI rejects (401 or 403) is reported as the API's error, once, also without trying the saved key.
2. The key saved in OpenCode as the `openai-images` credential, when the variable is absent.

The plugin does not read `OPENAI_API_KEY`, which can be your chat key, and it does not load `.env` files. Put the variable into the server's environment as described in "Configuration".

With `OC_MULTI_IMAGEGEN_BACKEND` set to `openai-api`, the plugin also registers a sign-in method for `openai-images`, so OpenCode stores a saved key itself:

- OpenCode 1: run `opencode auth login --provider openai-images` and enter the key, or choose **Other** in the provider list and enter the id `openai-images`. OpenCode saves it as an `api` entry in `auth.json`. OpenCode 1 has no public resolver for environment credentials, so the plugin reads the variable itself on each call, after the permission. Without the variable it reads the saved entry from `OPENCODE_AUTH_CONTENT` when set (content that does not parse falls through to `auth.json`, as in OpenCode), otherwise from `auth.json`. It registers no provider or model, so chat model selection is unchanged.
- OpenCode 2: run `opencode auth login openai-images`, or connect the **OpenAI Images API** integration in the host, and enter the key. The plugin declares the variable to the host as an environment method of that integration, so the host lists it as a connection, and asks the host to resolve it; the plugin only checks that the variable exists and does not read the value itself. The host lists a saved key ahead of an environment connection, so its own listings can show the saved key first, but the plugin uses the variable first. Without the variable the plugin asks the host for the active `openai-images` connection and resolves it on every call. It does not read `OPENCODE_AUTH_CONTENT`, `auth.json` or `.env` files.

A missing credential fails the call with the variable and the sign-in command to use, and a non-key saved credential fails it with the sign-in command. The OpenAI chat sign-in is never used as an image key, and the image key is never used for chat. An error from the API is reported with its status and body, with the key removed from the text.

### NanoGPT backend

This backend uses its own credential, separate from the other two. The plugin sends the key only to `https://api.nano-gpt.com/api/v1/images`, when an image is requested, and downloads a result that NanoGPT returns as a URL without any credential. Loading the plugin makes no network request and checks no key. `imagegen_models` needs no key.

Each call takes the key from the first of these that applies, exactly as for the OpenAI Images API backend:

1. The `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` variable, when it is present. A value that is empty, or has characters that cannot be sent in an HTTP header, fails the call without a request and without trying the saved key. A key NanoGPT rejects is reported once, also without trying the saved key.
2. The key saved in OpenCode as the `nano-gpt-images` credential, when the variable is absent.

With `OC_MULTI_IMAGEGEN_BACKEND` set to `nano-gpt`, the plugin registers a sign-in method for `nano-gpt-images` the same way: OpenCode 1 with `opencode auth login --provider nano-gpt-images`, OpenCode 2 with `opencode auth login nano-gpt-images` or by connecting the **NanoGPT API** integration. The key is not read from the other backends' variables or credentials, from `NANOGPT_API_KEY`, or from a `.env` file.

## Permissions

Both hosts ask for the permission of the invoked image tool once per call, before the plugin reads credentials or reference images or contacts the provider, so a deny rule stops the call without spending quota. The tool is `imagegen` on Codex and the OpenAI Images API, and `imagegen` or `imageedit` on NanoGPT. A rule set that denies everything and allows `imagegen` and the skill runs without prompts on Codex and the OpenAI Images API; the NanoGPT additions follow the examples. In OpenCode 1:

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

The permission resource is the active backend's id, `codex`, `openai-api` or `nano-gpt`, so a grant saved for one backend (for example "always allow" in a prompt) does not cover the others. The `*` rules above match every backend. To allow only the official API, write the rule on that resource: in OpenCode 1 `"imagegen": { "*": "deny", "openai-api": "allow" }`, in OpenCode 2 `{ "action": "imagegen", "resource": "openai-api", "effect": "allow" }`. A call that uses billed API credit asks nothing beyond this permission.

The permission covers the whole operation. It does not contain file access: `out` and `images` accept absolute paths, including paths outside the project directory. An agent that should look at the result needs a `read` rule too; scope it to the files you mean (for example `*.png`), because `read` opens whatever its rule matches.

The permission action is the tool's name, and `imageedit` is a separate action from `imagegen`. With the NanoGPT backend, add `imageedit` to the rules above, or the agent can create images but not edit them: `"imageedit": "allow"` in OpenCode 1, `{ "action": "imageedit", "resource": "*", "effect": "allow" }` in OpenCode 2. `imagegen_models` answers from a table inside the plugin and asks for no permission; a rule set that denies everything by default should allow it too (`"imagegen_models": "allow"`, or an `imagegen_models` action rule), so that the host lists it (not checked against a host).

In OpenCode 2, these are direct tools, so allowing them does not require allowing the `execute` tool.

## Use

Ask your agent for an image; naming the tool is not required. In the recorded container runs (one model, one account), requests that named neither `imagegen` nor the skill made the agent load the skill and then call `imagegen`. For example:

> Create a wide illustration of a mountain lake at dawn and save it as images/lake.png.

To edit or combine existing images, name the files in the request:

> Add a wooden pier on the left of images/lake.png and save the result as images/lake-pier.png.

The agent passes existing files as `images`. On Codex and the OpenAI Images API it chooses any size you leave out, and `imagegen` accepts the arguments below. The NanoGPT tools, with `imageedit` for edits and a model named on every call, are described under "NanoGPT tools".

- `prompt`: description of the image to generate, or of the edit to make when `images` is set.
- `out`: destination path. Relative paths resolve against the OpenCode project directory; absolute paths are accepted.
- `size`: required. A preset on the Codex backend, a native `WIDTHxHEIGHT` on the OpenAI Images API backend (see "Size").
- `images`: optional list of local reference-image paths, resolved like `out`: up to five on Codex, up to 16 PNG, JPEG or WebP files on the OpenAI Images API.
- `background`: optional `opaque` or `transparent`; defaults to `opaque`.
- `model` and `quality`: optional strings, sent to the backend unchanged. Without them the backend's defaults apply (see "Model and quality").

Each call sends one request and saves one image. The sections below describe what the plugin does with each argument. Statements marked as recorded come from runs against the Codex backend (recorded OpenCode container runs with real agents, and a direct-request study on one ChatGPT Pro account on 2026-10-20); that backend can change without notice.

### NanoGPT tools

With `OC_MULTI_IMAGEGEN_BACKEND=nano-gpt`, creating and editing are separate tools, and every call names its model. NanoGPT publishes a generation model and an edit model for each family, so `imagegen` accepts only generation models and `imageedit` only edit models; a model from the wrong list is rejected with a message that names the right tool.

| Family | `imagegen` model | `imageedit` model | Controls | Edit references |
| --- | --- | --- | --- | --- |
| GPT Image 2.5 Flare | `openai/gpt-image-2.5/flare/text-to-image` | `openai/gpt-image-2.5/flare/edit` | `resolution`, `aspect_ratio`, `quality`, `background` | up to 16 |
| Nano Banana Pro | `nano-banana-pro` | `nano-banana-pro-edit` | `resolution`, `aspect_ratio` | up to 10 |
| FLUX.3 Image | `black-forest-labs/flux-3/text-to-image` | `black-forest-labs/flux-3/edit` | `resolution`, `aspect_ratio` | up to 10 |
| Seedream 5.0 Pro | `bytedance/seedream-v5.0-pro` | `bytedance/seedream-v5.0-pro/edit` | `resolution` (also takes aspect-ratio values such as `16:9`) | up to 10, each at most 10 MB |
| Qwen Image 2.1 | `qwen-image-2.1/text-to-image` | `qwen-image-2.1/edit` | `resolution`, `aspect_ratio`, `seed` | up to 10 |

- `imagegen` takes `model`, `prompt`, `out` and the optional controls its model lists. `imageedit` takes the same plus `images`, a required list of local PNG, JPEG or WebP paths resolved like `out`. Neither takes `size`.
- `imagegen_models` lists these models from a table inside the plugin, filtered by `operation` (`generate` or `edit`), `family` or `query` words, or describes one exact `model` with its control values, limits and argument schema. It needs no key, permission, file or network access and costs nothing.
- A control is sent only when the call sets it, so NanoGPT applies its own default for everything left out. A control the chosen model does not list, an unlisted value, too many references, a prompt over a documented length limit, an unknown argument and a model that is not in the table are all rejected before any permission request or provider call. The plugin does not drop an unsupported control; the error says what to change.
- Each call asks for one image, and asks for PNG output where the model documents an output format. NanoGPT bills the key's account.
- The model is never chosen for the agent and never replaced after an error. The tool descriptions tell the agent to use the model you named when the tool supports it, otherwise to pick a supported model and give a short reason, to ask you only when required input is missing or your request conflicts with a model, capability, cost or requirement, and to read a provider error, correct only an input that is demonstrably wrong, and not repeat an unchanged call or retry authentication, balance or rate-limit errors. A model choice needs no approval of its own.
- A response with one inline `b64_json` image or one `url` is accepted. A URL must be `https` with a hostname (not an IP address, `localhost` or a `.localhost` name, each with or without a trailing dot) and without credentials; whether a public name resolves to a private address is not checked. It is downloaded without any key, without following redirects, with the call's cancellation signal and up to 64 MiB. A download whose size differs from the `Content-Length` of an uncompressed response is refused. A response with no image, several images, a pending job, both fields or a body that is not JSON is refused, nothing is saved, and the error says the account may already have been charged. The plugin does not poll jobs, convert, resize or save more than one file. Data that is not a PNG, including SVG, is refused before anything is written.
- Provider errors are reported with the tool, model, HTTP status, NanoGPT's error code and message, cut to a bounded length and with the key removed. An HTTP 5xx adds that the account may have been charged.
- A network failure while sending the request, reading the response or downloading the image is reported with the tool, model and stage, without the runtime's own message, code or name and without the download URL or its host. Nothing is saved, the error says the account may have been charged and that the call should not be repeated unchanged, and the call is not retried. A cancelled call keeps its cancellation reason.

The table follows NanoGPT's documentation and public model metadata at the time of writing. It has not been checked with live calls; the metadata is incomplete and inconsistent between sources, so a control missing from a model's row means this plugin does not send it, not that NanoGPT lacks it. The plugin never fetches NanoGPT's model list, so models and controls NanoGPT adds later stay unavailable until the table changes.

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

On Codex and the OpenAI Images API, `background` is passed to the backend as requested, with `opaque` as the default. On NanoGPT only GPT Image 2.5 Flare takes `background` (`auto`, `opaque` or `transparent`); the plugin injects no default there, so the control is sent only when the call sets it. The plugin does not check or modify the alpha channel of the result.

Recorded on Codex: opaque requests returned RGB PNGs and transparent requests returned RGBA PNGs with real transparency. The alpha was soft rather than a hard mask, and in the direct-request study most subject pixels sat at alpha 252 to 253 instead of fully opaque. Post-process the alpha channel when a hard cut-out or a fully opaque subject is needed.

### Output file

The file always contains the PNG bytes the backend returned. The OpenAI Images API request asks for PNG output. The extension in `out` does not select or convert the format: saving to `photo.jpg` writes PNG data under that name. Data that is not a PNG is rejected before any directory or file is created.

If the destination exists, the plugin chooses a `-v2`, `-v3`, or later suffix, up to `-v999`. This is best-effort collision avoidance, not an atomic guarantee: concurrent calls targeting the same path can overwrite each other. Use distinct output paths for parallel calls.

The result carries the saved path and whether it was versioned as `out` and `versioned` metadata on both hosts. OpenCode 2 also returns them as structured output (`{ out, versioned }`) next to the text message.

### Controls the tool does not expose

There are no image-count or output-format arguments. The OpenAI Images API request always asks for one PNG image without streaming, and each NanoGPT request asks for one image; no backend receives other arguments. On Codex and the OpenAI Images API, the plugin's validation removes unknown arguments such as `n`, so they never reach the provider. The NanoGPT tools reject unknown arguments instead, including `n`, `provider`, `stream` and output formats. A host can also drop or reject arguments before the call.

### Validation, cancellation and failures

Arguments are validated before any permission request or provider call. Stopping the call forwards the cancellation to the provider request, and an image that arrives after cancellation is not saved. A cancelled or failed call is not retried and does not fall back to the other backend.

## Current limits

The Codex backend relies on the ChatGPT Codex backend and its availability, account permissions, and usage limits. The OpenAI Images API backend relies on the official API: its calls bill the key's account, and model access, rate limits and size limits are the API's. The NanoGPT backend relies on NanoGPT's normalized image API and its availability, balance, rate limits and model catalogue; its calls bill the key's account. The plugin does not probe the key's scope or a model's availability; those show up as the API's error on the call that needs them.

In OpenCode 2, relative `out` and `images` paths resolve against the directory of the session that made the call, which can differ from the directory the plugin loaded in.

Generation sends prompts and reference images to the active backend's provider (OpenAI, or NanoGPT) and may consume account quota or API credit. This is an unofficial integration, not an OpenAI or OpenCode product. The MIT software license does not grant access to a provider service or replace that service's terms.

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

To try the plugin with real agents in OpenCode 1 and OpenCode 2 containers, follow `docs/container-testing.md` in a source checkout of this repository. The runbook and its `scripts/` helpers are not part of the npm package. It is an ad-hoc procedure that also uses account quota, not an automated check. It covers the Codex and OpenAI Images API backends; the NanoGPT backend has no container or live runbook.

## License

[MIT](./LICENSE). The original copyright and permission notice are retained as required by that license.
