import type { Plugin } from "@opencode/plugin"
import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./v1"
import { setup } from "./v2"

// One default export serves both hosts: OpenCode 1 calls server() and OpenCode 2 calls setup().
// Both SDKs are imported for types only, so installing this package needs neither at runtime.
export default {
  id: "oc-multi-imagegen",
  server,
  setup,
} satisfies PluginModule & Plugin.Plugin
