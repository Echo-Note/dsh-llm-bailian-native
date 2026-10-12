/**
 * Aliyun Bailian / DashScope native-protocol provider adapter for the DeepSeek
 * Harness.
 *
 * One `LlmAdapter` serves every configured route. Each route is declared to the
 * configurable-provider directory, so the Web Models page can activate and edit
 * it and the model picker can offer its catalog — no restart required.
 *
 * ## Extension seam for other clouds
 *
 * The wire protocol is selected per route by `protocol`, resolved from
 * `lib/providers/index.js`. This release registers exactly one adapter,
 * `dashscope-native`. `tencent-native` and `baidu-native` are **reserved keys**
 * that fail with an actionable message until an adapter file is added; see
 * `lib/protocol.js` for the `ProtocolAdapter` contract. Everything in this file,
 * in `lib/config.js` is vendor-neutral.
 *
 * ## Version-sensitive surface
 *
 * DSH is a preview product. The `ctx.llm` / `ctx.credentials` calls below are the
 * only version-sensitive code in the bundle, and the wire layer
 * (`lib/providers/**`, `lib/stream.js`) depends on nothing but `fetch`,
 * `AbortSignal` and `TextDecoder`.
 *
 * ## Why nothing is imported from `@deepseek-ai/*`
 *
 * This profile's `node_modules` is reached through a symlink, so Node resolves
 * imports from the plugin's **physical** path, where no `@deepseek-ai` copy
 * exists; and the copy that does sit in `~/.dsh/profiles/node_modules` belongs to
 * a *different* DSH installation, so importing it would mix build generations.
 * The adapter therefore satisfies `LlmAdapter` structurally instead of extending
 * it (the registry duck-types the seven methods it calls), builds its own typed
 * errors, and carries the one compile-time dependency it actually needs —
 * `schemastery`, for the Config schema — in `vendor/`.
 *
 * @module @local/dsh-llm-bailian-native
 */

import { Config, computeCost, defaultProfile, priceFor, resolveRoute, resolveRoutes } from './config.js'
import { describeApiKey, resolveApiKey } from './credentials.js'
import { CACHE_RULES } from './catalog.js'
import { FAILURE_CODES, RETRYABLE_CODES } from './protocol.js'
import { protocolFor, registeredProtocols } from './providers/index.js'
import { runNativeRequest, toFailure } from './stream.js'
import { createStatsService } from './stats.js'

export const name = 'llm-bailian-native'
export const inject = ['llm']
export { Config }

/** Fallback settings namespace when the Loader gives the row no id. */
const NS = 'llm-bailian-native'

/**
 * Read the harness usage buckets this adapter forwards unchanged.
 * @param {unknown} usage
 */
function normalizeUsage(usage) {
  const record = /** @type {Record<string, unknown>} */ (usage ?? {})
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    inputTokens: number(record.inputTokens),
    outputTokens: number(record.outputTokens),
    totalTokens: number(record.totalTokens),
    cacheReadTokens: number(record.cacheReadTokens),
    cacheWriteTokens: number(record.cacheWriteTokens),
    reasoningTokens: number(record.reasoningTokens),
  }
}

/** @param {unknown} model */
function isImageCapable(model) {
  return model?.inputModalities?.includes('image') === true
}

/**
 * The adapter handed to `ctx.llm.registerAdapter()`.
 *
 * It implements the `LlmAdapter` surface structurally — the registry duck-types
 * `providerInfo`, `providerRetryPolicy`, `imageRequestPricing`, `listModels`,
 * `resolveModel`, `prepareCall` and `stream` — so no `@deepseek-ai/dsh-llm`
 * import is needed. `prepareCall` is inherited behaviour via the base class in
 * the shipped adapters; the runtime's own default (resolve, then stream) is
 * equivalent and is provided explicitly below.
 *
 * It holds a live reference to the route map, so a configuration change is
 * visible to the next request without re-registering the routes.
 */
class BailianNativeAdapter {
  /**
   * @param {object} input
   * @param {() => Map<string, any>} input.routes
   * @param {() => Map<string, string>} input.errors
   * @param {() => Map<string, { at: number, models: any[], error?: string, requestId?: string }>} input.discoveries
   * @param {(route: string, models: any[], error?: string, requestId?: string) => void} input.rememberDiscovery
   * @param {import('@deepseek-ai/cordis').Context} input.ctx
   */
  constructor({ routes, errors, discoveries, rememberDiscovery, ctx }) {
    this.routes = routes
    this.errors = errors
    this.discoveries = discoveries
    this.rememberDiscovery = rememberDiscovery
    this.ctx = ctx
  }

