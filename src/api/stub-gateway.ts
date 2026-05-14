// ============================================================================
// Test-only stub ProviderGateway + ProviderSetupResult helpers.
//
// Shared by the integration tests that exercise broadcast wiring, agent-state
// wiring, and the biometrics capture flow. They all need a real
// ProviderGateway shape (no mocks — CLAUDE.md memory_no_mocks) with a
// controlled response and no LLM round-trip. Extracted from three test files
// that had byte-identical (or cosmetically-different) inline copies.
//
// The chat() response is hardcoded — the integration tests assert on the
// system-event side-effects of routing, not on chat content. If a future
// test needs to assert on response shape, parametrize at that point.
// ============================================================================

import { createProviderRouter } from '../llm/router.ts'
import type { ProviderGateway } from '../llm/provider-gateway.ts'
import type {
  ProviderHealth, GatewayMetrics, ChatRequest, ChatResponse,
} from '../core/types/llm.ts'
import type { ProviderSetupResult } from '../llm/providers-setup.ts'

export const makeStubGateway = (): ProviderGateway => {
  const health: ProviderHealth = {
    status: 'healthy', latencyMs: 0,
    availableModels: ['mock-model'],
    lastCheckedAt: Date.now(),
  }
  const metrics: GatewayMetrics = {
    requestCount: 0, errorCount: 0, errorRate: 0,
    p50Latency: 0, p95Latency: 0, avgTokensPerSecond: 0,
    queueDepth: 0, concurrentRequests: 0,
    circuitState: 'closed', shedCount: 0, windowMs: 300_000,
  }
  return {
    chat: async (_req: ChatRequest): Promise<ChatResponse> =>
      ({ content: 'ok', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } }),
    stream: async function* () { throw new Error('not used in stub gateway') },
    models: async () => [...health.availableModels],
    runningModels: async () => [],
    getMetrics: () => metrics,
    getHealth: () => health,
    getConfig: () => ({
      maxConcurrent: 2, maxQueueDepth: 6, queueTimeoutMs: 30_000,
      circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 15_000,
    }),
    updateConfig: () => {},
    onHealthChange: () => {},
    resetCircuitBreaker: () => {},
    refreshModels: async () => {},
    recordExternalFailure: () => {},
    dispose: () => {},
  }
}

export const makeStubSetup = (gateway: ProviderGateway = makeStubGateway()): ProviderSetupResult => {
  const router = createProviderRouter({ stub: gateway }, { order: ['stub'] })
  return { router, gateways: { stub: gateway }, monitors: {}, dispose: () => router.dispose() }
}

// Provider config matching the single-stub gateway shape. Inlined in each
// test before; shared here so changes propagate.
export const stubProviderConfig = {
  order: ['stub'] as ReadonlyArray<string>,
  ollamaUrl: '',
  ollamaMaxConcurrent: 2,
  baseUrls: {},
  cloud: {},
  ollamaOnly: false,
  forceFailProvider: null,
  droppedFromOrder: [],
  orderFromUser: false,
}
