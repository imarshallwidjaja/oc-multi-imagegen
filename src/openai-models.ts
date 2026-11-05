import { z } from "zod"
import { IMAGEEDIT_TOOL, IMAGEGEN_TOOL } from "./schema"

// The model list of the OpenAI API. It reports only each model's id, created, object, owned_by and shutdown_date: no
// capability, output format or size. The list is read on each call and never cached, so it is the key's current view.
// https://developers.openai.com/api/reference/resources/models/methods/list
const MODELS_ENDPOINT = "https://api.openai.com/v1/models"

// The Images API model families: GPT Image and ChatGPT Image IDs.
const IMAGE_FAMILY = /^(?:gpt-image-|chatgpt-image-)/
// Model IDs are printable ASCII without spaces; anything else makes the response unusable rather than being shown.
const MODEL_ID = /^[\x21-\x7e]{1,256}$/
// A list longer than this names how many entries it leaves out and how to narrow it. The image families stay far below.
const MAX_LISTED = 200
const MAX_ERROR_DETAIL = 500
// The largest Unix time in seconds a JavaScript Date can represent (8.64e15 ms), so a listed creation date can be shown.
const MAX_TIMESTAMP_SECONDS = 8.64e12

type ListedModel = { id: string; created?: number; ownedBy?: string; shutdownDate?: string }

export const openaiModelsSchema = z
  .strictObject({
    query: z
      .string()
      .min(1)
      .nullish()
      .describe(
        "Words that must all appear in a model ID. Searches every ID the key lists, image models or not, for example to find an author model for svg_model.",
      ),
    model: z.string().min(1).nullish().describe("One exact model ID to look up in the key's list."),
  })
  .superRefine((args, ctx) => {
    if (args.model && args.query) {
      ctx.addIssue({ code: "custom", path: ["model"], message: "model cannot be combined with query." })
    }
  })

type OpenAiModelsArgs = z.output<typeof openaiModelsSchema>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Owner and shutdown text from the response is shown with control and non-ASCII characters replaced, cut to a length.
const shown = (text: string, limit: number) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, limit)

// The body is untrusted JSON. A model without a usable id makes the whole response unusable: skipping it would leave
// the list silently incomplete.
function parseModels(text: string): ListedModel[] {
  const malformed = (reason: string) =>
    new Error(`openai-api models response is malformed: ${reason}. The model list could not be read.`)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw malformed("the body is not JSON")
  }
  if (!isRecord(body) || !Array.isArray(body.data)) throw malformed("data is not a list")
  return body.data.map((entry: unknown, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !MODEL_ID.test(entry.id)) {
      throw malformed(`data[${index}] has no usable id`)
    }
    const { id, created, owned_by: ownedBy, shutdown_date: shutdownDate } = entry
    if (
      created !== undefined &&
      (typeof created !== "number" || !Number.isFinite(created) || Math.abs(created) > MAX_TIMESTAMP_SECONDS)
    ) {
      throw malformed(`data[${index}].created is not a representable Unix timestamp`)
    }
    if (ownedBy !== undefined && typeof ownedBy !== "string") throw malformed(`data[${index}].owned_by is not a string`)
    if (shutdownDate != null && typeof shutdownDate !== "string") {
      throw malformed(`data[${index}].shutdown_date is not a string or null`)
    }
    return {
      id,
      ...(created !== undefined ? { created } : {}),
      ...(ownedBy !== undefined ? { ownedBy: shown(ownedBy, 64) } : {}),
      ...(typeof shutdownDate === "string" ? { shutdownDate: shown(shutdownDate, 32) } : {}),
    }
  })
}

// GETs the key's model list. A failed request reports the status and a bounded body with the key removed; a network
// failure or cancellation propagates unchanged. Nothing is retried.
async function fetchModels(key: string, signal: AbortSignal): Promise<ListedModel[]> {
  const res = await fetch(MODELS_ENDPOINT, { method: "GET", headers: { Authorization: `Bearer ${key}` }, signal })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `openai-api models request failed: ${res.status} ${text.replaceAll(key, "[redacted]").slice(0, MAX_ERROR_DETAIL)}`,
    )
  }
  return parseModels(text)
}

