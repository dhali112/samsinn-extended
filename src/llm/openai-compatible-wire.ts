// ============================================================================
// OpenAI-compatible wire-format mapping.
//
// Extracted from openai-compatible.ts (audit Finding 2.3.2 — next seam
// after the error-mapping extraction in commit ab97ca3). Holds the
// ChatRequest ↔ OAI body translation, model-family detection (gpt-5/o-
// series quirks), multimodal content-part building, and the Anthropic
// cache-marker helper. Pure functions; no I/O.
//
// Why a sibling file (not subdir): keeps import-path churn local —
// only the parent openai-compatible.ts imports from here.
// ============================================================================

import type { ChatRequest } from '../core/types/llm.ts'

// === OpenAI wire types ===

// Anthropic's OpenAI-compat endpoint accepts an array of content parts on a
// message, where each part can carry a `cache_control` marker. We only emit
// this shape when talking to Anthropic; other providers continue to get a
// plain string in `content`.
export interface OAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' }
  cache_control?: { type: 'ephemeral' }
}

export interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ReadonlyArray<OAIContentPart> | null
  // Reasoning channel on non-streamed responses (Kimi/Moonshot, DeepSeek-R1
  // and others). Read on inbound; NEVER written on outbound — keeping
  // reasoning out of round-tripped history is structurally enforced by
  // ChatRequest.messages[].content being `string`, so toOAIMessages can't
  // surface it.
  reasoning_content?: string
  reasoning?: string
  tool_calls?: ReadonlyArray<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

// === Cache-marker helper ===
// Spread-clones the array AND its last entry, attaches `cache_control:
// ephemeral` to the cloned tail entry, and returns a new array. Pure and
// non-mutating — safe to use on a `ChatRequest.tools` reference shared with
// the router's failover path. Aliasing risk is the load-bearing concern
// here: an in-place mutation would leak the marker into a subsequent
// failover call to a non-Anthropic provider whose OpenAI-compat shim may
// reject the unknown field.
export const markLastCacheable = <T>(arr: ReadonlyArray<T>): T[] => {
  if (arr.length === 0) return []
  const out = [...arr]
  const tail = { ...out[out.length - 1] } as Record<string, unknown>
  tail.cache_control = { type: 'ephemeral' }
  out[out.length - 1] = tail as unknown as T
  return out
}

// === Request conversion ===

// Moonshot/Kimi rejects assistant messages with empty `content` (400
// "must not be empty"), while OpenAI/Anthropic/Gemini accept them
// (legitimate for tool-call-only turns or thinking-model responses that
// hit max_tokens during reasoning). Substitute a single space at the
// wire layer so the history round-trips without changing internal state.
// Applied to all providers — every OAI-compat target accepts " ".
export const safeAssistantContent = (m: { role: string; content: string }): string =>
  m.role === 'assistant' && (!m.content || m.content.length === 0) ? ' ' : m.content

// When a message carries images (V1 multimodal), build content parts.
// Returns null if the message has no images, signaling the caller to use
// the plain-string path. Only fires for user messages — assistant + system
// stay text-only (assistant images aren't part of the OAI flow we use;
// system prompts don't carry images).
export const messageContentWithImages = (
  m: ChatRequest['messages'][number],
): ReadonlyArray<OAIContentPart> | null => {
  if (!m.images || m.images.length === 0) return null
  if (m.role !== 'user') return null
  const parts: OAIContentPart[] = []
  if (m.content && m.content.length > 0) {
    parts.push({ type: 'text', text: m.content })
  }
  for (const img of m.images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'auto' } })
  }
  return parts
}

