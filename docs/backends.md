# Backends

[README](../README.md) · [Getting started](getting-started.md) · [Tool reference](tool-reference.md)

One backend is active per plugin load. The selected backend controls the registered tools, their arguments and their defaults.

| `OC_MULTI_IMAGEGEN_BACKEND` | Provider | Credential | Tools |
| --- | --- | --- | --- |
| Unset or `codex` | ChatGPT Codex image backend | OpenCode's ChatGPT sign-in for `openai` | `imagegen` |
| `openai-api` | Official OpenAI Images API | `OC_MULTI_IMAGEGEN_OPENAI_API_KEY`, otherwise saved `openai-images` key | `imagegen` |
| `nano-gpt` | NanoGPT normalized image API | `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY`, otherwise saved `nano-gpt-images` key | `imagegen`, `imageedit`, `imagegen_models` |

Changing the backend takes a server restart. A call can't select another backend, and a failure doesn't trigger a retry or fallback to another backend.

## Configuration

The plugin reads three environment variables:

| Variable | Behavior |
| --- | --- |
| `OC_MULTI_IMAGEGEN_BACKEND` | Read once at plugin load. Empty or unknown values fail the load without registering image tools. |
| `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` | Image key for `openai-api` only, resolved on each call. |
| `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` | Image key for `nano-gpt` only, resolved on each call. |

The plugin takes no options and reads no `.env` or other configuration file. Remove a `backend` option left by an older build; it now fails the load with a message naming the environment variable to use. Other plugin options also fail.

Set variables in the environment of the OpenCode **server**. Exporting one in a shell that only starts a client attached to a running server doesn't change that server's environment.

### systemd example

For a system service named `opencode.service`, an OpenAI API configuration can use:

```ini
[Service]
Environment=OC_MULTI_IMAGEGEN_BACKEND=openai-api
EnvironmentFile=/etc/opencode/oc-multi-imagegen.env
```

The environment file contains a placeholder here; store the real file with mode `600`:

```sh
OC_MULTI_IMAGEGEN_OPENAI_API_KEY=<OpenAI Images API key>
```

Run `systemctl daemon-reload` and `systemctl restart opencode.service` after changing the unit or its environment file. For a user unit, use `systemctl --user daemon-reload` and `systemctl --user restart opencode.service`, with an environment file you own, such as `%h/.config/opencode/oc-multi-imagegen.env`.

Use `nano-gpt` and `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` for NanoGPT. Keep keys in restricted environment files rather than readable unit files. These files are read by systemd, not by the plugin.

## Codex

Codex uses OpenCode's ChatGPT sign-in. Access depends on your account and the availability and limits of the ChatGPT Codex image backend; an OpenAI API key doesn't authenticate it.

- **OpenCode 1** reads the `openai` OAuth entry from `OPENCODE_AUTH_CONTENT` when set, otherwise from `auth.json` under OpenCode's XDG data directory.
- **OpenCode 2** resolves the active `openai` connection on every call. It accepts **Codex browser (legacy)** and **Codex device code (legacy)**, with the connection's account ID when present. It rejects the **Sign in with ChatGPT** token-sharing method, API keys, missing connections and unrecognized methods. Host credential lookup or refresh errors propagate unchanged.

OpenCode 2 doesn't read `OPENCODE_AUTH_CONTENT` or `auth.json`, and the plugin doesn't refresh OAuth tokens. Neither image API key variable affects Codex.

