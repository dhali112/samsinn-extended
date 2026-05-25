// ============================================================================
// OpenAI-compatible provider — Groq, Cerebras, OpenRouter, Mistral, SambaNova.
//
// All five providers speak the OpenAI Chat Completions API. This adapter
// converts samsinn's ChatRequest/ChatResponse to/from OpenAI format, handles
// incremental tool-call accumulation in streaming, and maps HTTP failure
// modes to typed CloudProviderError variants (rate_limit, quota, auth,
// provider_down) so the router can decide whether to fall through.
//
// Behaviour specific to individual providers (e.g. OpenRouter's ":free"
// model slugs, DeepSeek R1's <think>...</think> content stream) is handled
// here rather than requiring per-provider subclasses.
// ============================================================================

import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk } from '../core/types/llm.ts'
import type { NativeToolCall } from '../core/types/tool.ts'
import type { LimitMetrics } from '../core/limit-metrics.ts'
import { createCloudProviderError } from './errors.ts'
import { mapHttpError } from './openai-compatible-errors.ts'
import { type OAIMessage, buildOAIBody } from './openai-compatible-wire.ts'
import { fetchWithTimeout } from '../core/fetch-utils.ts'
import { normalizeModelId, expandAnthropicAliases } from './models/normalize.ts'

const DEFAULT_CHAT_TIMEOUT_MS = 300_000
const DEFAULT_MODELS_TIMEOUT_MS = 10_000
// Two-tier idle handling: warn the user at warnMs (emits a slowWarning
// StreamChunk, does NOT abort) so they know the provider is slow and
// can intervene with the existing Stop button; hard-abort at hardMs so
// a genuinely dead stream still eventually fails over to the next
// provider via the router. Pre-PR-2 there was a single 60s threshold
// that silently aborted with no user-visible explanation.
const DEFAULT_STREAM_SLOW_WARN_MS = 30_000
const DEFAULT_STREAM_HARD_ABORT_MS = 180_000
// Hard cap on the SSE re-assembly buffer. Frames are normally a few KB; a
// runaway provider sending one giant unterminated `data:` line would otherwise
// grow this buffer without bound. 10 MB is well above any legitimate frame
// and small enough to fail loud rather than OOM the process.
const MAX_SSE_BUFFER_BYTES = 10 * 1024 * 1024

// === Config ===

export interface OpenAICompatConfig {
  readonly name: string                  // logical provider name, e.g. "groq"
  // Resolved lazily so runtime URL changes (PUT /api/providers/:name with
  // baseUrl) take effect on the next request without recreating the provider
  // or its gateway. Mirrors `getApiKey`.
  readonly getBaseUrl: () => string
  // Resolved lazily so runtime key changes take effect without restart.
  readonly getApiKey: () => string
  // Optional: replace the default `Authorization: Bearer <key>` auth with
  // provider-specific headers. Anthropic, for example, rejects Bearer and
  // requires `x-api-key` + `anthropic-version`. Returning an empty object is
  // allowed (no auth headers at all).
  readonly authHeaders?: () => Record<string, string>
  // Optional extra non-auth headers (no current callers — kept for future).
  readonly extraHeaders?: () => Record<string, string>
  readonly chatTimeoutMs?: number
  readonly modelsTimeoutMs?: number
  // Two-tier idle thresholds. `warn` emits a slowWarning chunk and
  // continues waiting; `hard` aborts the stream so the router can
  // fail over. Tests can shorten both.
  readonly streamSlowWarnMs?: number
  readonly streamHardAbortMs?: number
  // Optional process-global counters; when present, SSE-buffer overflow is
  // tracked. Tests omit.
  readonly limitMetrics?: LimitMetrics
}

// === OpenAI wire types ===

// Anthropic's OpenAI-compat endpoint accepts an array of content parts on a
// message, where each part can carry a `cache_control` marker. We only emit
// this shape when talking to Anthropic; other providers continue to get a
// plain string in `content`.

interface OAIChatResponse {
  id?: string
  model?: string
  choices: ReadonlyArray<{
    message: OAIMessage
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    // Anthropic-specific. Passed through when present.
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    // OpenAI-standard cache hit count (Gemini's OAI-compat shim emits this
    // for implicit prompt caching on Gemini 2.5 family). When set on a
    // response, the listed token count was billed at the cached rate.
    prompt_tokens_details?: {
      cached_tokens?: number
    }
  }
}