  /**
   * Bind one exact model's metadata and the dispatch to a single generation.
   * Mirrors the base class: resolve, then stream through this instance.
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /** @param {string} provider */
  providerInfo(provider) {
    const route = this.routes().get(provider)
    return { id: provider, name: route?.displayName ?? '阿里云百炼（原生协议）' }
  }

  /** @param {string} _provider */
  providerRetryPolicy(_provider) {
    return { mode: 'normal', maxRetries: 5, retryableCodes: [...RETRYABLE_CODES], backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } }
  }

  /**
   * Declare image request pricing for routes that accept images.
   * @param {string} provider
   * @param {string} model
   */
  imageRequestPricing(provider, model) {
    const route = this.routes().get(provider)
    if (route === undefined) return undefined
    const entry = route.models.find((candidate) => candidate.id === model)
    if (!isImageCapable(entry)) return undefined
    const adapter = protocolFor(route.protocol)
    return adapter.priceImageRequest?.(route, model)
  }

  /**
   * List this route's models. Prefers the models observed from the native
   * catalog endpoint; falls back to the bundled-plus-configured catalog, which is
   * always available offline.
   * @param {string} provider
   */
  async listModels(provider) {
    const route = this.requireRoute(provider)
    const cached = this.discoveries().get(provider)
    const listed = cached === undefined ? [] : cached.models
    /** @type {Map<string, any>} */
    const merged = new Map()
    for (const entry of route.models) {
      merged.set(entry.id, entry)
    }
    for (const entry of listed) {
      const existing = merged.get(entry.id)
      merged.set(entry.id, {
        ...existing,
        id: entry.id,
        name: entry.name ?? existing?.name ?? entry.id,
        ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
        ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
        ...(entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities }),
        ...(entry.snapshotOf === undefined ? {} : { snapshotOf: entry.snapshotOf }),
      })
    }
    const enabled = [...merged.values()].filter((entry) => !route.modelDisabled.includes(entry.id))
    return enabled.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
      ...(entry.source === undefined ? {} : { description: entry.source }),
      inputModalities: entry.inputModalities ?? ['text'],
    }))
  }

  /**
   * Resolve one exact model's metadata.
   * @param {string} provider
   * @param {string} model
   */
  async resolveModel(provider, model) {
    const route = this.requireRoute(provider)
    const cached = this.discoveries().get(provider)?.models.find((entry) => entry.id === model)
    const entry = route.models.find((candidate) => candidate.id === model) ?? cached
    const contextWindow = entry?.contextWindow ?? route.defaultContextWindow
    const inputModalities = entry?.inputModalities ?? ['text']
    /** @type {Record<string, unknown>} */
    const reasoning = entry?.thinkingBudgets === undefined && !isThinkingFamily(model)
      ? {}
      : {
          reasoning: {
            efforts: [
              { id: 'off', name: 'Off', description: 'disable thinking (enable_thinking: false)' },
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'off',
          },
        }
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry?.source === undefined ? {} : { description: entry.source }),
      context: { contextWindow },
      defaultMaxTokens: entry?.maxTokens ?? Math.min(8192, Math.max(1024, Math.floor(contextWindow / 4))),
      inputModalities: [...inputModalities],
      ...reasoning,
    }
  }

  /**
   * Stream one call.
   *
   * Every failure becomes a terminal `finish` chunk with a stable code; the
   * usage chunk is forwarded unchanged, so the harness records it and every
   * observer — including cost/statistics plugins — reads the same numbers.
   * @param {import('./protocol.js').GenerateOptions} options
   */
  async *stream(options) {
    const route = this.routes().get(options.provider)
    if (route === undefined) {
      const reason = this.errors().get(options.provider)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: reason === undefined
            ? { code: FAILURE_CODES.NO_ADAPTER, message: `this adapter owns no provider route "${options.provider}"` }
            : { code: FAILURE_CODES.INVALID_CONFIG, message: `provider route "${options.provider}" is misconfigured: ${reason}` },
        },
      }
      return
    }

    const adapter = protocolFor(route.protocol)
    /** @type {string | undefined} */
    let apiKey
    try {
      apiKey = await resolveApiKey(route, this.ctx)
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: toFailure(error) } }
      return
    }

    // Always stream: `incremental_output` and thinking both depend on it, and the
    // native non-streaming path exists only for callers that cannot stream.
    const stream = true
    /** @type {any} */
    let observedUsage
    /** @type {any} */
    let finishReason
    let sawFinish = false
    let textLength = 0

    for await (const chunk of runNativeRequest({ adapter, route, options, apiKey, stream })) {
      if (chunk.type === 'usage') observedUsage = chunk.usage
      if (chunk.type === 'text-delta') textLength += chunk.text.length
      if (chunk.type === 'finish') {
        sawFinish = true
        finishReason = chunk.reason
      }
      yield chunk
    }

    if (!sawFinish) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: FAILURE_CODES.STREAM_CLOSED, message: 'the native adapter ended without a terminal finish chunk' },
        },
      }
    }
    void finishReason
    void textLength
  }

  

  /**
   * Health-check one route: credential state, endpoint reachability and the
   * catalog endpoint, in one call. Used by the settings UI and by the
   * `bailian_native` tool.
   * @param {string} provider
   * @param {AbortSignal} [signal]
   */
  async probeRoute(provider, signal) {
    const route = this.routes().get(provider)
    if (route === undefined) {
      const reason = this.errors().get(provider)
      return {
        ok: false,
        code: reason === undefined ? FAILURE_CODES.NO_ADAPTER : FAILURE_CODES.INVALID_CONFIG,
        message: reason ?? `this adapter owns no provider route "${provider}"`,
      }
    }
    const credential = await describeApiKey(route, this.ctx)
    let apiKey
    try {
      apiKey = await resolveApiKey(route, this.ctx)
    } catch (error) {
      return { ok: false, code: toFailure(error).code, message: toFailure(error).message, credential }
    }
    const adapter = protocolFor(route.protocol)
    const result = await adapter.probe(route, apiKey, signal)
    return { ...result, credential }
  }

  /**
   * Refresh one route's catalog from its endpoint, remembering the last
   * successful result so a later failure degrades to it instead of to nothing.
   * @param {string} provider
   * @param {AbortSignal} [signal]
   */
  async refreshCatalog(provider, signal) {
    const route = this.requireRoute(provider)
    const adapter = protocolFor(route.protocol)
    const credential = await describeApiKey(route, this.ctx)
    let apiKey
    try {
      apiKey = await resolveApiKey(route, this.ctx)
    } catch (error) {
      return { ok: false, code: toFailure(error).code, message: toFailure(error).message, models: [], credential }
    }
    if (typeof adapter.listEndpointModels !== 'function') {
      return {
        ok: false,
        code: 'DISCOVERY_UNSUPPORTED',
        message: `protocol "${route.protocol}" has no documented model-listing route; the configured and bundled catalogs are used instead`,
        models: [],
        credential,
      }
    }
    const notices = []
    const listed = await adapter.listEndpointModels({
      route,
      apiKey,
      signal,
      pageSize: 100,
      maxPages: 5,
      onNotice: (message) => notices.push(message),
    })
    if (listed.supported === false) {
      const previous = this.discoveries().get(provider)
      return {
        ok: false,
        code: 'DISCOVERY_FAILED',
        message: listed.notice ?? 'the model catalog could not be read',
        notices,
        models: previous?.models ?? [],
        degradedTo: previous === undefined ? 'bundled-catalog' : 'last-successful-catalog',
        credential,
      }
    }
    this.rememberDiscovery(provider, listed.models, undefined, listed.requestId)
    return {
      ok: true,
      message: `refreshed ${listed.models.length} models from ${route.baseURL}`,
      notices,
      models: listed.models,
      credential,
      ...(listed.requestId === undefined ? {} : { requestId: listed.requestId }),
    }
  }

  /** @param {string} provider */
  requireRoute(provider) {
    const route = this.routes().get(provider)
    if (route !== undefined) return route
    const reason = this.errors().get(provider)
    throw adapterError(
      reason === undefined ? FAILURE_CODES.NO_ADAPTER : FAILURE_CODES.INVALID_CONFIG,
      reason === undefined
        ? `llm-bailian-native owns no provider route "${provider}"`
        : `provider route "${provider}" is misconfigured: ${reason}`,
    )
  }

  /** The price rows this route would use, with provenance, for the settings UI. */
  priceTable(provider) {
    const route = this.routes().get(provider)
    if (route === undefined) return []
    return route.models.map((entry) => {
      const price = priceFor(route, entry.id, { snapshotOf: entry.snapshotOf })
      return {
        model: entry.id,
        name: entry.name,
        currency: price.currency,
        cacheMiss: price.cacheMiss,
        cacheHit: price.cacheHit,
        output: price.output,
        source: price.source,
        verified: price.verified,
        ...(price.tiers === undefined ? {} : { tiers: price.tiers }),
        ...(price.sourceUrl === undefined ? {} : { sourceUrl: price.sourceUrl }),
        ...(price.cacheHit === null ? { note: `the provider does not publish a cache-read price for this model; local billing estimates cached tokens at the uncached rate (rule and exceptions: ${CACHE_RULES.sourceUrl})` } : {}),
      }
    })
  }
}



