// Providers known to handle "untyped object" tool parameters poorly. When the
// active provider is one of these, the surface returns the flat tool list
// (no family compression) so tool-calling accuracy doesn't regress.
//
// Add a provider here when its function-calling implementation rejects or
// misroutes calls against a parameter shape like `{ args: { type: 'object' } }`
// without a structural schema. Remove when the provider's behavior matures.
//
// Empirical basis (as of Nov 2026):
//   - Gemini's tool-calling rejects untyped object params at non-trivial
//     rates; the response is a model-side error, not a router-recoverable one.
//   - Anthropic + OpenAI handle the same shape reliably.
//   - SambaNova / Cerebras / Groq are OpenAI-compatible at the protocol
//     level so inherit OpenAI's behavior.

export const STRICT_TOOL_SCHEMA_PROVIDERS: ReadonlySet<string> = new Set([
  'gemini',
])

export const isStrictProvider = (providerName: string | undefined): boolean =>
  providerName !== undefined && STRICT_TOOL_SCHEMA_PROVIDERS.has(providerName)

// Resolve which provider will serve a model reference, given the curated
// catalog. Returns undefined if the catalog doesn't know — in which case
// callers should treat as "potentially strict" and skip compression
// (conservative default).
//
// Accepts both prefixed (`gemini:gemini-2.5-flash`) and bare (`gpt-4o`).
// Prefixed always wins. Bare scans the catalog for an exact match.
export const inferProviderFromModelRef = (
  modelRef: string,
  catalog: Record<string, ReadonlyArray<{ readonly id: string }>>,
): string | undefined => {
  const colon = modelRef.indexOf(':')
  if (colon > 0) return modelRef.slice(0, colon)
  for (const [provider, list] of Object.entries(catalog)) {
    if (list.some(m => m.id === modelRef)) return provider
  }
  return undefined
}