interface OAIStreamChunk {
  choices?: ReadonlyArray<{
    delta?: {
      content?: string
      // Reasoning/thinking channel emitted by some OAI-compat providers
      // (Kimi/Moonshot, DeepSeek-R1, Qwen QwQ, etc.) BEFORE the final
      // content. Routed into Samsinn's thinking pane via StreamChunk.thinking;
      // never round-tripped into outbound history.
      reasoning_content?: string
      // Same channel under an alternate field name (OpenAI's o-series
      // exposes it as `reasoning` in some shapes). Treat identically.
      reasoning?: string
      tool_calls?: ReadonlyArray<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
  }
}

interface OAIModelsResponse {
  data?: ReadonlyArray<{ id: string }>
}

// === Error mapping ===
// HTTP-status → CloudProviderError classification moved to
// ./openai-compatible-errors.ts (audit Finding 2.3.2 — partial split).
// Imported at the top of this file. Not re-exported: no caller outside
// this module needed it (knip-confirmed during item #4 triage).

// === Cache-marker helper ===
// Spread-clones the array AND its last entry, attaches `cache_control:
// ephemeral` to the cloned tail entry, and returns a new array. Pure and
// non-mutating — safe to use on a `ChatRequest.tools` reference shared with
// the router's failover path. Aliasing risk is the load-bearing concern
// here: an in-place mutation would leak the marker into a subsequent
// failover call to a non-Anthropic provider whose OpenAI-compat shim may
// reject the unknown field.

// Some providers (DeepSeek R1 via OpenRouter) emit chain-of-thought inside
// <think>...</think> in the content stream, without a dedicated "thinking"
// field. We pull those out into StreamChunk.thinking to keep samsinn's
// thinking-indicator UX working.
const splitThinkAndContent = (raw: string): { thinking: string; content: string } => {
  let thinking = ''
  let content = ''
  let cursor = 0
  const openRe = /<think>/gi
  while (cursor < raw.length) {
    openRe.lastIndex = cursor
    const open = openRe.exec(raw)
    if (!open) {
      content += raw.slice(cursor)
      break
    }
    content += raw.slice(cursor, open.index)
    const closeIdx = raw.indexOf('</think>', open.index + open[0].length)
    if (closeIdx === -1) {
      thinking += raw.slice(open.index + open[0].length)
      break
    }
    thinking += raw.slice(open.index + open[0].length, closeIdx)
    cursor = closeIdx + '</think>'.length
  }
  return { thinking, content }
}

// === Factory ===

export const createOpenAICompatibleProvider = (config: OpenAICompatConfig): LLMProvider => {
  const chatTimeoutMs = config.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
  const modelsTimeoutMs = config.modelsTimeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS
  const streamSlowWarnMs = config.streamSlowWarnMs ?? DEFAULT_STREAM_SLOW_WARN_MS
  const streamHardAbortMs = config.streamHardAbortMs ?? DEFAULT_STREAM_HARD_ABORT_MS

  // Anthropic ships dated canonical ids in /models (`claude-haiku-4-5-20251001`)
  // but the curated UI list and agents carry the bare alias (`claude-haiku-4-5`).
  // We publish BOTH forms in `models()` so the router's exact-match filter
  // accepts the alias, then translate alias→canonical at request time so the
  // wire payload uses the id Anthropic's API actually accepts. Empty until
  // the first models() resolves; chat()/stream() before that point fall
  // through identity (the request was always going to fail or hit a different
  // provider anyway).
  let anthropicAliasMap: ReadonlyMap<string, string> = new Map()

  const resolveWireModel = (model: string): string => {
    if (config.name !== 'anthropic') return model
    return anthropicAliasMap.get(model) ?? model
  }

  const headers = (): Record<string, string> => {
    const key = config.getApiKey()
    const auth = config.authHeaders
      ? config.authHeaders()
      : { Authorization: `Bearer ${key}` }
    return {
      'Content-Type': 'application/json',
      ...auth,
      ...(config.extraHeaders?.() ?? {}),
    }
  }

  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    const startMs = performance.now()
    const wireRequest = { ...request, model: resolveWireModel(request.model) }
    const body = buildOAIBody(wireRequest, false, config.name)

    const response = await fetchWithTimeout(
      `${config.getBaseUrl()}/chat/completions`,
      { method: 'POST', headers: headers(), body: JSON.stringify(body) },
      chatTimeoutMs,
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw mapHttpError(config.name, response.status, text, response.headers.get('retry-after'))
    }

    const data = (await response.json()) as OAIChatResponse
    const choice = data.choices?.[0]
    if (!choice) {
      throw createCloudProviderError({
        code: 'provider_down', provider: config.name,
        message: `${config.name}: empty choices array`,
        status: response.status,
      })
    }

    // Anthropic's OAI-compat response returns content as either a plain
    // string or an array of content parts. Normalise to string.
    const rawContentRaw = choice.message.content
    const rawContent: string = typeof rawContentRaw === 'string'
      ? rawContentRaw
      : Array.isArray(rawContentRaw)
        ? rawContentRaw.filter(p => p.type === 'text').map(p => p.text).join('')
        : ''
    const { thinking, content } = splitThinkAndContent(rawContent)
    void thinking // thinking in non-streaming is discarded — samsinn only surfaces it during streaming
    // Same disposition for the native reasoning channel — read so an
    // optional future caller can wire it through, discarded here.
    void choice.message.reasoning_content
    void choice.message.reasoning

    const toolCalls: NativeToolCall[] | undefined = choice.message.tool_calls?.length
      ? choice.message.tool_calls.map(tc => ({
          function: {
            name: tc.function.name,
            arguments: parseArgs(tc.function.arguments, config.name, tc.function.name),
          },
        }))
      : undefined

    const generationMs = Math.round(performance.now() - startMs)
    const cacheCreation = data.usage?.cache_creation_input_tokens
    // cacheRead is filled by Anthropic's `cache_read_input_tokens` OR the
    // OpenAI-standard `prompt_tokens_details.cached_tokens` (Gemini emits
    // this for implicit caching on the 2.5 family). Take whichever is
    // present so a single `cacheRead` field stays the cross-provider truth.
    const cacheRead = data.usage?.cache_read_input_tokens
      ?? data.usage?.prompt_tokens_details?.cached_tokens
    return {
      content,
      generationMs,
      tokensUsed: {
        prompt: data.usage?.prompt_tokens ?? 0,
        completion: data.usage?.completion_tokens ?? 0,
        ...(cacheCreation !== undefined ? { cacheCreation } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
      },
      toolCalls,
    }
  }

  const stream = async function* (request: ChatRequest, externalSignal?: AbortSignal): AsyncIterable<StreamChunk> {
    const wireRequest = { ...request, model: resolveWireModel(request.model) }
    const body = buildOAIBody(wireRequest, true, config.name)

    const controller = new AbortController()
    // Hard-abort timer — fires only if the stream is genuinely dead for
    // streamHardAbortMs. Reset on every chunk arrival. The earlier warn
    // tier (raced against reader.read below) handles user notification.
    let hardAbortTimer = setTimeout(() => controller.abort(), streamHardAbortMs)
    if (externalSignal) {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const response = await fetch(`${config.getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      clearTimeout(hardAbortTimer)
      const text = await response.text().catch(() => '')
      throw mapHttpError(config.name, response.status, text, response.headers.get('retry-after'))
    }

    const reader = response.body?.getReader()
    if (!reader) {
      clearTimeout(hardAbortTimer)
      throw createCloudProviderError({
        code: 'provider_down', provider: config.name,
        message: `${config.name} stream: no response body`,
      })
    }

    const decoder = new TextDecoder()
    let buffer = ''
    // Accumulators for incremental tool calls (OpenAI streams arguments as fragments).
    const toolAccum: Array<{ id?: string; name: string; argsBuffer: string }> = []
    // Accumulator for <think> block spanning chunks.
    let inThink = false
    let thinkCarry = ''

    const flushDelta = (delta: string): StreamChunk | null => {
      if (!delta) return null
      let thinkingOut = ''
      let contentOut = ''
      let cursor = 0
      while (cursor < delta.length) {
        if (inThink) {
          const close = delta.indexOf('</think>', cursor)
          if (close === -1) {
            thinkingOut += delta.slice(cursor)
            break
          }
          thinkingOut += delta.slice(cursor, close)
          inThink = false
          cursor = close + '</think>'.length
        } else {
          const combined = thinkCarry + delta.slice(cursor)
          const openIdx = combined.indexOf('<think>')
          if (openIdx === -1) {
            // Possible partial "<think" at tail — keep up to 6 chars as carry.
            const safe = combined.length - 6
            if (safe > 0) {
              contentOut += combined.slice(0, safe)
              thinkCarry = combined.slice(safe)
            } else {
              thinkCarry = combined
            }
            break
          }
          contentOut += combined.slice(0, openIdx)
          thinkCarry = ''
          inThink = true
          cursor = delta.length - (combined.length - (openIdx + '<think>'.length))
        }
      }
      if (!thinkingOut && !contentOut) return null
      const out: StreamChunk = { delta: contentOut, done: false }
      if (thinkingOut) (out as { thinking?: string }).thinking = thinkingOut
      return out
    }

    // Accumulators for final-chunk metadata (finish_reason may arrive before
    // [DONE]; usage typically arrives AFTER finish_reason but BEFORE [DONE]).
    let finishSeen = false
    let usageTokens: { prompt: number; completion: number; cacheCreation?: number; cacheRead?: number } | undefined

    const emitFinal = (): StreamChunk => {
      const toolCalls: NativeToolCall[] | undefined = toolAccum.length
        ? toolAccum.map(t => ({
            function: { name: t.name, arguments: parseArgs(t.argsBuffer, config.name, t.name) },
          }))
        : undefined
      const chunk: StreamChunk = {
        delta: '', done: true,
        ...(toolCalls ? { toolCalls } : {}),
        ...(usageTokens ? { tokensUsed: usageTokens } : {}),
      }
      return chunk
    }

    // Race read vs warn timer. The Web Streams API forbids overlapping
    // .read() calls on a locked reader, so we keep ONE pending read across
    // a race-loss and re-await it on the next iteration. `warnEmitted`
    // resets after each real chunk so a subsequent gap can warn again
    // (e.g. provider stalls, recovers, stalls).
    let pendingRead: Promise<{ done: boolean; value: Uint8Array | undefined }> | null = null
    let warnEmitted = false
    let lastChunkAt = Date.now()

    try {
      while (true) {
        clearTimeout(hardAbortTimer)
        hardAbortTimer = setTimeout(() => controller.abort(), streamHardAbortMs)
        if (!pendingRead) pendingRead = reader.read()

        type ReadResult = { done: boolean; value: Uint8Array | undefined }
        let raceResult: ReadResult | 'warn'
        if (!warnEmitted) {
          const sinceLast = Date.now() - lastChunkAt
          const remainingToWarn = Math.max(0, streamSlowWarnMs - sinceLast)
          raceResult = await Promise.race([
            pendingRead,
            new Promise<'warn'>(r => setTimeout(() => r('warn'), remainingToWarn)),
          ])
        } else {
          raceResult = await pendingRead
        }

        if (raceResult === 'warn') {
          warnEmitted = true
          yield {
            delta: '', done: false,
            slowWarning: { elapsedMs: Date.now() - lastChunkAt, provider: config.name },
          }
          continue  // pendingRead still pending — loop awaits it again
        }

        // Real read settled.
        pendingRead = null
        const { done, value } = raceResult
        if (done) break
        lastChunkAt = Date.now()
        warnEmitted = false
        buffer += decoder.decode(value, { stream: true })

        // Bound the unframed buffer. Treat as a recoverable provider issue
        // (fallbackable) so the router can try the next provider.
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          config.limitMetrics?.inc('sseBufferExceeded')
          throw createCloudProviderError({
            code: 'provider_down',
            provider: config.name,
            message: `${config.name} stream: buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a frame boundary`,
          })
        }

        // SSE: split on double-newline frames.
        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          sep = buffer.indexOf('\n\n')

          // Each frame may have multiple "data:" lines.
          const dataLines = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
          for (const payload of dataLines) {
            if (payload === '[DONE]') {
              if (thinkCarry) { yield { delta: thinkCarry, done: false }; thinkCarry = '' }
              yield emitFinal()
              return
            }
            let parsed: OAIStreamChunk
            try { parsed = JSON.parse(payload) } catch { continue }

            // Final usage frame (OpenAI with include_usage: true; Groq,
            // Cerebras follow the same convention). The frame carries an
            // empty choices array + a `usage` field.
            if (parsed.usage && (parsed.usage.prompt_tokens !== undefined || parsed.usage.completion_tokens !== undefined)) {
              const cacheReadCount = parsed.usage.cache_read_input_tokens
                ?? parsed.usage.prompt_tokens_details?.cached_tokens
              usageTokens = {
                prompt: parsed.usage.prompt_tokens ?? 0,
                completion: parsed.usage.completion_tokens ?? 0,
                ...(parsed.usage.cache_creation_input_tokens !== undefined ? { cacheCreation: parsed.usage.cache_creation_input_tokens } : {}),
                ...(cacheReadCount !== undefined ? { cacheRead: cacheReadCount } : {}),
              }
            }

            const choice = parsed.choices?.[0]
            if (!choice) continue

            // Native reasoning channel (Kimi, DeepSeek, etc.) — surface as
            // thinking BEFORE content for this frame so the UI sees reasoning
            // arrive in its natural order. The `<think>` text-embedded parser
            // is disjoint from this field, so both can coexist (e.g. DeepSeek
            // historically emitted both). Both routes feed the same channel.
            const deltaReasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? ''
            if (deltaReasoning) {
              yield { delta: '', thinking: deltaReasoning, done: false }
            }

            const deltaContent = choice.delta?.content ?? ''
            if (deltaContent) {
              const chunk = flushDelta(deltaContent)
              if (chunk) yield chunk
            }

            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                // Accumulator slot resolution:
                //   1. Explicit `index` (OpenAI / Groq / Cerebras spec).
                //   2. Existing slot with matching `id` (some providers).
                //   3. No index, no id (Gemini via OpenAI-compat): stay on the
                //      last slot unless its buffer is already a complete JSON
                //      object AND the incoming fragment starts a fresh one —
                //      which indicates a distinct parallel tool call. Without
                //      this split, two `web_search` calls get concatenated into
                //      `{...}{...}` which fails JSON.parse.
                let idx: number
                if (typeof tc.index === 'number') {
                  idx = tc.index
                } else if (tc.id) {
                  const existing = toolAccum.findIndex(s => s?.id === tc.id)
                  idx = existing >= 0 ? existing : toolAccum.length
                } else {
                  idx = Math.max(0, toolAccum.length - 1)
                  const incomingArgs = tc.function?.arguments?.trim() ?? ''
                  const current = toolAccum[idx]?.argsBuffer.trim() ?? ''
                  if (incomingArgs.startsWith('{') && current.length > 0) {
                    try {
                      JSON.parse(current)
                      // Current slot is a complete JSON object; incoming starts
                      // a new object → it's a new tool call.
                      idx = toolAccum.length
                    } catch { /* still mid-object, keep accumulating */ }
                  }
                }
                if (!toolAccum[idx]) toolAccum[idx] = { name: '', argsBuffer: '' }
                const acc = toolAccum[idx]!
                if (tc.id) acc.id = tc.id
                if (tc.function?.name) acc.name = tc.function.name
                if (tc.function?.arguments) acc.argsBuffer += tc.function.arguments
              }
            }

            if (choice.finish_reason) {
              // Mark finish but don't emit yet — wait one more frame in case
              // usage arrives (it typically does on a subsequent SSE event).
              finishSeen = true
            }
          }
        }
      }
      // Reader closed. Emit final chunk with whatever we've accumulated.
      if (thinkCarry) yield { delta: thinkCarry, done: false }
      yield emitFinal()
      void finishSeen  // value consumed by the loop logic above
    } finally {
      clearTimeout(hardAbortTimer)
      reader.releaseLock()
    }
  }

  const models = async (): Promise<string[]> => {
    const response = await fetchWithTimeout(
      `${config.getBaseUrl()}/models`,
      { headers: headers() },
      modelsTimeoutMs,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw mapHttpError(config.name, response.status, text, response.headers.get('retry-after'))
    }
    const data = (await response.json()) as OAIModelsResponse
    // Provider-specific id normalization (e.g. strip Gemini's "models/" prefix
    // so the catalog matches user-facing names). Single place for these quirks:
    // src/llm/models/normalize.ts. See that file for the full bug story.
    const ids = (data.data ?? []).map(m => normalizeModelId(config.name, m.id))
    if (config.name === 'anthropic') {
      const { expanded, aliasMap } = expandAnthropicAliases(ids)
      anthropicAliasMap = aliasMap
      return [...expanded]
    }
    return ids
  }

  return { chat, stream, models }
}

// OpenAI tool_call.function.arguments is a JSON string. Ollama passes an object.
// samsinn's NativeToolCall expects an object. Malformed args are surfaced as
// a warning (provider + tool + raw snippet) so silent-zero-arg tool calls
// don't vanish into the void; the caller still gets `{}` to keep the tool
// loop going.
const parseArgs = (raw: string, provider?: string, toolName?: string): Record<string, unknown> => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    console.warn(`[${provider ?? 'cloud'}] tool-call args for ${toolName ?? '<unknown>'} parsed to non-object; using {}. raw=${raw.slice(0, 200)}`)
    return {}
  } catch (err) {
    console.warn(`[${provider ?? 'cloud'}] tool-call args for ${toolName ?? '<unknown>'} malformed JSON; using {}. raw=${raw.slice(0, 200)} err=${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}