export const toOAIMessages = (request: ChatRequest, providerName: string): OAIMessage[] => {
  // Anthropic path: if systemBlocks are provided, emit the system message as
  // an array of content parts with `cache_control: ephemeral` on the last
  // cacheable block. Anthropic's caching is triggered by the marker and caches
  // every token from message start up to (and including) that marker.
  if (providerName === 'anthropic' && request.systemBlocks && request.systemBlocks.length > 0) {
    const out: OAIMessage[] = []
    const systemParts: OAIContentPart[] = []
    let lastCacheableIdx = -1
    for (let i = 0; i < request.systemBlocks.length; i++) {
      if (request.systemBlocks[i]!.cacheable) lastCacheableIdx = i
    }
    for (let i = 0; i < request.systemBlocks.length; i++) {
      const block = request.systemBlocks[i]!
      if (!block.text) continue
      const part: OAIContentPart = { type: 'text', text: block.text }
      if (i === lastCacheableIdx) part.cache_control = { type: 'ephemeral' }
      systemParts.push(part)
    }
    if (systemParts.length > 0) {
      out.push({ role: 'system', content: systemParts })
    }
    for (const m of request.messages) {
      if (m.role === 'system') continue
      const withImages = messageContentWithImages(m)
      if (withImages) out.push({ role: m.role, content: withImages })
      else out.push({ role: m.role, content: safeAssistantContent(m) })
    }
    return out
  }
  return request.messages.map(m => {
    const withImages = messageContentWithImages(m)
    if (withImages) return { role: m.role, content: withImages }
    return { role: m.role, content: safeAssistantContent(m) }
  })
}

// === Model-family detection ===

export const stripProviderPrefix = (model: string): string => {
  const idx = model.indexOf(':')
  return idx >= 0 ? model.slice(idx + 1) : model
}

// gpt-5.x and o-series (o1, o2, …): use max_completion_tokens (not
// max_tokens) and reject temperature in the request body. These two
// quirks ship together for the same model family.
export const isNewOpenAIFamily = (model: string): boolean => {
  const id = stripProviderPrefix(model).toLowerCase()
  return id.startsWith('gpt-5') || /^o[1-9]/.test(id)
}

export const usesMaxCompletionTokens = isNewOpenAIFamily
export const rejectsTemperature = isNewOpenAIFamily

// === Body builder ===

export const buildOAIBody = (request: ChatRequest, stream: boolean, providerName: string): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOAIMessages(request, providerName),
    stream,
  }
  // Ask providers to include a final usage frame (supported by OpenAI, Groq,
  // Cerebras, OpenRouter). Providers that don't support it ignore the flag.
  if (stream) body.stream_options = { include_usage: true }
  if (request.temperature !== undefined && !rejectsTemperature(request.model)) {
    body.temperature = request.temperature
  }
  // Seed is emitted to every OpenAI-shape provider. Providers that support it
  // (OpenAI, Groq, Cerebras, OpenRouter, Mistral, SambaNova) honor it; those
  // that don't (Anthropic, Gemini) silently discard unknown fields.
  if (request.seed !== undefined) body.seed = request.seed
  if (request.maxTokens !== undefined) {
    if (usesMaxCompletionTokens(request.model)) {
      body.max_completion_tokens = request.maxTokens
    } else {
      body.max_tokens = request.maxTokens
    }
  }
  if (request.jsonMode) body.response_format = { type: 'json_object' }
  if (request.tools && request.tools.length > 0) {
    // Anthropic-only: attach `cache_control: ephemeral` (top-level on the
    // last tool entry, NOT nested inside `function`). Anthropic caches
    // tools and system on separate axes, so this marker is independent of
    // the system-block marker — both are needed to cache both prefixes.
    body.tools = providerName === 'anthropic'
      ? markLastCacheable(request.tools)
      : request.tools
  }
  if (request.toolChoice !== undefined && request.tools && request.tools.length > 0) {
    if (request.toolChoice === 'auto' || request.toolChoice === 'required') {
      body.tool_choice = request.toolChoice
    } else {
      body.tool_choice = { type: 'function', function: { name: request.toolChoice.name } }
    }
  }
  return body
}
