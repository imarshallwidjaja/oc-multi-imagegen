# Tool reference

[README](../README.md) · [Examples](examples.md) · [Backends](backends.md) · [Permissions](permissions.md)

The active backend owns its tool schemas. Codex and the OpenAI Images API expose `imagegen` for both generation and reference edits. The OpenAI Images API also exposes `imagegen_models`, which lists the key's models from OpenAI on each call. NanoGPT exposes `imagegen`, `imageedit` and local model information through `imagegen_models`.

## Codex and OpenAI arguments

| Argument | Behavior |
| --- | --- |
| `prompt` | Description of a new image, or the change to make when references are supplied. |
| `out` | Destination path, relative to the calling session's project directory unless absolute. |
| `size` | Required. A Codex preset or native OpenAI `WIDTHxHEIGHT`, as described below. |
| `images` | Optional local reference paths, resolved like `out`. Up to five on Codex or 16 on the OpenAI Images API. |
| `background` | Optional `opaque` or `transparent`; defaults to `opaque`. On the OpenAI Images API, `transparent` needs PNG or WebP output. |
| `model`, `quality` | Optional strings passed through. [Backend defaults and confidence](backends.md#codex) differ. |
| `output_format` | OpenAI Images API only: `png` (default), `jpeg`, `webp`, `gif` or `svg`. See [OpenAI output formats](#openai-output-formats). |
| `frame_count`, `frame_duration_ms` | OpenAI Images API only, with `output_format: "gif"`. |
| `svg_model` | OpenAI Images API only, with `output_format: "svg"`. |

Other arguments, including `n`, are removed by plugin validation and aren't sent. There is no image-count argument, and Codex has no output-format argument. Each call saves one native image file: PNG, JPEG or WebP, or on the OpenAI Images API also GIF or SVG.

## OpenAI output formats

`output_format` is sent on every OpenAI request, `png` unless set. With PNG, JPEG and WebP the background defaults to `opaque`, and `transparent` needs PNG or WebP.

`gif` and `svg` come from the generations endpoint only, so a call that also passes reference `images` is rejected before permission is requested. Neither format sends a background unless one is set, and only `opaque` is accepted for them.

| Format | Controls | What comes back |
| --- | --- | --- |
| `gif` | `frame_count` (whole number, 2 to 16) and `frame_duration_ms` (whole number, 20 to 2000), each optional and sent only when set. `size` is the size of each frame. | A finished animated GIF. |
| `svg` | `svg_model`, sent as `svg: { model }` only when set. `quality` controls the reference image the API renders before an author model draws the vectors. | A UTF-8 SVG document. |

The GIF limits are this tool's limits. OpenAI's guide gives 2 to 64 frames and 20 to 2000 ms; its API reference gives 2 to 16 frames and a much larger maximum delay. The tool accepts the range both share, which is not a proven provider maximum. All frames together must fit the model's limits: when the API rejects a GIF request, reduce `size` or `frame_count`. In a run on 2026-11-05, four 1024x1024 frames were rejected with "No supported sheet fits 4 GIF frames at size '1024x1024'. ... The longest edge must be less than or equal to 3840." and four 768x768 frames succeeded.

Some accounts have SVG author selection enabled and must name the author in `svg_model`; others must omit it. Which applies to a key is only known from the API's answer. An account that requires an author answers a request without `svg_model` with 400 "SVG generation requires 'svg.model'." The plugin never chooses an author model and never retries with one. Agents are told to set `svg_model` only when the operator names a model or the API asks for one; `imagegen_models` with `query` can list candidate IDs, which are not evidence of SVG support.

## OpenAI model discovery

`imagegen_models` accepts no arguments, a `query` or a `model`. `model` can't be combined with `query`, and other arguments are rejected. Without arguments it lists the key's `gpt-image-*` and `chatgpt-image-*` IDs with their creation date, owner and any shutdown date, and marks the `imagegen` default. `query` searches every ID the key lists with words that must all appear. `model` checks one exact ID. [Model discovery](backends.md#model-discovery) covers permission, request and failure behavior.

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
| NanoGPT | Local PNG, JPEG or WebP files. Counts depend on the model; the route limit is 31,457,280 bytes per file, with Seedream and Qwen Image 3 Pro restricted to 10,485,760 bytes. |

FLUX's provider additionally documents references of at least 256 pixels per side and at most 16 megapixels, with downscaling above four megapixels. The plugin doesn't check those pixel constraints locally. OpenAI references are sent as `images[].image_url` data URLs; NanoGPT uses `input_references` and doesn't mix legacy image aliases.

## Transparent backgrounds

For Codex and OpenAI, set `background: "transparent"` for a cut-out. Prompt for one subject, complete edges and room around it; asking for transparency in prose doesn't set the argument.

Codex and OpenAI default to `opaque`. OpenAI accepts `transparent` only with PNG or WebP output. On NanoGPT, only the supported GPT Image 2.5 Flare pair exposes `background`, with `auto`, `opaque` or `transparent`; no default is injected. For other NanoGPT families, request transparency in the prompt without passing `background`; results vary by model. See the [observed workflow outcomes](backends.md#nanogpt-live-workflow-coverage).

The plugin doesn't inspect or modify alpha. Inspect the actual alpha and check on light and dark backgrounds; a filename, RGBA channel or visible checkerboard does not prove transparency. Recorded Codex transparency includes soft edges and partially transparent subject pixels; in a direct-request study, many subject pixels were at alpha 252-253 rather than 255. Post-process when you need a fully opaque subject or hard matte. The [walkthrough](examples.md#transparency-check) records the example icon's actual alpha behavior.

## Output files

The saved file contains the provider's native bytes, without conversion or resizing. Codex and NanoGPT save PNG, JPEG or WebP; the OpenAI Images API also saves GIF and SVG. Any other type, including GIF or SVG from Codex or NanoGPT, is refused. The plugin detects the format and reads its size before creating a directory or file:

- PNG, JPEG and WebP: finite positive pixel dimensions from the image header.
- GIF: the header's logical screen size, reported as the frame size. The frame count and the animation itself aren't checked.
- SVG: the document is parsed as strict XML and must have an `svg` root in the SVG namespace with a valid `viewBox` or a positive `width` and `height`. These are reported as vector units, not pixels. The document is refused if it is malformed or has a DOCTYPE, a processing instruction, a script, `foreignObject`, an image or other embedding element, animation elements, event handler attributes, links or `url()` references outside the document, an `xml:base`, or elements outside the SVG namespace (other vocabularies are allowed inside `metadata`, except XHTML). Style sheets, `style` attributes and SVG presentation attributes such as `fill`, `mask` and `filter` are checked as CSS: a CSS escape (any backslash), a `url()` reference that holds `/*`, `*/` or a quote after an unquoted target (so a same-document ID with those characters is refused too), an image function that can load a resource from a string or a custom property (`image-set()`, `image()`, `cross-fade()` or `src()`, with or without a vendor prefix), a style sheet at-rule such as `@import`, `@font-face` or `@keyframes`, and an `animation` or `transition` property are refused. Plain fills, strokes, gradients, filters, same-document `url(#id)` references and quoted font names pass. Other attribute values, such as `aria-label` or `data-*` text, aren't CSS and aren't checked as CSS. This matches OpenAI's description of its SVG output as static vector content without scripts, external resources or embedded raster images. It is a refusal check for those forms, not a sanitizer: treat a saved SVG as an untrusted document before embedding it in a web page.

Unsupported types and unreadable or invalid sizes fail with a bounded diagnostic that includes the detected type or the SVG refusal reason, never the provider's content. Header inspection doesn't establish that every pixel can be decoded or that the file is free of corruption.

The extension follows the detected bytes: `.png`, `.jpg`, `.webp`, `.gif` or `.svg`. An already matching extension is preserved, including `.jpeg` for JPEG and case variants. A mismatching suffix of a format the tool saves is replaced; a missing or other suffix gets the actual extension appended. For example, JPEG returned for `scene.png` is saved to `scene.jpg`, JPEG returned for `scene.asset` is saved to `scene.asset.jpg`, and on the OpenAI Images API an SVG returned for `logo.png` is saved to `logo.svg`. On Codex and NanoGPT a `.gif` or `.svg` suffix isn't one of their formats, so PNG returned for `scene.gif` is saved to `scene.gif.png`.

If that format-adjusted target exists, it is kept and the next available `-v2`, `-v3`, up to `-v999` suffix is chosen before the extension. This is best-effort collision avoidance, not an atomic operation. Give parallel calls distinct output paths.

Both hosts return `out` and `versioned` metadata. OpenCode 2 also returns structured output with that shape alongside the text. `out` is the actual absolute saved path: use it for reads and as the next edit's `images` input, rather than assuming the requested path was used. A GIF or SVG can't be an OpenAI reference image. `versioned` is true only for a collision suffix, not an extension adjustment alone. The message reports the actual format and size (pixels, GIF frame size or SVG vector geometry) and explains extension adjustment and collision versioning separately.

Relative `out` and reference paths follow the calling session's directory. On OpenCode 2 that can differ from the directory that loaded the plugin. Absolute paths are accepted, including outside the project; see [file access](permissions.md#file-access).

## NanoGPT inputs

- `imagegen`: required `model`, `prompt`, `out`; optional controls supported by that model.
- `imageedit`: the same, with a required nonempty `images` list.
- `imagegen_models`: list filters `operation`, `family`, `query`, or an exact `model` for detailed controls, limits and input schemas. An exact model can't be combined with list filters. Lists group operation entries by tool and distinguish entries from distinct IDs. For a same-ID generation/edit model, one JSON object keyed by `imagegen` and `imageedit` holds both full argument schemas; a single-operation ID keeps the single-schema shape.

Qwen Image 3 Pro, Seedream's base ID, WAN 2.7 Image Pro and Muse use the same exact model ID for both tools. `imagegen` accepts text only; `imageedit` requires references even when its ID contains `text-to-image`. Seedream's additional `/edit` route is accepted only by `imageedit`. No suffix is synthesized or removed.

The image tools accept a curated set of generation/edit IDs and reject unknown arguments, unsupported controls or values, wrong-operation models, excess references and documented prompt-length violations before contacting the provider. There are no count, format, streaming or generic provider-routing arguments. Omitted controls aren't sent.

Every call asks for one image. Where the model's documented controls permit it, the request asks for PNG; otherwise the output format is left to NanoGPT. Native PNG, JPEG and WebP responses can be saved. [The model table](backends.md#generation-and-editing-models) lists the supported families.

## NanoGPT responses and errors

The plugin accepts exactly one `data` item with either inline `b64_json` or a download `url`. It refuses missing images, multiple images, both fields, pending jobs or a non-JSON body, and reports that nothing was saved and generation may already have been charged. It doesn't poll jobs, convert output formats or discard extra images to save only the first.

A download URL must use HTTPS without embedded credentials. IP literals, `localhost` and `.localhost` names, including trailing-dot variants, are refused. Public hostnames aren't checked for private-address DNS resolution. Downloads carry no API key, follow no redirects, use the call's cancellation signal and are limited to 64 MiB. An uncompressed download must match a valid declared `Content-Length`; compressed responses can have an encoded length different from their decoded body.

Provider HTTP errors include the tool, model, status, bounded error code and message, with the key removed. HTTP 5xx and transport/read failures disclose possible charges. Network diagnostics name the stage without exposing runtime messages, codes, causes, signed URLs or download hosts. A failed download or save doesn't imply the provider refunded a generation.

## Validation, permissions and cancellation

Arguments are validated before permission. Permission is requested before credentials, references or the provider are touched. Invalid reference files fail before the quota-consuming request.

The OpenAI Images API's `imagegen_models` follows the same order without a session directory or files: arguments, then permission, then the key, then one model-list request.

Stopping a call forwards cancellation to the provider request. A result arriving after cancellation isn't saved or returned. Failures and cancellations propagate rather than returning success, and the plugin never retries or selects another backend or model.

Provider access, account quota, balance, key scope and model availability are enforced by the selected service, not probed at startup. On the OpenAI Images API, `imagegen_models` shows which models the key lists, not which features they support. Check a returned error before deciding whether to correct an input or ask the operator for a decision.