/**
 * A model family this adapter assumes is thinking-capable even when the bundled
 * catalog has no entry for it, so the picker still offers an effort control.
 * @param {string} model
 */
function isThinkingFamily(model) {
  return /qwen3\.[5-9]|qwen3-|deepseek-v4|glm-|kimi-k[23]/i.test(model)
}


/**
 * Mount the adapter.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  ctx.inject(['settings'], (child) => {
    // The generic schema form is enough for this plugin's connection fields, so
    // opt out of a hand-written automatic page.
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const settingsNs = ctx.fiber?.entry?.options?.id ?? NS

  /**
   * Routes that exist only because nothing is configured — the Models page offers
   * these for adoption (`declared: true`) rather than showing them as live rows.
   * @type {Set<string>}
   */
  const dormant = new Set()

  /** Memoize route resolution on the raw config snapshot's identity. */
  let lastRaw
  /** @type {{ routes: Map<string, any>, errors: Map<string, string> } | undefined} */
  let memoized
  const resolve = () => {
    const raw = config.providers.get()
    if (raw === lastRaw && memoized !== undefined) return memoized
    lastRaw = raw
    try {
      memoized = resolveRoutes(structuredClone(raw))
    } catch (error) {
      // A whole-document defect (for example `providers` as an array) must not
      // take the plugin down: fall back to the dormant default route and record
      // the diagnostic where the UI can read it.
      const message = error instanceof Error ? error.message : String(error)
      memoized = { routes: new Map(), errors: new Map([['bailian-native', message]]) }
    }
    if (memoized.routes.size === 0 && memoized.errors.size === 0) {
      // Nothing is configured: publish the route this plugin can serve as a
      // *dormant, adoptable* provider, which is what a third-party provider must
      // look like on the Models page before the user activates it.
      memoized.routes.set('bailian-native', resolveDormant('bailian-native'))
      dormant.add('bailian-native')
    }
    return memoized
  }

  const routes = () => resolve().routes
  const errors = () => resolve().errors

  /** @type {Map<string, { at: number, models: any[], error?: string, requestId?: string }>} */
  const discovered = new Map()
  const rememberDiscovery = (provider, models, error, requestId) => {
    discovered.set(provider, {
      at: Date.now(),
      models: Array.isArray(models) ? models : [],
      ...(error === undefined ? {} : { error }),
      ...(requestId === undefined ? {} : { requestId }),
    })
  }

  const adapter = new BailianNativeAdapter({ routes, errors, discoveries: () => discovered, rememberDiscovery, ctx })

  // --- route registration -------------------------------------------------
  /** Routes the registration currently holds. */
  let registered = []
  const ensureRoutes = () => {
    const next = [...routes().keys()]
    if (next.length === 0) return
    const routesFor = next.map((route) => route)
    if (registered.length === 0) {
      handle = ctx.llm.registerAdapter(routesFor, adapter)
    } else if (routesFor.join('\u0000') !== registered.join('\u0000')) {
      handle.replace(routesFor)
    }
    registered = routesFor
  }
  /** @type {{ replace: (routes: string[]) => void } | undefined} */
  let handle

  const routeErrors = () => {
    /** @type {Map<string, string>} */
    const all = new Map(errors())
    for (const [route, cache] of discovered) {
      if (all.has(route)) continue
      // A refreshed-then-failed discovery is a warning, not a broken route.
      if (cache.error !== undefined) all.set(route, cache.error)
    }
    return all
  }

  // --- configurable-provider directory ------------------------------------
  /** @type {any[]} */
  let directory
  const ensureDirectory = () => {
    const entries = directoryEntries(routes(), routeErrors(), settingsNs, dormant)
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries)
    else directory.replace(entries)
  }

  // --- model discovery ----------------------------------------------------
  const discovery = ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    const provider = typeof request.provider === 'string' && request.provider.length > 0 ? request.provider : 'bailian-native'
    const route = routes().get(provider) ?? resolveDormant(provider, request)
    const protocol = route.protocol
    const adapterForProtocol = protocolFor(protocol)
    if (typeof adapterForProtocol.listEndpointModels !== 'function') {
      throw adapterError('DISCOVERY_UNSUPPORTED', `protocol "${protocol}" exposes no model listing`)
    }
    // A draft may carry a one-shot key that is not stored anywhere yet; the
    // directory's own resolution is used when it does not.
    const apiKey = typeof request.apiKey === 'string' && request.apiKey.length > 0
      ? assertUsableKey(request.apiKey, 'the credentials form')
      : await resolveApiKey(route, ctx)
    const listed = await adapterForProtocol.listEndpointModels({ route, apiKey, signal })
    if (listed.supported === false) {
      throw adapterError('DISCOVERY_FAILED', listed.notice ?? 'the endpoint did not list its models')
    }
    rememberDiscovery(provider, listed.models, undefined, listed.requestId)
    return listed.models
  })

  // --- initial wiring + live updates --------------------------------------
  ensureRoutes()
  ensureDirectory()

  ctx.on('loader/volatile-update', () => {
    try {
      ensureRoutes()
      ensureDirectory()
    } catch (error) {
      ctx.logger?.error?.('llm-bailian-native: configuration conflicts with an existing provider route')
      ctx.logger?.error?.(error)
    }
  })

  ctx.on('dispose', () => {
    discovery()
    directory?.()
  })


  // The stats gateway service: the manifest in lib/typert.host.js declares these
  // invocations, and the client half mounts matching descriptors to reach them.
  if (typeof ctx.provide === 'function') ctx.provide('bailianNative', createStatsService(ctx, routes))
}

