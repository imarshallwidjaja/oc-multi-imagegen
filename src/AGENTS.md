# Plugin source instructions

- Treat the plugin/tool identity, `imagegen` arguments, supported sizes, and `{ out, versioned }` result metadata as public contracts. Internal helpers can change in place. Update the README's "Use" and "Current limits" sections when documented behavior changes.
- Keep argument and reference-image validation before `callViaCodexImages`; invalid inputs must fail before quota-consuming requests. Propagate generation and save failures instead of returning a success-shaped result.
- The implemented backend is ChatGPT OAuth through Codex. Introduce provider abstractions alongside a concrete second implementation.
