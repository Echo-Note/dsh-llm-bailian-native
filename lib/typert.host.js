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

/** Loose codec: the gateway validates JSON safety itself. */
const loose = Object.freeze({ mode: 'src-json' })

/** @param {string} method */
const id = (method) => `${PACKAGE}#${SERVICE}/${method}`

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
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
      result: { mode: 'src-json' },
    },
  ],
}
