// ============================================================================
// HTTP error mapping for OpenAI-compatible providers.
//
// Extracted from openai-compatible.ts (audit Finding 2.3.2 — partial split).
// Pure function: given (provider name, HTTP status, body, retry-after
// header), classify into one of our typed CloudProviderError codes.
//
// Lives in a sibling file (not a subdirectory) to minimize import-path
// churn — the only ts file that imported `mapHttpError` is the parent
// openai-compatible.ts, which now re-imports it from here.
//
// Why partial split? The streaming parser, tool-call accumulator, and
// think-block parser share enough state that extracting them in one
// session is too risky (audit-flagged as the highest-risk Tier-2 item).
// Error mapping is the most self-contained piece — pure function with
// only two external deps (parseRetryAfterMs + createCloudProviderError,
// both in errors.ts).
//
// Classification rules:
//   401/403 with quota-ish body  → quota
//   401/403 otherwise            → auth
//   429                          → rate_limit
//   5xx                          → provider_down (router falls through)
//   404 / "model_not_found"      → provider_down (per-model issue, not
//                                   a permanent config error — router
//                                   falls through for bare model names)
//   context_length_exceeded      → provider_down (same rationale)
//   other 4xx                    → bad_request (permanent, do NOT fall
//                                   through — typically the operator's
//                                   request is malformed)
// ============================================================================

import { createCloudProviderError, parseRetryAfterMs } from './errors.ts'

export const mapHttpError = (
  providerName: string,
  status: number,
  body: string,
  retryAfterHeader: string | null,
): Error => {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader)
  const snippet = body.slice(0, 300)

  if (status === 401 || status === 403) {
    // Many providers return 429/403 for quota; distinguish via body text.
    const bodyLower = body.toLowerCase()
    if (bodyLower.includes('quota') || bodyLower.includes('exceeded') || bodyLower.includes('limit')) {
      return createCloudProviderError({
        code: 'quota', provider: providerName, message: `${providerName} quota exceeded: ${snippet}`,
        status, retryAfterMs,
      })
    }
    return createCloudProviderError({
      code: 'auth', provider: providerName, message: `${providerName} auth error ${status}: ${snippet}`,
      status,
    })
  }
  if (status === 429) {
    return createCloudProviderError({
      code: 'rate_limit', provider: providerName, message: `${providerName} rate-limited: ${snippet}`,
      status, retryAfterMs,
    })
  }
  if (status >= 500) {
    return createCloudProviderError({
      code: 'provider_down', provider: providerName, message: `${providerName} server error ${status}: ${snippet}`,
      status, retryAfterMs,
    })
  }
  // Per-model limitations that aren't permanent config errors — classify as
  // provider_down so the router falls through for bare model names. Prefix-
  // pinned models still throw because the router doesn't fall back on pins.
  //   - context_length_exceeded: request too long for this model's window
  //   - model_not_found: provider's /models listed it but the account can't
  //     actually use it (common on Cerebras free-tier for premium models)
  const bodyLowerFull = body.toLowerCase()
  const isContextIssue = bodyLowerFull.includes('context_length_exceeded') || bodyLowerFull.includes('maximum context length')
  const isModelIssue = status === 404 || bodyLowerFull.includes('model_not_found') || bodyLowerFull.includes('does not exist')
  if (isContextIssue) {
    return createCloudProviderError({
      code: 'provider_down', provider: providerName,
      message: `${providerName} context-length exceeded: ${snippet}`,
      status,
    })
  }
  if (isModelIssue) {
    return createCloudProviderError({
      code: 'provider_down', provider: providerName,
      message: `${providerName} model not available: ${snippet}`,
      status,
    })
  }
  // Other 4xx — treat as bad_request (permanent, do not fall through).
  return createCloudProviderError({
    code: 'bad_request', provider: providerName, message: `${providerName} request error ${status}: ${snippet}`,
    status,
  })
}