/**
 * Build the directory rows the Models page renders.
 * @param {Map<string, any>} routes
 * @param {Map<string, string>} errors
 * @param {string} settingsNs
 */
function directoryEntries(routes, errors, settingsNs, dormant = new Set()) {
  /** @type {Map<string, any>} */
  const entries = new Map()
  for (const route of routes.keys()) {
    entries.set(route, {
      provider: route,
      displayName: routes.get(route).displayName,
      settingsNs,
      settingsPath: ['providers', route],
      // A route with no stored profile is a provider the user can still adopt;
      // only a route the configuration actually declares is a live row.
      declared: dormant.has(route),
    })
  }
  for (const [route, message] of errors) {
    if (entries.has(route)) {
      entries.get(route).error = message
      continue
    }
    // A route whose configuration is broken still gets a row, so the Models page
    // shows the diagnostic and offers an editor instead of hiding it.
    entries.set(route, {
      provider: route,
      displayName: route,
      settingsNs,
      settingsPath: ['providers', route],
      declared: true,
      error: message,
    })
  }
  if (!entries.has('bailian-native')) {
    entries.set('bailian-native', {
      provider: 'bailian-native',
      displayName: '阿里云百炼（原生协议）',
      settingsNs,
      settingsPath: ['providers', 'bailian-native'],
      declared: true,
    })
  }
  return [...entries.values()]
}

