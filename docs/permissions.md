# Permissions

[README](../README.md) · [Getting started](getting-started.md) · [Backends](backends.md)

Image calls, and the model lookups of the OpenAI Images API and the `opencode` backend, request permission before reading credentials or references or contacting the provider. The permission action is the invoked tool's name; the resource is the backend ID.

| Backend | Actions that request permission | Resource |
| --- | --- | --- |
| Codex | `imagegen`, `imageedit` | `codex` |
| OpenAI Images API | `imagegen`, `imageedit`, `imagegen_models` | `openai-api` |
| NanoGPT | `imagegen`, `imageedit` | `nano-gpt` |
| OpenCode (OpenCode 2 only) | `imagegen`, `imageedit`, `imagegen_models` | `opencode` |

A grant saved for one backend doesn't grant another. On every backend, `imageedit` is a separate action from `imagegen`: allow both for an agent that should create and edit images. A configuration written for an earlier release that allows only `imagegen` on Codex or the OpenAI Images API needs `imageedit` added for reference edits. The `imagegen_models` of the OpenAI Images API and the `opencode` backend is a separate action too; allow it for an agent that should look up the available models before choosing one, which the tool descriptions ask agents to do.

## OpenCode 1

This deny-by-default example allows image generation and editing on any backend, and the bundled skill:

```json
{
  "permission": {
    "*": "deny",
    "imagegen": "allow",
    "imageedit": "allow",
    "skill": { "*": "deny", "oc-multi-imagegen": "allow" }
  }
}
```

For the OpenAI Images API or NanoGPT, also add `"imagegen_models": "allow"` inside the same `permission` object. NanoGPT's local `imagegen_models` doesn't request permission itself, but an allow rule makes it available to a restricted agent.

To restrict `imagegen` to the OpenAI API resource, use the following, and the same form for `imageedit`:

```json
{
  "imagegen": { "*": "deny", "openai-api": "allow" }
}
```

## OpenCode 2

Rules go in `permissions`, with the broad rule first and the narrower ones last:

```jsonc
{
  "permissions": [
    { "action": "*", "resource": "*", "effect": "deny" },
    { "action": "imagegen", "resource": "*", "effect": "allow" },
    { "action": "imageedit", "resource": "*", "effect": "allow" },
    { "action": "skill", "resource": "oc-multi-imagegen", "effect": "allow" }
  ]
}
```

For the OpenAI Images API, NanoGPT or the `opencode` backend, append an allow rule for `imagegen_models`. To restrict an image action to one backend, set its `resource` to that backend ID, such as `openai-api` or `nano-gpt`.

On OpenCode 2 the plugin registers its tools for Code Mode in the `image` namespace: `tools.image.imagegen` with one backend, or `tools.image.<backend>.imagegen` with several (see [OpenCode 2 tool paths](tool-reference.md#opencode-2-tool-paths)). The permission actions stay the bare tool names (`imagegen`, `imageedit`, `imagegen_models`) on the backend resource, whatever the path, so the rules above apply unchanged.

When one load runs several backends, a rule with `resource: "*"` allows the action on every loaded backend. If you mix a backend that uses a subscription or free access with one that bills an API key, name the resource in each allow rule instead. For example, allow `imagegen` and `imageedit` with `"resource": "codex"`, and add rules with `"resource": "openai-api"` only for agents that should spend that key's credit.

An agent that uses Code Mode needs `execute` allowed alongside the image actions. On OpenCode 2.3.2 and later, an agent whose rules deny `execute` gets the allowed image tools as direct tools instead.

## Skills and model information

The bundled `oc-multi-imagegen` skill is guidance, not an execution dependency. With image tools allowed and the skill denied, the agent can still generate using the tool descriptions. Allowing only the skill doesn't allow generation. The plugin never asks for a separate `skill` permission.

On NanoGPT, `imagegen_models` answers from the plugin's curated table. It reads no credential, reference file or provider API, and incurs no generation charge. Host-level visibility of local tools under deny-by-default rules hasn't been checked against a live NanoGPT host configuration; allow the tool explicitly.

On the OpenAI Images API, `imagegen_models` asks for its permission, then reads the image key and sends one `GET /v1/models` request to OpenAI. It reads and writes no files and generates nothing.

On the `opencode` backend, `imagegen_models` asks for its permission, then reads OpenCode's catalog of image models. It reads and writes no files and generates nothing.

## Reference URLs

An `images` entry or OpenAI `mask` given as an HTTPS URL is downloaded under the host's `webfetch` permission, the one OpenCode's own webfetch tool uses. The image permission alone doesn't cover it. Each URL, including every redirect target, asks for `webfetch` on that URL before it is fetched, so allow `webfetch` for an agent that passes reference URLs.

- **OpenCode 1** asks with the URL as the pattern. Choosing "always" saves `*`, which allows `webfetch` for every URL.
- **OpenCode 2** asks with the URL as the resource. A saved grant covers the URL's origin and the paths below it (`https://example.com` and `https://example.com/*`). An origin that contains `*` saves nothing, so such a grant can't turn into a wildcard rule for other hosts.

A denied URL stops the call before that URL or any later one is fetched.

## File access

The image permission covers the whole operation, including its output and reference paths. The plugin doesn't ask for separate file-access permissions: `out`, `images` and OpenAI's `mask` accept absolute paths outside the project as well as relative paths.

An agent that inspects the result also needs a suitable `read` rule. Scope it to the generated files you intend, allowing PNG, JPEG (`.jpg` and `.jpeg`) and WebP paths when those formats can be returned, and GIF and SVG paths when the OpenAI Images API's `imagegen` can return them. The output extension can change to match the provider's bytes, so use the returned `out` path for reads and subsequent edits. A billed API call asks for no additional billing approval beyond the image permission, so keep image-tool access consistent with the quota you want an agent or subagent to use.
