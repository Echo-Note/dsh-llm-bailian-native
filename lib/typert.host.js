/**
 * Hand-written Typert Host face.
 *
 * The settings page needs numbers the browser cannot compute (billed spend from
 * the ModelStudio API, the resolved price table, the cache arithmetic). Those
 * travel over the package-private gateway: this manifest declares the
 * invocations, and the client half mounts matching descriptors before calling
 * `ctx.get('remote.bailianNative')`.
 *
 * Shape and conventions follow `dsh-cost-meter`'s hand-written manifest, which is
 * what makes a plain-JavaScript bundle able to expose host methods without any
 * code generation:
 *
 *   - `id` is `<package>#<service>/<method>`;
 *   - `service` is the key the gateway resolves against the plugin context;
 *   - parameters are listed in call order.
 *
 * Loose (`src-json`) codecs are used deliberately: the values are already
 * JSON-shaped by construction (see `createStatsService`), and a strict codec here
 * would add a second place to keep in sync with the payloads for no safety the
 * gateway's own JSON validation does not already provide.
 *
 * @module @local/dsh-llm-bailian-native/typert.host
 */

const PACKAGE = '@local/dsh-llm-bailian-native'
const SERVICE = 'bailianNative'

/** A parameter passed through as JSON. */
const jsonParam = (name) => ({ name, wire: name, source: 'json' })
/** An optional JSON parameter. */
const optionalJsonParam = (name) => ({ ...jsonParam(name), acceptsUndefined: true })

/**
 * Result codec.
 *
 * The loader rejects a loose (`src-json`) result: `invocation "…" result codec
 * must use a strict codec`. A strict codec needs a registered `schemas[]` entry
 * for its `typeSymbol`, and the survey payload is plain JSON, so the schema is a
 * pass-through validator.
 */
const SNAPSHOT_SYMBOL = `${PACKAGE}#BailianStatsSnapshot`
const snapshotCodec = Object.freeze({
  mode: 'strict',
  typeSymbol: SNAPSHOT_SYMBOL,
  create: () => ({ parse: (value) => value }),
})

/** @param {string} method */
const id = (method) => `${PACKAGE}#${SERVICE}/${method}`

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [
    {
      name: 'BailianStatsSnapshot',
      // The payload is assembled JSON-safe by createStatsService, so validation
      // is a pass-through rather than a second schema to keep in sync.
      create: () => ({ parse: (value) => value }),
    },
  ],
  /**
   * Package reflection. Required by the loader — without it registration fails
   * with `TYPERT.model must be an object`, the namespace never mounts, and every
   * call answers `HTTP 404` on `/api/<namespace>/<method>`.
   */
  model: {
    services: [
      {
        key: SERVICE,
        exportName: 'bailianNative',
        // `requireDocumentation` demands a tags array on every service, event
        // and object.
        tags: [],
        members: [
          {
            kind: 'method',
            name: 'snapshot',
            signature: 'snapshot(): Promise<BailianStatsSnapshot>',
            summary: 'Billing, price table and prompt-cache statistics for the configured DashScope route.',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: [
    {
      // No parameters and no codecs on purpose: this is the harness's shape for a
      // package-private method that takes no arguments (the same one
      // `dsh-cost-meter`'s `fetchPrices` uses). Declaring argument codecs here is
      // what made the client's `$mount` throw reading `kind` off undefined.
      id: `${PACKAGE}#${SERVICE}/snapshot`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'snapshot',
      invocation: { kind: 'direct' },
      parameters: [],
      result: snapshotCodec,
    },
  ],
}
