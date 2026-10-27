# Tool reference

[README](../README.md) · [Examples](examples.md) · [Backends](backends.md) · [Permissions](permissions.md)

The active backend owns its tool schemas. Codex and the OpenAI Images API expose `imagegen` for both generation and reference edits. NanoGPT exposes `imagegen`, `imageedit` and local model information through `imagegen_models`.

## Codex and OpenAI arguments

| Argument | Behavior |
| --- | --- |
| `prompt` | Description of a new image, or the change to make when references are supplied. |
| `out` | Destination path, relative to the calling session's project directory unless absolute. |
| `size` | Required. A Codex preset or native OpenAI `WIDTHxHEIGHT`, as described below. |
| `images` | Optional local reference paths, resolved like `out`. Up to five on Codex or 16 on the OpenAI Images API. |
| `background` | Optional `opaque` or `transparent`; defaults to `opaque`. |
| `model`, `quality` | Optional strings passed through. [Backend defaults and confidence](backends.md#codex) differ. |

Other arguments, including `n`, are removed by plugin validation and aren't sent. There is no image-count or output-format argument. Each call saves one PNG.

## Sizes

### Codex presets

| `size` | Aspect ratio |
| --- | --- |
| `1254x1254` | 1:1 |
| `1536x1024` | 3:2 |
| `1024x1536` | 2:3 |
| `1448x1086` | 4:3 |
| `1086x1448` | 3:4 |
| `1672x941` | 16:9 |
| `941x1672` | 9:16 |

Codex size is requested in the prompt; the request's API `size` field remains `auto`. The plugin adds a sentence naming the chosen dimensions and aspect ratio. It doesn't resize, crop or pad the result.

Recorded Codex outputs usually matched these presets, with some edges one pixel off. In a direct-request study, asking for 2048x2048 in prose still returned 1254x1254. The result message reports actual dimensions, so inspect them when exact sizes matter and resize or crop separately if necessary.

### OpenAI pixel sizes

Use native `WIDTHxHEIGHT`, for example `1536x864`. Both dimensions must be positive multiples of 16 with an aspect ratio between 1:3 and 3:1. The plugin sends the value unchanged. The API enforces model-specific pixel and edge limits.

The backend's documented guidance marks sizes above 2560x1440 as experimental and gives 3840x2160 as the maximum. Larger sizes cost more. An API rejection is reported rather than rounded or retried.

### NanoGPT sizes

NanoGPT takes `resolution` and, where the model lists it, `aspect_ratio`, rather than `size`. These are optional and model-specific. Use `imagegen_models` to get the accepted values before calling a model.

## Reference images

Pass local files in `images` and name each role in the prompt, for example: "Image 1: character design. Image 2: setting and colour palette." Files are sent in the order given.

On Codex and OpenAI, a nonempty reference list selects the image-editing endpoint. NanoGPT requires `imageedit` and an edit-model ID. The contents are uploaded to the provider.

An edit generates a new image guided by the prompt and references. It doesn't guarantee unchanged pixels outside the requested area. Use local image editing or compositing when a region must remain identical.

| Backend | Reference rules |
| --- | --- |
| Codex | Up to five local reference files. |
| OpenAI API | Up to 16 PNG, JPEG or WebP files. Each encoded data URL must be at most 20,971,520 characters. |
| NanoGPT | Local PNG, JPEG or WebP files. Counts depend on the model; the route limit is 31,457,280 bytes per file, with Seedream restricted to 10,485,760 bytes. |

FLUX's provider additionally documents references of at least 256 pixels per side and at most 16 megapixels, with downscaling above four megapixels. The plugin doesn't check those pixel constraints locally. OpenAI references are sent as `images[].image_url` data URLs; NanoGPT uses `input_references` and doesn't mix legacy image aliases.

## Transparent backgrounds

Set `background: "transparent"` for a cut-out. Prompt for one subject, complete edges and room around it; asking for transparency only in the prose doesn't set the argument.

Codex and OpenAI default to `opaque`. On NanoGPT, only the supported GPT Image 2.5 Flare pair exposes `background`, with `auto`, `opaque` or `transparent`; no default is injected.

The plugin doesn't inspect or modify alpha. Recorded Codex transparency includes soft edges and partially transparent subject pixels; in a direct-request study, many subject pixels were at alpha 252-253 rather than 255. Check on light and dark backgrounds and post-process when you need a fully opaque subject or hard matte. The [walkthrough](examples.md#transparency-check) records the example icon's actual alpha behavior.

## Output files

The saved file contains the provider's PNG bytes. Choosing an extension such as `.jpg` doesn't convert the image; it writes PNG data under that name. Non-PNG data is rejected before a directory or file is created.

An existing path is kept and the next available `-v2`, `-v3`, up to `-v999` suffix is chosen. This is best-effort collision avoidance, not an atomic operation. Give parallel calls distinct output paths.

Both hosts return `out` and `versioned` metadata. OpenCode 2 also returns structured output with that shape alongside the text. The message reports the actual pixel dimensions.

Relative `out` and reference paths follow the calling session's directory. On OpenCode 2 that can differ from the directory that loaded the plugin. Absolute paths are accepted, including outside the project; see [file access](permissions.md#file-access).

## NanoGPT inputs

- `imagegen`: required `model`, `prompt`, `out`; optional controls supported by that model.
- `imageedit`: the same, with a required nonempty `images` list.
- `imagegen_models`: list filters `operation`, `family`, `query`, or an exact `model` for detailed controls, limits and the model's input schema. An exact model can't be combined with list filters.

The image tools accept a curated set of generation/edit IDs and reject unknown arguments, unsupported controls or values, wrong-operation models, excess references and documented prompt-length violations before contacting the provider. There are no count, format, streaming or generic provider-routing arguments. Omitted controls aren't sent.

Every call asks for one image. Where the model's documented controls permit it, the request asks for PNG; all successful saves require PNG. [The model table](backends.md#generation-and-editing-models) lists the supported families.

## NanoGPT responses and errors

The plugin accepts exactly one `data` item with either inline `b64_json` or a download `url`. It refuses missing images, multiple images, both fields, pending jobs or a non-JSON body, and reports that nothing was saved and generation may already have been charged. It doesn't poll jobs, convert output formats or discard extra images to save only the first.

A download URL must use HTTPS without embedded credentials. IP literals, `localhost` and `.localhost` names, including trailing-dot variants, are refused. Public hostnames aren't checked for private-address DNS resolution. Downloads carry no API key, follow no redirects, use the call's cancellation signal and are limited to 64 MiB. An uncompressed download must match a valid declared `Content-Length`; compressed responses can have an encoded length different from their decoded body.

Provider HTTP errors include the tool, model, status, bounded error code and message, with the key removed. HTTP 5xx and transport/read failures disclose possible charges. Network diagnostics name the stage without exposing runtime messages, codes, causes, signed URLs or download hosts. A failed download or save doesn't imply the provider refunded a generation.

## Validation, permissions and cancellation

Arguments are validated before permission. Permission is requested before credentials, references or the provider are touched. Invalid reference files fail before the quota-consuming request.

Stopping a call forwards cancellation to the provider request. A result arriving after cancellation isn't saved. Failures and cancellations propagate rather than returning success, and the plugin never retries or selects another backend or model.

Provider access, account quota, balance, key scope and model availability are enforced by the selected service, not probed at startup. Check a returned error before deciding whether to correct an input or ask the operator for a decision.