function describeModel(model: ListedModel, defaultModel: string): string {
  const facts = [
    model.created !== undefined && `created ${new Date(model.created * 1000).toISOString().slice(0, 10)}`,
    model.ownedBy && `owned by ${model.ownedBy}`,
    model.shutdownDate && `shutdown date ${model.shutdownDate}`,
  ].filter(Boolean)
  return `- ${model.id}${model.id === defaultModel ? " (default)" : ""}${facts.length > 0 ? `: ${facts.join(", ")}` : ""}`
}

// Newest first, then by ID.
function listLines(models: readonly ListedModel[], defaultModel: string): string[] {
  const sorted = [...models].sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
  const lines = sorted.slice(0, MAX_LISTED).map((model) => describeModel(model, defaultModel))
  if (sorted.length > MAX_LISTED) {
    lines.push(`- ... and ${sorted.length - MAX_LISTED} more not shown; narrow the list with query.`)
  }
  return lines
}

const NOT_CAPABILITIES =
  "GET /v1/models reports only each ID, creation date, owner and shutdown date, so a listed model is not proof that it supports SVG, GIF, a size or any other feature; those are known only when a request succeeds."
const PASSTHROUGH = `${IMAGEGEN_TOOL} and ${IMAGEEDIT_TOOL} send any model ID unchanged, listed or not, and the API decides whether the key can use it.`

// Answers from the list the API returned on this call.
export async function lookUpOpenAiModels(
  key: string,
  args: OpenAiModelsArgs,
  signal: AbortSignal,
  defaultModel: string,
): Promise<string> {
  const models = await fetchModels(key, signal)
  const total = `${models.length} model ID${models.length === 1 ? "" : "s"}`
  const images = models.filter((model) => IMAGE_FAMILY.test(model.id))
  if (args.model) {
    const found = models.find((model) => model.id === args.model)
    if (found) {
      return [
        `${found.id} is listed by GET /v1/models for this key.`,
        describeModel(found, defaultModel),
        NOT_CAPABILITIES,
        PASSTHROUGH,
      ].join("\n")
    }
    return [
      `${args.model} is not listed by GET /v1/models for this key (${total} listed).`,
      PASSTHROUGH,
      images.length > 0 ? "Image models listed:" : "No gpt-image-* or chatgpt-image-* IDs are listed.",
      ...listLines(images, defaultModel),
    ].join("\n")
  }
  if (args.query) {
    const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = models.filter((model) => terms.every((term) => model.id.toLowerCase().includes(term)))
    return [
      `Model IDs listed by GET /v1/models for this key that contain ${terms.map((term) => JSON.stringify(term)).join(" and ")}: ${matches.length} of ${total}. The search covers every listed ID, image models or not.`,
      ...(matches.length > 0 ? listLines(matches, defaultModel) : ["- none"]),
      NOT_CAPABILITIES,
      PASSTHROUGH,
    ].join("\n")
  }
  const defaultListed = images.some((model) => model.id === defaultModel)
  return [
    `OpenAI image models listed by GET /v1/models for this key (gpt-image-* and chatgpt-image-* IDs): ${images.length} of ${total}.`,
    ...(images.length > 0 ? listLines(images, defaultModel) : ["- none"]),
    ...(defaultListed
      ? []
      : [
          `The default ${defaultModel} is not in this list; ${IMAGEGEN_TOOL} and ${IMAGEEDIT_TOOL} still send it when model is omitted.`,
        ]),
    `This list comes from the API on this call and is the key's current view. ${NOT_CAPABILITIES}`,
    `${PASSTHROUGH} Use query to search every listed ID, for example for an svg_model author, or model to check one ID.`,
  ].join("\n")
}