/**
 * The route a dormant provider would use, so a route with no stored profile is
 * still activatable from the Models page and still answers `listModels`.
 * @param {string} provider
 * @param {{ baseURL?: string, apiKey?: string }} [request]
 */
function resolveDormant(provider, request) {
  const draft = defaultProfile('dashscope-native')
  if (typeof request?.baseURL === 'string' && request.baseURL.length > 0) {
    draft.baseURL = protocolFor('dashscope-native').normalizeServiceRoot(request.baseURL)
  }
  return {
    ...draft,
    route: provider,
    displayName: provider === 'bailian-native' ? draft.displayName : provider,
    // A draft route has no stored credential reference; the one-shot key from
    // the discovery request is used by the caller instead.
    apiKeyEnv: undefined,
    headers: {},
    models: draft.models,
    modelDisabled: [],
    generationPathOverrides: {},
    priceOverrides: {},
    cacheCatalog: true,
    catalogRefreshMinutes: 0,
    multimodalFamilies: protocolFor('dashscope-native').multimodalModelPrefixes ?? [],
  }
}

/**
 * Pick the route an operation applies to.
 * @param {unknown} requested
 * @param {Map<string, any>} routes
 */
function pickRoute(requested, routes) {
  if (typeof requested === 'string' && requested.length > 0) return requested
  if (routes.has('bailian-native')) return 'bailian-native'
  const first = [...routes.keys()][0]
  return first ?? 'bailian-native'
}
