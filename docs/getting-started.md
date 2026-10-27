# Getting started

[README](../README.md) · [Backends](backends.md) · [Permissions](permissions.md)

The quickest path is the default Codex backend, which uses your ChatGPT sign-in in OpenCode. You don't need a separate OpenAI Images API key for it.

## Install from the repository

Install Bun and OpenCode, then clone and build:

```sh
git clone https://github.com/imarshallwidjaja/oc-multi-imagegen.git
cd oc-multi-imagegen
bun install --frozen-lockfile
bun run build
```

These instructions use a local checkout, not a published npm release. The support floors are OpenCode **1.18.29** and **2.0.32**; see [compatibility and recorded coverage](backends.md#compatibility-and-recorded-coverage) for what has actually been checked.

## Connect the plugin

Replace the example file URL with the absolute path of your checkout. Keep any other plugins already in your configuration.

### OpenCode 1

Add the package to `plugin`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/oc-multi-imagegen"]
}
```

### OpenCode 2

Add the package to `plugins`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/oc-multi-imagegen"]
}
```

Restart the OpenCode server process that loads the plugin. If you attach a client to an existing server, restarting the client alone doesn't reload the plugin. Rebuild and restart that server after changing plugin source.

## Sign in for Codex

Use OpenCode's ChatGPT sign-in for the `openai` provider. An OpenAI API key isn't sufficient for the Codex backend.

On **OpenCode 2**, choose **Codex browser (legacy)** or **Codex device code (legacy)**. The **Sign in with ChatGPT** token-sharing connection doesn't work with this image endpoint. [Backend authentication](backends.md#codex) explains the credential sources and supported methods.

Leave `OC_MULTI_IMAGEGEN_BACKEND` unset, or set it to `codex` in the server's environment. If you previously selected another backend, change that variable and restart the server.

## Make your first image

Ask the agent:

> Create a wide, hand-painted illustration of a woodland post office at sunset and save it as `images/post-office.png`.

The agent can load the bundled `oc-multi-imagegen` skill, call `imagegen`, inspect the saved PNG and use it as a reference for another image. The tool also works when the skill isn't available or permitted.

For an edit, name the existing file and the change:

> Use `images/post-office.png` as a reference. Change the scene to a rainy evening and save it as `images/post-office-rain.png`.

OpenCode may ask you to allow the image operation. For restricted agents or prompt-free operation, configure [permissions](permissions.md). Prompts and reference images go to the selected provider, and generation uses that account's image access and quota.

## Other backends

Use the [backend guide](backends.md) to configure the OpenAI Images API or NanoGPT. Settings belong in the environment of the **server that loads the plugin**, rather than in plugin options or a client shell attached to an already-running server.

For systemd, credential precedence or a sign-in error, start with [configuration and authentication](backends.md#configuration).
