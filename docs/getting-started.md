# Getting started

[README](../README.md) · [Backends](backends.md) · [Permissions](permissions.md)

The quickest path is the default Codex backend, which uses your ChatGPT sign-in in OpenCode. You don't need a separate OpenAI Images API key for it.

## Install from npm

Add `oc-multi-imagegen` to your OpenCode configuration, keeping any existing plugins. OpenCode downloads the package and its dependencies from npm when the server starts.

The support floors are OpenCode **1.18.29** and **2.3.2**; see [compatibility and recorded coverage](backends.md#compatibility-and-recorded-coverage) for what has actually been checked.

### OpenCode 1

Add the package to `plugin`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-multi-imagegen"]
}
```

### OpenCode 2

Add the package to `plugins`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["oc-multi-imagegen"]
}
```

Restart the OpenCode server process that loads the plugin. If you attach a client to an existing server, restarting the client alone doesn't reload the plugin.

### Pin a version

Use `oc-multi-imagegen@3.0.0` instead of the bare package name to select that exact release. The same package-and-version syntax works in either host's array. Without a version, OpenCode resolves the npm package's current release according to its plugin loader.

## Sign in for Codex

Use OpenCode's ChatGPT sign-in for the `openai` provider. An OpenAI API key isn't sufficient for the Codex backend.

On **OpenCode 2**, choose **Codex browser (legacy)** or **Codex device code (legacy)**. The **Sign in with ChatGPT** token-sharing connection doesn't work with this image endpoint. [Backend authentication](backends.md#codex) explains the credential sources and supported methods.

Leave `OC_MULTI_IMAGEGEN_BACKEND` unset, or set it to `codex` in the server's environment. If you previously selected another backend, change that variable and restart the server, or on OpenCode 2 change the plugin options described under [other backends](#other-backends).

## Make your first image

Ask the agent:

> Create a wide, hand-painted illustration of a woodland post office at sunset and save it as `images/post-office.png`.

The agent can load the bundled `oc-multi-imagegen` skill, call `imagegen`, inspect the saved image and pass it to `imageedit` as a reference for another image. Both tools have the same role on every backend. They save native PNG, JPEG or WebP bytes, or GIF and SVG from `imagegen` on the OpenAI Images API backend, and adjust the extension to match. Use the returned `out` path for reads and subsequent edits. An SVG result can't be a reference image; a GIF result can be one only on a backend that accepts GIF references, such as `opencode` (see [output files](tool-reference.md#output-files)). The tools also work when the skill isn't available or permitted.

For an edit, name the existing file from the result's `out` and the change; the agent sends both to `imageedit`. If the result above is `images/post-office.png`:

> Use `images/post-office.png` as a reference. Change the scene to a rainy evening and save it as `images/post-office-rain.png`.

OpenCode may ask you to allow the image operation. For restricted agents or prompt-free operation, configure [permissions](permissions.md). Prompts and reference images go to the selected provider, and generation uses that account's image access and quota.

## Other backends

Use the [backend guide](backends.md) to configure the OpenAI Images API, NanoGPT or, on OpenCode 2, the image models of OpenCode's connected providers.

- **OpenCode 1** selects its one backend with `OC_MULTI_IMAGEGEN_BACKEND` in the environment of the **server that loads the plugin**. Setting it in a client shell attached to an already-running server has no effect.
- **OpenCode 2** also accepts plugin options, which select one backend or several and apply when OpenCode reloads the plugin:

  ```jsonc
  {
    "plugins": [{ "package": "oc-multi-imagegen", "options": { "backends": ["openai-api", "opencode"] } }]
  }
  ```

  Use either the options or the variable. Setting both fails the plugin load.

API keys stay in the server environment or in keys saved in OpenCode, never in plugin options.

For systemd, credential precedence or a sign-in error, start with [configuration and authentication](backends.md#configuration).

## Local development

Use a checkout when you want to modify the plugin. With Bun installed:

```sh
git clone https://github.com/imarshallwidjaja/oc-multi-imagegen.git
cd oc-multi-imagegen
bun install --frozen-lockfile
bun run build
```

Replace the npm entry with the checkout's absolute file URL: `"file:///absolute/path/to/oc-multi-imagegen"`. Use `plugin` on OpenCode 1 or `plugins` on OpenCode 2, as in the examples above. Rebuild and restart the loading server after changing source. [Development](development.md) lists the checks and packaging details.
