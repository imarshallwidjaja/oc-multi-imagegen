# Tool reference

[README](../README.md) · [Examples](examples.md) · [Backends](backends.md) · [Permissions](permissions.md)

Every backend registers the same two image tools with the same roles:

- `imagegen` creates a new image from a text prompt. It takes no reference images.
- `imageedit` changes, restyles or combines existing images. It requires a nonempty `images` list of local paths or HTTPS URLs.

Choose the tool by what the call starts from, not by backend. Each result reports the path it was actually saved to; pass that `out` path to the next `imageedit` call. The backend decides each tool's controls, defaults and limits, described below. Where it offers `imagegen_models`, an agent uses it to choose a model: the OpenAI Images API lists the key's models live, NanoGPT describes its curated models from a table in the plugin, and the `opencode` backend lists the enabled image models of OpenCode 2's connected providers. Codex offers no model discovery.

Each image tool rejects an argument it doesn't define before permission is requested, rather than dropping it. An `images` argument passed to `imagegen`, even an empty or `null` one, fails with a message that points to `imageedit`, so a call that names references never generates an image without them.

Every image tool also takes an optional `preview` boolean; see [inline preview](#inline-preview).

## OpenCode 2 tool paths

OpenCode 1 registers `imagegen`, `imageedit` and, where the backend has one, `imagegen_models` as ordinary tools. OpenCode 2 registers them for Code Mode in a described `image` namespace:

| Backends in the load | Code Mode paths inside `execute` | Direct tool names when `execute` is denied |
| --- | --- | --- |
| One | `tools.image.imagegen`, `tools.image.imageedit`, `tools.image.imagegen_models` | `image_imagegen`, `image_imageedit`, `image_imagegen_models` |
| Several | One sub-namespace per backend, with `-` in the ID written as `_`: `tools.image.codex.*`, `tools.image.openai_api.*`, `tools.image.nano_gpt.*`, `tools.image.opencode.*` | `image_openai_api_imagegen` and so on |

The permission actions and resources don't change with the path; see [permissions](permissions.md#opencode-2).

## Moving reference edits to imageedit

Earlier releases ran Codex and OpenAI Images API reference edits through `imagegen` with an `images` argument, such as:

```json
{ "prompt": "Make the sky stormy", "out": "storm.png", "size": "1672x941", "images": ["scene.png"] }
```

That `imagegen` call now fails before permission is requested. Send the same arguments to `imageedit` instead.

There is no alias. A permission configuration that allows only `imagegen` also needs `imageedit`; see [permissions](permissions.md). On the OpenAI Images API, GIF and SVG output stay with `imagegen`.

## Codex and OpenAI arguments

| Argument | Tools | Behavior |
| --- | --- | --- |
| `prompt` | Both | For `imagegen`, a description of the new image. For `imageedit`, the change to make, with each reference's role. |
| `out` | Both | Destination path, relative to the calling session's project directory unless absolute. |
| `size` | Both | Required. A Codex preset or native OpenAI `WIDTHxHEIGHT`, as described below. |
| `images` | `imageedit` | Required references: local paths, resolved like `out`, or [HTTPS URLs](#reference-urls). One to five on Codex, one to 16 on the OpenAI Images API. |
| `mask` | `imageedit`, OpenAI Images API only | Optional PNG [inpainting mask](#inpainting-mask) for `images[0]`. `imagegen` refuses it. |
| `background` | Both | Optional `opaque` or `transparent`; defaults to `opaque`. On the OpenAI Images API, `transparent` needs PNG or WebP output. |
| `model`, `quality` | Both | Optional strings passed through. [Backend defaults and confidence](backends.md#codex) differ. |
| `output_format` | Both, OpenAI Images API only | `png` (default), `jpeg` or `webp`; `imagegen` also takes `gif` and `svg`. See [OpenAI output formats](#openai-output-formats). |
| `frame_count`, `frame_duration_ms` | `imagegen`, OpenAI Images API only | With `output_format: "gif"`. |
| `svg_model` | `imagegen`, OpenAI Images API only | With `output_format: "svg"`. |
| `preview` | Both | Optional boolean, defaults to `false`. See [inline preview](#inline-preview). |

There is no image-count argument, and Codex has no output-format argument. Each call saves one native image file: PNG, JPEG or WebP, or from the OpenAI Images API's `imagegen` also GIF or SVG. Unknown arguments, including `n`, are rejected with the list the tool accepts.

## OpenAI output formats

`output_format` is sent on every OpenAI request, `png` unless set. With PNG, JPEG and WebP the background defaults to `opaque`, and `transparent` needs PNG or WebP.

`gif` and `svg` come from the generations endpoint only, so only `imagegen` accepts them. `imageedit` rejects either format, and the GIF and SVG controls, before permission is requested. Neither format sends a background unless one is set, and only `opaque` is accepted for them.

| Format | Controls | What comes back |
| --- | --- | --- |
| `gif` | `frame_count` (whole number, 2 to 16) and `frame_duration_ms` (whole number, 20 to 2000), each optional and sent only when set. `size` is the size of each frame. | A finished animated GIF. |
| `svg` | `svg_model`, sent as `svg: { model }` only when set. `quality` controls the reference image the API renders before an author model draws the vectors. | A UTF-8 SVG document. |

The GIF limits are this tool's limits. OpenAI's guide gives 2 to 64 frames and 20 to 2000 ms; its API reference gives 2 to 16 frames and a much larger maximum delay. The tool accepts the range both share, which is not a proven provider maximum. All frames together must fit the model's limits: when the API rejects a GIF request, reduce `size` or `frame_count`. In a run on 2026-11-05, four 1024x1024 frames were rejected with "No supported sheet fits 4 GIF frames at size '1024x1024'. ... The longest edge must be less than or equal to 3840." and four 768x768 frames succeeded.

Some accounts have SVG author selection enabled and must name the author in `svg_model`; others must omit it. Which applies to a key is only known from the API's answer. An account that requires an author answers a request without `svg_model` with 400 "SVG generation requires 'svg.model'." The plugin never chooses an author model and never retries with one. Agents are told to set `svg_model` only when the operator names a model or the API asks for one; `imagegen_models` with `query` can list candidate IDs, which are not evidence of SVG support.

## OpenAI model discovery

`imagegen_models` accepts no arguments, a `query` or a `model`. `model` can't be combined with `query`, and other arguments are rejected. Without arguments it lists the key's `gpt-image-*` and `chatgpt-image-*` IDs with their creation date, owner and any shutdown date, and marks the default model, which both image tools send when `model` is omitted. `query` searches every ID the key lists with words that must all appear. `model` checks one exact ID. [Model discovery](backends.md#model-discovery) covers permission, request and failure behavior.

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

### OpenCode aspect and resolution

The `opencode` backend takes an optional `aspect`, a `WIDTH:HEIGHT` ratio of positive numbers such as `16:9`, and an optional `resolution` such as `1K`, `2K` or `4K`, rather than `size`, which is refused with a hint to use `aspect` and `resolution`. Both are requests passed to the model's provider and are omitted when unset. OpenCode doesn't report which values the provider applied, so the result reports the saved file's pixel dimensions, which are the only verified size.

## Reference images

Pass references in `imageedit`'s `images` and name each role in the prompt, for example: "Image 1: character design. Image 2: setting and colour palette." Each entry is a local path or an [HTTPS URL](#reference-urls). References are sent in the order given, and their contents are uploaded to the provider.

`imageedit` posts to the editing endpoint on Codex and the OpenAI Images API, sends an edit-model ID with the references on NanoGPT, and passes the references to the selected model on the `opencode` backend. `imagegen` sends no references.

An edit generates a new image guided by the prompt and references. It doesn't guarantee unchanged pixels outside the requested area. Use local image editing or compositing when a region must remain identical.

| Backend | Reference rules |
| --- | --- |
| Codex | Up to five files detected as images. The plugin applies no type or size rule of its own beyond the URL download limit; the endpoint decides what it accepts. |
| OpenAI API | Up to 16 PNG, JPEG or WebP files. Each encoded data URL must be at most 20,971,520 characters. |
| NanoGPT | PNG, JPEG or WebP files. Counts depend on the model; the route limit is 31,457,280 bytes per file, with Seedream and Qwen Image 3 Pro restricted to 10,485,760 bytes. |
| OpenCode | Up to eight PNG, JPEG, WebP or GIF files, each at most 20 MiB. |

FLUX's provider additionally documents references of at least 256 pixels per side and at most 16 megapixels, with downscaling above four megapixels. The plugin doesn't check those pixel constraints locally. OpenAI references are sent as `images[].image_url` data URLs; NanoGPT uses `input_references` and doesn't mix legacy image aliases.

### Reference URLs

On every backend, an `images` entry, and the OpenAI `mask`, can be an `https://` URL instead of a local path. An agent that passes URLs needs the host's `webfetch` permission; see [permissions](permissions.md#reference-urls).

- **Refused before any request:** every scheme other than `https`, including `http:`, `file:` and `data:`; URLs with embedded credentials; `localhost` and `.localhost` hosts; and IP-address hosts. An entry such as `C:\image.png` or `C:image.png` stays a local Windows path. Whether a public hostname resolves to a private address isn't checked.
- **Permission and redirects:** the plugin follows at most three redirects itself. It validates each hop, the first URL and every redirect target, and asks for `webfetch` permission on it before fetching it. Permission is asked for one URL at a time.
- **Download:** requests carry no credentials or authorization headers. All hops of one reference share a 30-second network budget, which excludes time spent waiting for a permission answer. Up to four references load at once, and the first failure cancels the others.
- **Size:** a download stops at the smallest of the backend's file limit, the largest file whose data URL fits the backend's limit, and 20 MiB. NanoGPT's 31,457,280-byte route limit therefore applies to local files only.
- **Checks and messages:** downloaded bytes get the same type and size checks as local files. Error messages name a URL by its origin and path, without the query or fragment, where signed URLs carry their tokens.

### Inpainting mask

On the OpenAI Images API, `imageedit` takes an optional `mask`: a PNG, by local path or HTTPS URL, applied to `images[0]`. Fully transparent pixels (alpha 0) mark the area to edit. `imagegen` refuses `mask` and points to `imageedit`.

Before any request, the plugin checks that the mask is a PNG that declares alpha (a grayscale-alpha or RGBA colour type, or a `tRNS` chunk), that its data URL fits OpenAI's 20,971,520-character limit, and that its pixel dimensions equal those of `images[0]` after EXIF orientation. Orientations 5 to 8 swap the first image's width and height. The mask is sent as `mask: { image_url }`.

GPT Image masking is guided by the prompt rather than locked to the mask's pixels, so areas outside the mask can still change.

## Transparent backgrounds

For Codex and OpenAI, set `background: "transparent"` for a cut-out. Prompt for one subject, complete edges and room around it; asking for transparency in prose doesn't set the argument.

Codex and OpenAI default to `opaque`. OpenAI accepts `transparent` only with PNG or WebP output. On NanoGPT, only the supported GPT Image 2.5 Flare pair exposes `background`, with `auto`, `opaque` or `transparent`; no default is injected. For other NanoGPT families, request transparency in the prompt without passing `background`; results vary by model. See the [observed workflow outcomes](backends.md#nanogpt-live-workflow-coverage).

The plugin doesn't modify alpha. For a saved PNG, the result reports the shares of transparent, semi-transparent and opaque pixels when it can decode the alpha channel, and says the alpha was not measured, with the reason, when it can't (for example tRNS transparency or an interlaced file). For a saved WebP, a simple lossy file has no alpha channel; for an extended or lossless file, the result reports only the alpha flag in the WebP header and doesn't measure pixels.

When a call sets `background: "transparent"` and the saved PNG is confirmed opaque, because it has no alpha channel or its alpha channel measures 100% opaque, the result includes a warning that the PNG has no transparent pixels. A PNG whose alpha wasn't measured, such as an interlaced file or one with `tRNS` transparency, gets no warning, and neither does a WebP.

Still check the image on light and dark backgrounds; a filename, RGBA channel or visible checkerboard does not prove transparency. Recorded Codex transparency includes soft edges and partially transparent subject pixels; in a direct-request study, many subject pixels were at alpha 252-253 rather than 255. Post-process when you need a fully opaque subject or hard matte. The [walkthrough](examples.md#transparency-check) records the example icon's actual alpha behavior.

## Output files

The saved file contains the provider's native bytes, without conversion or resizing. `imageedit` on every backend, and `imagegen` on Codex, NanoGPT and `opencode`, save PNG, JPEG or WebP; the OpenAI Images API's `imagegen` also saves GIF and SVG. Any other type, including GIF or SVG from any other tool, is refused. The plugin detects the format and reads its size before creating a directory or file:

- PNG, JPEG and WebP: finite positive pixel dimensions from the image header.
- GIF: the header's logical screen size, reported as the frame size. The frame count and the animation itself aren't checked.
- SVG: the document is parsed as strict XML and must have an `svg` root in the SVG namespace with a valid `viewBox` or a positive `width` and `height`. These are reported as vector units, not pixels. The document is refused if it is malformed or has a DOCTYPE, a processing instruction, a script, `foreignObject`, an image or other embedding element, animation elements, event handler attributes, links or `url()` references outside the document, an `xml:base`, or elements outside the SVG namespace (other vocabularies are allowed inside `metadata`, except XHTML). Style sheets, `style` attributes and SVG presentation attributes such as `fill`, `mask` and `filter` are checked as CSS: a CSS escape (any backslash), a `url()` reference that holds `/*`, `*/` or a quote after an unquoted target (so a same-document ID with those characters is refused too), an image function that can load a resource from a string or a custom property (`image-set()`, `image()`, `cross-fade()` or `src()`, with or without a vendor prefix), a style sheet at-rule such as `@import`, `@font-face` or `@keyframes`, and an `animation` or `transition` property are refused. Plain fills, strokes, gradients, filters, same-document `url(#id)` references and quoted font names pass. Other attribute values, such as `aria-label` or `data-*` text, aren't CSS and aren't checked as CSS. This matches OpenAI's description of its SVG output as static vector content without scripts, external resources or embedded raster images. It is a refusal check for those forms, not a sanitizer: treat a saved SVG as an untrusted document before embedding it in a web page.

Unsupported types and unreadable or invalid sizes fail with a bounded diagnostic that includes the detected type or the SVG refusal reason, never the provider's content. Header inspection doesn't establish that every pixel can be decoded or that the file is free of corruption.

The extension follows the detected bytes: `.png`, `.jpg`, `.webp`, `.gif` or `.svg`. An already matching extension is preserved, including `.jpeg` for JPEG and case variants. A mismatching suffix of a format the tool saves is replaced; a missing or other suffix gets the actual extension appended. For example, JPEG returned for `scene.png` is saved to `scene.jpg`, JPEG returned for `scene.asset` is saved to `scene.asset.jpg`, and from the OpenAI Images API's `imagegen` an SVG returned for `logo.png` is saved to `logo.svg`. For a tool that saves only PNG, JPEG or WebP, a `.gif` or `.svg` suffix isn't one of its formats, so PNG returned for `scene.gif` is saved to `scene.gif.png`.

The plugin creates the output file exclusively, so it never writes into an existing file or follows a symbolic link at the output path. If the format-adjusted target exists, including as a link or as a file a concurrent call created first, it is kept and the first free `-v2`, `-v3`, up to `-v999` suffix is used before the extension; when all of them are taken, the call fails. If writing fails after the file was created, the plugin tries to remove that file; when the removal also fails, the error names the path, where a partial file may remain. This relies on the file system honouring exclusive creation. A reader can see a partly written file while the write is in progress, and a crash during the write can leave one behind.

Both hosts return `{ out, versioned }` metadata. OpenCode 2 also returns the structured output `{ out, versioned, message }`, where `message` is the full report text, so a Code Mode caller receives the report alongside the path and the collision flag. `out` is the actual absolute saved path: use it for reads and as the next `imageedit` call's `images` input, rather than assuming the requested path was used. An SVG can't be a reference image on any backend, because the plugin doesn't detect it as an image. The OpenAI Images API and NanoGPT refuse a GIF reference before sending anything. The `opencode` backend accepts GIF references of at most 20 MiB. Codex sends any file detected as an image, including a GIF; whether its edits endpoint accepts a GIF hasn't been established. `versioned` is true only for a collision suffix, not an extension adjustment alone. The message reports the actual format and size (pixels, GIF frame size or SVG vector geometry) and explains extension adjustment and collision versioning separately.

Relative `out` and reference paths follow the calling session's directory. On OpenCode 2 that can differ from the directory that loaded the plugin. Absolute paths are accepted, including outside the project; see [file access](permissions.md#file-access).

## Inline preview

Every image tool takes an optional `preview` boolean, which defaults to `false`. It changes how the result is returned, never what is sent to the provider. Leave it `false` for batches.

- **OpenCode 2:** with `preview: true`, a saved PNG, JPEG or WebP of at most 3,670,016 bytes (3.5 MiB) is attached to the tool response as an inline image, in direct calls and in Code Mode. The `{ out, versioned, message }` output and the `{ out, versioned }` metadata stay the same. A larger image, a GIF or an SVG gets no attachment; the message says why and names the saved path.
- **OpenCode 1:** tool results carry text only, so `preview: true` attaches nothing. For a PNG, JPEG or WebP of at most 3,670,016 bytes, the message ends with a note that inline preview is supported only on OpenCode 2. For a larger image, a GIF or an SVG, the message gives the same omission reason as on OpenCode 2.

## OpenCode inputs

- `imagegen`: required `prompt`, `out` and `model`; optional `aspect`, `resolution` and `preview`.
- `imageedit`: the same, with a required list of 1 to 8 `images`.
- `imagegen_models`: no arguments, a `query`, or an exact `model`, which can't be combined with `query`.

`model` is `providerID/modelID` or `providerID/modelID#variant`, as listed by `imagegen_models`. [OpenCode connected models](backends.md#opencode-connected-models) covers the catalog checks and the host's retries.

## NanoGPT inputs

- `imagegen`: required `model`, `prompt`, `out`; optional controls supported by that model, and `preview`.
- `imageedit`: the same, with a required nonempty `images` list.
- `imagegen_models`: list filters `operation`, `family`, `query`, or an exact `model` for detailed controls, limits and input schemas. An exact model can't be combined with list filters. Lists group operation entries by tool and distinguish entries from distinct IDs. For a same-ID generation/edit model, one JSON object keyed by `imagegen` and `imageedit` holds both full argument schemas; a single-operation ID keeps the single-schema shape.

Qwen Image 3 Pro, Seedream's base ID, WAN 2.7 Image Pro and Muse use the same exact model ID for both tools. `imagegen` accepts text only; `imageedit` requires references even when its ID contains `text-to-image`. Seedream's additional `/edit` route is accepted only by `imageedit`. No suffix is synthesized or removed.

The image tools accept a curated set of generation/edit IDs and, like every backend's image tools, reject unknown arguments. They also reject unsupported controls or values, wrong-operation models, excess references and documented prompt-length violations before contacting the provider. There are no count, format, streaming or generic provider-routing arguments. Omitted controls aren't sent.

Every call asks for one image. Where the model's documented controls permit it, the request asks for PNG; otherwise the output format is left to NanoGPT. Native PNG, JPEG and WebP responses can be saved. [The model table](backends.md#generation-and-editing-models) lists the supported families.

## NanoGPT responses and errors

The plugin accepts exactly one `data` item with either inline `b64_json` or a download `url`. It refuses missing images, multiple images, both fields, pending jobs or a non-JSON body, and reports that nothing was saved and generation may already have been charged. It doesn't poll jobs, convert output formats or discard extra images to save only the first.

A download URL must use HTTPS without embedded credentials. IP literals, `localhost` and `.localhost` names, including trailing-dot variants, are refused. Public hostnames aren't checked for private-address DNS resolution. Downloads carry no API key, follow no redirects, use the call's cancellation signal and are limited to 64 MiB. An uncompressed download must match a valid declared `Content-Length`; compressed responses can have an encoded length different from their decoded body.

Provider HTTP errors include the tool, model, status, bounded error code and message, with the key removed. HTTP 5xx and transport/read failures disclose possible charges. Network diagnostics name the stage without exposing runtime messages, codes, causes, signed URLs or download hosts. A failed download or save doesn't imply the provider refunded a generation.

## Validation, permissions and cancellation

Arguments are validated before permission, on every backend and for both image tools. Permission is requested for the invoked tool's name before credentials, references or the provider are touched. Reference URLs then ask for `webfetch` permission before each download. Invalid reference files and masks fail before the quota-consuming request.

The `imagegen_models` lookups of the OpenAI Images API and the `opencode` backend follow the same order without a session directory or files: arguments, then permission, then the credential, then one model-list request.

Stopping a call forwards cancellation to the provider request and to reference downloads. A result arriving after cancellation isn't saved or returned. Failures and cancellations propagate rather than returning success, and the plugin never retries or selects another backend or model. On the `opencode` backend, OpenCode's own image generation can retry eligible provider errors; see [OpenCode connected models](backends.md#opencode-connected-models).

Provider access, account quota, balance, key scope and model availability are enforced by the selected service, not probed at startup. On the OpenAI Images API, `imagegen_models` shows which models the key lists, not which features they support. Check a returned error before deciding whether to correct an input or ask the operator for a decision.
