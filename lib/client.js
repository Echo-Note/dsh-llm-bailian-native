/**
 * Client half of the bundle: the "百炼用量与价格" settings page.
 *
 * Plain JavaScript, loaded as a browser bundle (`window.__ModuleLoader__.load`),
 * exactly like the shipped decorations and like other third-party settings pages
 * (cost-meter, skills-manager, prompt-optimizer all register in this slot).
 *
 * ## What this page can and cannot read
 *
 * The browser reaches the host only through declared *lazy* services. Measured
 * against the running app, the Remote surface exposes exactly:
 *
 *   remote.credentials.describe | .set | .unset
 *   remote.llm.listConfigurableProviders | .listProviders | .discoverModels
 *   remote.session.modelCatalog
 *   remote.settings.mutate          (write only)
 *
 * There is **no** `remote.settings.describe`, and the client Service catalog has
 * no `settings` service at all — an earlier version of this page wrongly assumed
 * both, and reported a misleading error. This page therefore shows what the
 * read-only calls genuinely answer (route registration, directory row, credential
 * state), plus the cache rules, which are static knowledge needing no call.
 *
 * Richer host state (resolved price table, catalog diff, self-check, billing
 * reconciliation) needs a host `./typert` face plus `remote.$mount`; that bridge
 * is not implemented yet, and the page says so instead of rendering blanks.
 *
 * ## Two rendering rules
 *
 * 1. **No Harness Client package is imported.** Only `react` comes from the
 *    browser module table; styles are `--dsw-alias-*` theme tokens, so a renamed
 *    token can only degrade appearance, never break rendering.
 * 2. **It degrades instead of throwing.** A slot entry that throws is blanked by
 *    the shell (`slot entry crashed in '<slot>'`), so every failure path renders
 *    an explanation instead.
 *
 * @module @local/dsh-llm-bailian-native/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-llm-bailian-native',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The client context captured in apply(); the slot renders outside this module. */
    let clientCtx = null

    /** The settings namespace this plugin's row owns (its Loader entry id). */
    const SETTINGS_NS = 'llm-bailian-native'
    /** The route inside it. */
    const ROUTE = 'bailian-native'
    /** The settings path the Models page writes. */
    const SETTINGS_PATH = ['providers', ROUTE]

    const css = `
.bln-page{display:flex;flex-direction:column;gap:14px;padding:14px 16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.bln-h{font-size:14px;font-weight:600;margin:0}
.bln-card{border:1px solid var(--dsw-alias-border-secondary);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}
.bln-card-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.bln-muted{color:var(--dsw-alias-label-secondary)}
.bln-warn{color:var(--dsw-alias-state-warning-primary)}
.bln-grid{display:grid;grid-template-columns:minmax(130px,auto) 1fr;gap:4px 14px}
.bln-k{color:var(--dsw-alias-label-secondary)}
.bln-v{overflow-wrap:anywhere}
.bln-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.bln-tag{display:inline-block;border:1px solid var(--dsw-alias-border-secondary);border-radius:999px;padding:0 7px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.bln-list{margin:8px 0 0;padding-left:18px}
.bln-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}
.bln-card p{margin:6px 0}
.bln-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.bln-stat{border:1px solid var(--dsw-alias-border-secondary);border-radius:8px;padding:8px 10px}
.bln-stat-v{font-size:16px;font-weight:600}
.bln-ok{color:var(--dsw-alias-state-business-primary)}
.bln-bar-row{display:grid;grid-template-columns:minmax(120px,1.4fr) 1fr auto auto;gap:8px;align-items:center;padding:2px 0}
.bln-bar-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bln-bar-bg{height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.bln-bar{height:100%;border-radius:4px;background:var(--dsw-alias-state-business-primary)}
.bln-bar-val,.bln-bar-pct{color:var(--dsw-alias-label-secondary)}
.bln-table{margin-top:8px}
.bln-tr{display:grid;grid-template-columns:minmax(120px,1.6fr) repeat(3,minmax(52px,0.6fr)) minmax(64px,0.8fr);gap:8px;align-items:center;padding:3px 0;border-top:1px solid var(--dsw-alias-border-secondary)}
.bln-tr:first-child{border-top:0}
.bln-th{color:var(--dsw-alias-label-secondary)}
.bln-off{opacity:.5}
`

    /**
     * Unwrap a gateway response.
     *
     * The Remote surface answers a `RemoteResult` envelope (`{ok,value}` or
     * `{ok:false,error}`) for some namespaces and a bare value for others, and an
     * unknown method *rejects* rather than resolving falsy. All three are
     * normalized so callers only see `{ok:true,value}` or `{ok:false,error}`.
     * @param {unknown} response
     */
    function unwrap(response) {
      const record = response !== null && typeof response === 'object' ? response : null
      if (record !== null && ('ok' in record || 'value' in record || 'error' in record)) {
        if (record.ok === false) return { ok: false, error: record.error }
        return { ok: true, value: record.value }
      }
      return { ok: true, value: response }
    }

    /** One loose codec: the host already guarantees JSON-shaped payloads. */
    function looseCodec(name) {
      return {
        mode: 'strict',
        typeSymbol: `@local/dsh-llm-bailian-native#${name}`,
        create: () => ({ parse: (value) => value }),
      }
    }

    /** Parameter descriptor for the client side of the wire. */
    const jsonParam = (name) => ({ name, wire: name, source: 'json', codec: looseCodec(name), acceptsUndefined: true })

    /**
     * The package-owned invocations this page calls.
     *
     * Mirrors `lib/typert.host.js` on the host half and follows the same
     * convention `dsh-cost-meter` uses, which is what lets a plain-JavaScript
     * bundle expose and call host methods with no code generation.
     */
    const CONTRIBUTION = {
      package: '@local/dsh-llm-bailian-native',
      descriptors: [
        { method: 'overview', parameters: [jsonParam('requested')], result: looseCodec('Overview') },
        { method: 'billing', parameters: [jsonParam('requested'), jsonParam('month')], result: looseCodec('Billing') },
        { method: 'prices', parameters: [jsonParam('requested'), jsonParam('model')], result: looseCodec('Prices') },
      ],
    }

    /**
     * Mount this package's remote contribution and return the service proxy.
     * @param {any} ctx
     */
    async function mountStats(ctx) {
      /** @type {any} */
      let remote
      try {
        remote = ctx?.remote
      } catch (error) {
        return { kind: 'unavailable', reason: `the client context refused a lazy service: ${error?.message ?? String(error)}` }
      }
      if (remote === undefined || remote === null || typeof remote.$mount !== 'function') {
        return { kind: 'unavailable', reason: 'this client context exposes no remote.$mount' }
      }
      if (ctx.__blnMounted === undefined) {
        try {
          const dispose = await remote.$mount(CONTRIBUTION)
          ctx.__blnMounted = typeof dispose === 'function' ? dispose : null
        } catch (error) {
          return { kind: 'unavailable', reason: `mounting the stats contribution failed: ${error?.message ?? String(error)}` }
        }
      }
      const service = typeof ctx.get === 'function' ? ctx.get('remote.bailianNative') : undefined
      if (service === undefined) {
        return { kind: 'unavailable', reason: 'the stats service "remote.bailianNative" was not published by the gateway' }
      }
      return { kind: 'ok', service }
    }

    /** Call one service method and unwrap it. */
    async function call(service, method, args) {
      const result = unwrap(await service[method](...(args ?? [])))
      if (!result.ok) throw new Error(result.error?.message ?? `${method} failed`)
      return result.value
    }

    /**
     * Load every panel's data.
     * @param {any} ctx
     */
    async function loadStats(ctx) {
      const mounted = await mountStats(ctx)
      if (mounted.kind !== 'ok') return mounted
      const { service } = mounted
      const failures = []
      let overview = null
      let billing = null
      let prices = null
      try {
        overview = await call(service, 'overview', [])
      } catch (error) {
        failures.push(`overview: ${error?.message ?? String(error)}`)
      }
      try {
        billing = await call(service, 'billing', [])
      } catch (error) {
        failures.push(`billing: ${error?.message ?? String(error)}`)
      }
      try {
        prices = await call(service, 'prices', [])
      } catch (error) {
        failures.push(`prices: ${error?.message ?? String(error)}`)
      }
      if (overview === null && billing === null && prices === null) {
        return { kind: 'unavailable', reason: failures[0] ?? 'the stats service answered nothing', extra: failures }
      }
      return { kind: 'ok', overview, billing, prices, failures }
    }

    /** @param {number} value @param {string} currency */
    function money(value, currency) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''
      const digits = value > 0 && value < 0.0001 ? 8 : value < 1 ? 6 : 2
      return `${symbol}${value.toFixed(digits)}`
    }

    /** @param {number} value */
    function pct(value) {
      return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
    }

    /** @param {{ overview: any }} props */
    function HeadCard({ overview }) {
      const rows = [
        ['路由', overview?.route ?? 'bailian-native'],
        ['服务地址', overview?.baseURL ?? '（未配置）'],
        ['默认模型', overview?.defaultModel ?? '—'],
        ['模型数量', String(overview?.modelCount ?? 0)],
        ['模型 API Key 引用', overview?.apiKeyEnv ?? '（未配置）'],
        ['账单 AccessKey', overview?.credentials?.idConfigured === true && overview?.credentials?.secretConfigured === true
          ? `已配置（${overview.credentials.idRef} · 末四位 ${overview.credentials.idSuffix ?? '????'}）`
          : `未配置（需要 ${overview?.credentials?.idRef ?? 'ALIYUN_ACCESS_KEY_ID'} / ${overview?.credentials?.secretRef ?? 'ALIYUN_ACCESS_KEY_SECRET'}）`],
      ]
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, h('h3', { className: 'bln-h' }, '连接')),
        h('div', { className: 'bln-grid', key: 'g' }, rows.flatMap(([k, v]) => [
          h('div', { className: 'bln-k', key: `${k}-k` }, k),
          h('div', { className: 'bln-v bln-mono', key: `${k}-v` }, String(v)),
        ])),
      ])
    }

    /** @param {{ billing: any }} props */
    function BillingCard({ billing }) {
      if (billing === null || billing === undefined) return null
      if (billing.available !== true) {
        return h('div', { className: 'bln-card' }, [
          h('div', { className: 'bln-card-title', key: 't' }, h('h3', { className: 'bln-h' }, '账单（真实计费）')),
          h('p', { className: 'bln-muted', key: 'p', style: { marginBottom: 0 } }, billing.reason ?? 'unavailable'),
        ])
      }
      const currency = billing.currency
      const total = Number(billing.totalAmount)
      const top = Array.isArray(billing.groups) ? billing.groups : []
      const max = top.reduce((acc, group) => Math.max(acc, Number(group.amount) || 0), 0)
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, [
          h('h3', { className: 'bln-h', key: 'h' }, `账单 · ${billing.month}`),
          h('span', { className: 'bln-tag', key: 'tag' }, `按 ${billing.groupBy}`),
        ]),
        h('div', { className: 'bln-cols', key: 'stats' }, [
          h('div', { className: 'bln-stat', key: 'total' }, [
            h('div', { className: 'bln-muted', key: 'l' }, '当月合计'),
            h('div', { className: 'bln-stat-v', key: 'v' }, `${currency} ${Number.isFinite(total) ? total.toFixed(2) : billing.totalAmount}`),
          ]),
          h('div', { className: 'bln-stat', key: 'pre' }, [
            h('div', { className: 'bln-muted', key: 'l' }, '不含税 / 税'),
            h('div', { className: 'bln-stat-v', key: 'v' }, `${Number(billing.pretaxAmount).toFixed(2)} / ${Number(billing.taxAmount).toFixed(2)}`),
          ]),
          h('div', { className: 'bln-stat', key: 'days' }, [
            h('div', { className: 'bln-muted', key: 'l' }, '计费天数'),
            h('div', { className: 'bln-stat-v', key: 'v' }, String(Array.isArray(billing.daily) ? billing.daily.length : '—')),
          ]),
        ]),
        top.length === 0
          ? h('p', { className: 'bln-muted', key: 'none', style: { marginBottom: 0 } }, '该月没有计费记录。')
          : h('div', { key: 'rows', style: { marginTop: 8 } }, top.map((group) => {
              const amount = Number(group.amount) || 0
              const width = max > 0 ? `${Math.max(1, Math.round((amount / max) * 100))}%` : '0%'
              return h('div', { className: 'bln-bar-row', key: group.key }, [
                h('span', { className: 'bln-bar-name bln-mono', key: 'n', title: group.name }, group.key),
                h('div', { className: 'bln-bar-bg', key: 'b' }, h('div', { className: 'bln-bar', style: { width } })),
                h('span', { className: 'bln-bar-val bln-mono', key: 'v' }, `${currency} ${amount.toFixed(2)}`),
                h('span', { className: 'bln-bar-pct bln-mono', key: 'p' }, pct((Number(group.percentage) || 0) * 100)),
              ])
            })),
        billing.trendError === null || billing.trendError === undefined
          ? null
          : h('p', { className: 'bln-muted', key: 'te', style: { marginBottom: 0 } }, `逐日趋势不可用：${billing.trendError}`),
      ])
    }

    /** @param {{ prices: any }} props */
    function CacheCard({ prices }) {
      const cache = prices?.cache
      if (cache === null || cache === undefined) return null
      const currency = cache.currency
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, [
          h('h3', { className: 'bln-h', key: 'h' }, `缓存收益 · ${cache.model}`),
          h('span', { className: cache.cacheHitPublished ? 'bln-tag' : 'bln-tag bln-warn', key: 'tag' },
            cache.cacheHitPublished ? '官方已公布缓存价' : '缓存价未公布 → 按隐式 20% 推导'),
        ]),
        h('div', { className: 'bln-cols', key: 'stats' }, [
          h('div', { className: 'bln-stat', key: 'cold' }, [
            h('div', { className: 'bln-muted', key: 'l' }, `未命中（${cache.promptTokens} 输入）`),
            h('div', { className: 'bln-stat-v', key: 'v' }, money(cache.coldCost, currency)),
          ]),
          h('div', { className: 'bln-stat', key: 'warm' }, [
            h('div', { className: 'bln-muted', key: 'l' }, `命中（${cache.cachedTokens} 来自缓存）`),
            h('div', { className: 'bln-stat-v bln-ok', key: 'v' }, money(cache.warmCost, currency)),
          ]),
          h('div', { className: 'bln-stat', key: 'saved' }, [
            h('div', { className: 'bln-muted', key: 'l' }, '节省'),
            h('div', { className: 'bln-stat-v', key: 'v' }, `${pct(cache.savedPercent)} · ${money(cache.savedAmount, currency)}`),
          ]),
        ]),
        h('div', { className: 'bln-grid', key: 'rates', style: { marginTop: 8 } }, [
          ['未缓存输入单价', `${cache.uncachedInputRate} / 1M`],
          ['缓存命中单价', cache.cacheHitRate === null ? '官方未公布' : `${cache.cacheHitRate} / 1M`],
          ['命中占比', pct((cache.cacheHitShare ?? 0) * 100)],
          ['官方规则', `隐式 ${pct((cache.rules?.implicitHitRatio ?? 0) * 100)} / 显式命中 ${pct((cache.rules?.explicitHitRatio ?? 0) * 100)} / 显式写入 ${pct((cache.rules?.explicitWriteRatio ?? 0) * 100)}`],
          ['规则例外', (cache.rules?.exceptions ?? []).join('、')],
        ].flatMap(([k, v]) => [
          h('div', { className: 'bln-k', key: `${k}-k` }, k),
          h('div', { className: 'bln-v bln-mono', key: `${k}-v` }, String(v)),
        ])),
        h('p', { className: 'bln-muted', key: 'note', style: { marginBottom: 0 } },
          '口径：未缓存输入 = inputTokens − cacheReadTokens，命中部分按缓存价。' + (cache.note ?? '')),
      ])
    }

    /** @param {{ prices: any }} props */
    function PriceCard({ prices }) {
      const rows = Array.isArray(prices?.prices) ? prices.prices : []
      if (rows.length === 0) return null
      const currency = prices.currency
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, [
          h('h3', { className: 'bln-h', key: 'h' }, '本地价格表'),
          h('span', { className: 'bln-tag', key: 'tag' }, `${rows.length} 个模型 · ${currency} / 1M token`),
        ]),
        h('div', { className: 'bln-table', key: 'tbl' }, [
          h('div', { className: 'bln-tr bln-th', key: 'h' }, [
            h('span', { key: 'a' }, '模型'),
            h('span', { key: 'b' }, '输入'),
            h('span', { key: 'c' }, '命中'),
            h('span', { key: 'd' }, '输出'),
            h('span', { key: 'e' }, '来源'),
          ]),
          ...rows.map((row) => h('div', { className: 'bln-tr' + (row.enabled ? '' : ' bln-off'), key: row.model }, [
            h('span', { className: 'bln-mono', key: 'a', title: row.sourceUrl ?? '' }, row.model),
            h('span', { key: 'b' }, String(row.cacheMiss)),
            h('span', { className: row.cacheHitPublished ? '' : 'bln-warn', key: 'c' }, row.cacheHitPublished ? String(row.cacheHit) : '未公布'),
            h('span', { key: 'd' }, String(row.output)),
            h('span', { className: 'bln-tag', key: 'e' }, row.verified ? row.source : `${row.source}?`),
          ])),
        ]),
      ])
    }

    function Unavailable({ reason, extra }) {
      return h('div', { className: 'bln-card' }, [
        h('h3', { className: 'bln-h', key: 'h' }, '暂时无法读取统计'),
        h('p', { className: 'bln-muted', key: 'p' }, reason),
        Array.isArray(extra) && extra.length > 0
          ? h('ul', { className: 'bln-list', key: 'x' }, extra.map((line, index) => h('li', { key: index }, line)))
          : null,
      ])
    }

    function BailianPage() {
      const [state, setState] = React.useState({ status: 'loading' })

      React.useEffect(() => {
        let alive = true
        const ctx = clientCtx
        if (ctx === null) {
          setState({ status: 'ready', kind: 'unavailable', reason: 'this page was registered without a client context' })
          return () => { alive = false }
        }
        loadStats(ctx).then((result) => {
          if (alive) setState({ ...result, status: 'ready' })
        }, (error) => {
          if (alive) setState({ status: 'ready', kind: 'unavailable', reason: `loading stats failed: ${error?.message ?? String(error)}` })
        })
        return () => { alive = false }
      }, [])

      if (state.status === 'loading') {
        return h('div', { className: 'bln-page' }, h('p', { className: 'bln-muted' }, '读取统计中…'))
      }
      if (state.kind !== 'ok') {
        return h('div', { className: 'bln-page' }, [
          h('h2', { className: 'bln-h', key: 'h', style: { fontSize: 16 } }, '百炼用量与价格'),
          h(Unavailable, { key: 'u', reason: state.reason, extra: state.extra }),
        ])
      }
      return h('div', { className: 'bln-page' }, [
        h('div', { key: 'head' }, [
          h('h2', { className: 'bln-h', style: { fontSize: 16 } }, '百炼用量与价格'),
          h('p', { className: 'bln-muted', style: { margin: '4px 0 0' } },
            '真实账单（阿里云 ModelStudio 账单接口）与本地价格/缓存口径。连接与模型清单在「设置 → 模型」里编辑。'),
        ]),
        h(HeadCard, { key: 'head-card', overview: state.overview }),
        h(BillingCard, { key: 'billing', billing: state.billing }),
        h(CacheCard, { key: 'cache', prices: state.prices }),
        h(PriceCard, { key: 'prices', prices: state.prices }),
        Array.isArray(state.failures) && state.failures.length > 0
          ? h(Unavailable, { key: 'partial', reason: '部分数据不可用', extra: state.failures })
          : null,
      ])
    }

    return {
      // Every lazily injected service must be declared by name: touching an
      // undeclared one throws `cannot get property "remote.<name>" without
      // inject`. This page reads the provider directory, the route registry and
      // one credential, so all four are listed.
      inject: ['slots', 'remote', 'remote.llm', 'remote.credentials'],
      apply(ctx) {
        // `styles` is a module-loader builtin of this bundle: a plain global in
        // the bundle's own scope, NOT a factory argument. Inserting through it is
        // cleaned up with the client run, so no effect wrapper is needed (and an
        // effect would only add a way for this to silently not run).
        try {
          if (typeof styles !== 'undefined' && styles !== null && typeof styles.insert === 'function') {
            styles.insert(css)
          } else if (typeof document !== 'undefined' && document.head !== null) {
            // Last-resort path if the builtin is absent in some deployment.
            const tag = document.createElement('style')
            tag.setAttribute('data-dsh-plugin', '@local/dsh-llm-bailian-native')
            tag.textContent = css
            document.head.appendChild(tag)
          }
        } catch (error) {
          // Styling must never be able to take the page down.
          console.error('[llm-bailian-native] could not insert the stylesheet', error)
        }
        clientCtx = ctx
        // The settings shell reads `label` for the nav row and `id` as the
        // section key it renders inside the panel content column.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'llm-bailian-native-usage',
          order: 35,
          label: () => '百炼用量与价格',
        }, BailianPage))
      },
    }
  },
})