The default request names `gpt-image-2` with `quality: auto`. Model and quality overrides are sent as requested, but the Codex response doesn't identify the settings it applied. In a direct-request study on one ChatGPT Pro account on 2026-10-20, requests accepted nonexistent model names and didn't reliably honor requested quality tiers. Treat these controls as **requested, not verified**; a call using either override reports that distinction. See [sizes and output](tool-reference.md#sizes) for the similar distinction between requested and returned dimensions.

## OpenAI Images API

This backend uses a key separate from the `openai` chat provider. The plugin sends it only to OpenAI's `/v1/images/generations` or `/v1/images/edits` endpoint when an image is requested. Loading the plugin doesn't check the key or make a network request.

The request defaults to model `gpt-image-2.5-sunburst` and quality `auto`. Any `model` or `quality` string is passed through; the API decides whether the model exists, the key can use it and the settings are supported. API calls bill the key's account. HTTP errors include the status and response body, with the key removed.

### Key precedence

1. If `OC_MULTI_IMAGEGEN_OPENAI_API_KEY` is **present**, it is the credential. A present empty value or a value unsuitable for an HTTP header fails the call without consulting a saved key. A rejected key is reported once, without trying another credential.
2. Otherwise, the plugin uses the `openai-images` key saved in OpenCode.

It never reads `OPENAI_API_KEY`, which might be a chat key, or loads a dotenv file.

### Save a key in OpenCode

- **OpenCode 1:** run `opencode auth login --provider openai-images`, or choose **Other** in the provider list and enter `openai-images`. The host saves an `api` entry. The plugin registers an API sign-in method, not a chat provider or model.
- **OpenCode 2:** run `opencode auth login openai-images`, or connect the **OpenAI Images API** integration. It registers key and environment methods. When the variable is present, the plugin asks the host to resolve that environment connection directly, even if the host lists a saved key first. Otherwise it resolves the active saved connection.

OpenCode 1 reads the variable itself after permission. Without it, it follows the host's stored-auth behavior: `OPENCODE_AUTH_CONTENT`, falling through to `auth.json` if that content doesn't parse. OpenCode 2 only checks variable presence and lets the host read the value; it never falls back to those files. Missing or non-key credentials produce a message naming the variable or sign-in command. Chat credentials are never used as an image key.

## NanoGPT

Select `nano-gpt` and provide `OC_MULTI_IMAGEGEN_NANOGPT_API_KEY` in the server environment, or save a key under `nano-gpt-images`:

- **OpenCode 1:** `opencode auth login --provider nano-gpt-images`.
- **OpenCode 2:** `opencode auth login nano-gpt-images`, or connect the **NanoGPT API** integration.

Environment-over-saved precedence, failure behavior and per-host resolution work as for the OpenAI image key. The plugin doesn't read the other backends' keys, `NANOGPT_API_KEY` or dotenv files. It sends the key only to `https://api.nano-gpt.com/api/v1/images`. Result downloads carry no key.

### Generation and editing models

Every image call names an exact supported model ID. `imagegen` creates from text; `imageedit` requires references. Use the local `imagegen_models` tool to find the right model and its input schema without a key, file access or network request.

| Family | `imagegen` model | `imageedit` model | Optional controls | Edit references |
| --- | --- | --- | --- | --- |
| GPT Image 2.5 Flare | `openai/gpt-image-2.5/flare/text-to-image` | `openai/gpt-image-2.5/flare/edit` | `resolution`, `aspect_ratio`, `quality`, `background` | Up to 16 |
| Nano Banana Pro | `nano-banana-pro` | `nano-banana-pro-edit` | `resolution`, `aspect_ratio` | Up to 10 |
| FLUX.3 Image | `black-forest-labs/flux-3/text-to-image` | `black-forest-labs/flux-3/edit` | `resolution`, `aspect_ratio` | Up to 10 |
| Seedream 5.0 Pro | `bytedance/seedream-v5.0-pro` | `bytedance/seedream-v5.0-pro/edit` | `resolution`, including ratios such as `16:9` | Up to 10, each at most 10 MiB |
| Qwen Image 2.1 | `qwen-image-2.1/text-to-image` | `qwen-image-2.1/edit` | `resolution`, `aspect_ratio`, `seed` | Up to 10 |

Controls left out of a call aren't sent, so NanoGPT applies its defaults. An unsupported control, value, model, operation or unknown argument is rejected before a provider request. No generic passthrough or runtime catalogue fetch is provided; new NanoGPT models need an update to the plugin's table.

Agents are guided to respect the operator's model choice, otherwise pick a supported model and give a short reason. Missing inputs or conflicts with a requested model, capability, cost or requirement need the operator's decision. Errors never silently change a model. Authentication, balance and rate-limit failures aren't retried; an agent should only correct an input when the error identifies a demonstrable mistake.

The curated table follows NanoGPT documentation and public metadata, which are incomplete and inconsistent between sources. It **hasn't been validated with live NanoGPT calls**. A missing control means this plugin doesn't send it, rather than proving the provider lacks it. [Response handling and limits](tool-reference.md#nanogpt-responses-and-errors) explain the supported result shapes.

## Compatibility and recorded coverage

| Host | Support floor | Recorded coverage |
| --- | --- | --- |
| OpenCode 1 | 1.18.29 | 1.19.3: real-agent Codex and OpenAI API runs. Floor: plugin/skill load and OpenAI API sign-in registration only. |
| OpenCode 2 | 2.0.32 | 2.0.32: real-agent Codex and OpenAI API runs. |

The Codex container runs covered skill loading and image generation before backend selection existed. OpenAI API runs covered generation and a reference edit on each host, including environment-key precedence and, in an earlier run, saved keys. Intermediate or newer host versions aren't established by those runs. The [container runbook](https://github.com/imarshallwidjaja/oc-multi-imagegen/blob/main/docs/container-testing.md) retains the recorded evidence and source identities.

The README artwork is a separate live Codex example chain, not a new container compatibility run. NanoGPT has mocked unit coverage only.

## Account access and data

Prompts and reference images go to the active provider. Calls may consume ChatGPT quota or API credit, and the plugin doesn't probe key scope or model availability beforehand. Credentials are resolved per call after permission and are never written, activated or refreshed by the plugin.

This is an unofficial integration, not an OpenAI or OpenCode product. The MIT license covers the software, not provider access or service terms.
