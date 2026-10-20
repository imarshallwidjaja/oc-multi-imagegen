import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const SKILL_NAME = "oc-multi-imagegen"

// Both src/ and the bundled dist/ sit directly below the package root, so this is <package>/skills in a
// checkout and in an installed package. OpenCode 1 resolves relative skill paths against the project, so the
// path handed to it must be absolute.
export const SKILLS_DIRECTORY = fileURLToPath(new URL("../skills", import.meta.url))
export const SKILL_FILE = path.join(SKILLS_DIRECTORY, SKILL_NAME, "SKILL.md")

export type PackagedSkill = { name: string; description: string; content: string; path: string }

// The frontmatter holds `name` and `description` as one JSON string each, which is also valid YAML, so
// OpenCode 1's loader and this parser read the same metadata without a YAML dependency.
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/
const FIELD = /^(name|description): (".*")$/

function invalid(file: string, reason: string): Error {
  return new Error(`The packaged skill ${file} is invalid: ${reason}. Reinstall oc-multi-imagegen.`)
}

// Reads the skill this package ships. A missing or malformed file throws, so a broken install reports itself
// when the plugin loads instead of registering an empty skill.
export async function loadPackagedSkill(file = SKILL_FILE): Promise<PackagedSkill> {
  let text: string
  try {
    text = (await readFile(file, "utf-8")).replace(/\r\n/g, "\n")
  } catch (cause) {
    throw new Error(`The packaged skill ${file} could not be read. Reinstall oc-multi-imagegen.`, { cause })
  }
  const match = FRONTMATTER.exec(text)
  if (!match) throw invalid(file, "it has no frontmatter")

  const fields: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const field = FIELD.exec(line)
    if (!field) throw invalid(file, `unsupported frontmatter line "${line}"`)
    if (field[1] in fields) throw invalid(file, `${field[1]} is set twice`)
    try {
      fields[field[1]] = JSON.parse(field[2])
    } catch {
      throw invalid(file, `${field[1]} is not a JSON string`)
    }
  }
  const { name, description } = fields
  if (name !== SKILL_NAME) throw invalid(file, `name must be "${SKILL_NAME}"`)
  if (!description?.trim()) throw invalid(file, "description is missing")
  const content = text.slice(match[0].length).trim()
  if (!content) throw invalid(file, "the body is empty")
  return { name, description, content, path: file }
}
