// ============================================================================
// Multimodal model capability detection.
//
// V1: hardcoded allowlist of model id substrings known to accept image
// content. Conservative default: unknown models are treated as text-only.
// Models that aren't on the list still work — the context-builder swaps
// images for a text placeholder so the conversation continues sensibly.
//
// Adding a model: append to MULTIMODAL_MODEL_SUBSTRINGS. Each entry matches
// case-insensitively as a substring of the model id (after any provider
// prefix is stripped). Specific enough to avoid false-positives (e.g.
// 'gpt-4' alone would match 'gpt-4-turbo' which is not multimodal; we use
// 'gpt-4o' instead).
//
// Long-term: provider adapters declare image capability per model based on
// a probe or static catalogue (see src/llm/models/). Until then, this list
// is the source of truth.
// ============================================================================

const MULTIMODAL_MODEL_SUBSTRINGS: ReadonlyArray<string> = [
  // OpenAI
  'gpt-4o',
  'gpt-4-vision',
  'gpt-5',          // gpt-5.4, gpt-5-pro, etc. all multimodal
  // Anthropic
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'claude-3-5-',
  'claude-3.5',
  'claude-sonnet-4',
  'claude-opus-4',
  'claude-haiku-4',
  // Google
  'gemini-1.5',
  'gemini-2',
  'gemini-pro-vision',
  'gemini-flash',
  // Meta (multimodal Llama variants)
  'llama-3.2-vision',
  'llama-4',
  // Mistral
  'pixtral',
  // Qwen
  'qwen-vl',
  'qwen2-vl',
  'qwen2.5-vl',
]

const stripProviderPrefix = (model: string): string => {
  const colonIdx = model.indexOf(':')
  return colonIdx >= 0 ? model.slice(colonIdx + 1) : model
}

export const modelSupportsImages = (modelId: string): boolean => {
  if (!modelId) return false
  const id = stripProviderPrefix(modelId).toLowerCase()
  for (const needle of MULTIMODAL_MODEL_SUBSTRINGS) {
    if (id.includes(needle.toLowerCase())) return true
  }
  return false
}

// Text placeholder used when a message has image attachments but the
// receiving model is not multimodal. The placeholder gives the model
// enough information to ask the user for a description.
export const imagePlaceholder = (att: { width: number; height: number; mimeType: string; source?: string }): string => {
  const src = att.source ? ` (${att.source})` : ''
  return `[image attached${src}: ${att.mimeType} ${att.width}×${att.height} — your model cannot view images directly; ask the user to describe what's in the screenshot]`
}
