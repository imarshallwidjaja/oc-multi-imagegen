# Permissions

[README](../README.md) · [Getting started](getting-started.md) · [Backends](backends.md)

Image calls request permission before reading credentials or references or contacting the provider. The permission action is the invoked tool's name; the resource is the active backend ID.

| Backend | Image actions | Resource |
| --- | --- | --- |
| Codex | `imagegen` | `codex` |
| OpenAI Images API | `imagegen` | `openai-api` |
| NanoGPT | `imagegen`, `imageedit` | `nano-gpt` |

A grant saved for one backend doesn't grant another. NanoGPT's `imageedit` is separate from `imagegen`.

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

For NanoGPT, also add:

```json
{
  "imageedit": "allow",
  "imagegen_models": "allow"
}
```

These two entries belong inside the existing `permission` object. The local `imagegen_models` tool doesn't request permission itself, but an allow rule makes it available to a restricted agent.

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

For NanoGPT, append allow rules for `imageedit` and `imagegen_models`. To restrict an image action to one backend, set its `resource` to that backend ID, such as `openai-api` or `nano-gpt`.

All image tools are direct tools, so allowing them doesn't require allowing OpenCode 2's `execute` tool.

## Skills and model information

The bundled `oc-multi-imagegen` skill is guidance, not an execution dependency. With image tools allowed and the skill denied, the agent can still generate using the tool descriptions. Allowing only the skill doesn't allow generation. The plugin never asks for a separate `skill` permission.

`imagegen_models` answers from the plugin's curated table. It reads no credential, reference file or provider API, and incurs no generation charge. Host-level visibility of local tools under deny-by-default rules hasn't been checked against a live NanoGPT host configuration; allow the tool explicitly.

## File access

The image permission covers the whole operation, including its output and reference paths. The plugin doesn't ask for separate file-access permissions: `out` and `images` accept absolute paths outside the project as well as relative paths.

An agent that inspects the result also needs a suitable `read` rule. Scope it to the files you intend, such as generated `*.png` files. A billed API call asks for no additional billing approval beyond the image permission, so keep image-tool access consistent with the quota you want an agent or subagent to use.
