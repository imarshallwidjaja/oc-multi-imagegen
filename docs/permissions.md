# Permissions

[README](../README.md) · [Getting started](getting-started.md) · [Backends](backends.md)

Image calls, and the OpenAI Images API's model lookup, request permission before reading credentials or references or contacting the provider. The permission action is the invoked tool's name; the resource is the active backend ID.

| Backend | Actions that request permission | Resource |
| --- | --- | --- |
| Codex | `imagegen` | `codex` |
| OpenAI Images API | `imagegen`, `imagegen_models` | `openai-api` |
| NanoGPT | `imagegen`, `imageedit` | `nano-gpt` |

A grant saved for one backend doesn't grant another. NanoGPT's `imageedit` is separate from `imagegen`, and the OpenAI Images API's `imagegen_models` is separate from `imagegen`. Allow `imagegen_models` for an agent that should look up the key's models before choosing one, which the tool descriptions ask agents to do.

## OpenCode 1

This deny-by-default example allows Codex or OpenAI image work and the bundled skill:

```json
{
  "permission": {
    "*": "deny",
    "imagegen": "allow",
    "skill": { "*": "deny", "oc-multi-imagegen": "allow" }
  }
}
```

For the OpenAI Images API, also add `"imagegen_models": "allow"`. For NanoGPT, also add:

```json
{
  "imageedit": "allow",
  "imagegen_models": "allow"
}
```

These entries belong inside the existing `permission` object. NanoGPT's local `imagegen_models` doesn't request permission itself, but an allow rule makes it available to a restricted agent.

To restrict `imagegen` to the OpenAI API resource, use:

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
    { "action": "skill", "resource": "oc-multi-imagegen", "effect": "allow" }
  ]
}
```

For the OpenAI Images API, append an allow rule for `imagegen_models`; for NanoGPT, append allow rules for `imageedit` and `imagegen_models`. To restrict an image action to one backend, set its `resource` to that backend ID, such as `openai-api` or `nano-gpt`.

All image tools are direct tools, so allowing them doesn't require allowing OpenCode 2's `execute` tool.

## Skills and model information

The bundled `oc-multi-imagegen` skill is guidance, not an execution dependency. With image tools allowed and the skill denied, the agent can still generate using the tool descriptions. Allowing only the skill doesn't allow generation. The plugin never asks for a separate `skill` permission.

On NanoGPT, `imagegen_models` answers from the plugin's curated table. It reads no credential, reference file or provider API, and incurs no generation charge. Host-level visibility of local tools under deny-by-default rules hasn't been checked against a live NanoGPT host configuration; allow the tool explicitly.

On the OpenAI Images API, `imagegen_models` asks for its permission, then reads the image key and sends one `GET /v1/models` request to OpenAI. It reads and writes no files and generates nothing.

## File access

The image permission covers the whole operation, including its output and reference paths. The plugin doesn't ask for separate file-access permissions: `out` and `images` accept absolute paths outside the project as well as relative paths.

An agent that inspects the result also needs a suitable `read` rule. Scope it to the generated files you intend, allowing PNG, JPEG (`.jpg` and `.jpeg`) and WebP paths when those formats can be returned, and GIF and SVG paths on the OpenAI Images API. The output extension can change to match the provider's bytes, so use the returned `out` path for reads and subsequent edits. A billed API call asks for no additional billing approval beyond the image permission, so keep image-tool access consistent with the quota you want an agent or subagent to use.
