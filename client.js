/**
 * Client half of shua-douyin: a settings panel in the sidebar.
 *
 * Everything here reads and writes the host-side config through
 * `/api/shua-douyin` (mounted by index.js), so a change made on the panel is the
 * same file `runner.mjs` reads at the start of every round — no restart needed.
 *
 * The panel only exposes "what is it allowed to do": interaction switches, daily
 * quotas, cadence, active hours, and who gets @-mentioned.
 */
window.__ModuleLoader__.load({
  id: 'shua-douyin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'shua-douyin'
    const PANEL_ID = 'shua-douyin-settings'

    const ZH = {
      panel: '刷抖音',
      title: '刷抖音 · 设置',
      lead: '改完直接写进本机配置，下一轮就生效。这里管的是「允许它做多少」，不是让它去刷量。',
      interact: '互动',
      like: '点赞',
      collect: '收藏',
      comment: '评论',
      quotaLike: '每日点赞额度',
      quotaCollect: '每日收藏额度',
      quotaComment: '每日评论额度',
      pick: '刷片',
      maxPerDay: '每天最多刷几条',
      minGap: '两轮至少隔多少分钟',
      windowStart: '几点开始',
      windowEnd: '几点停',
      atTitle: '@ 与文案',
      atHandle: '评论里 @ 谁',
      atHandleHint: '抖音昵称或抖音号，带不带 @ 都认；留空就是不 @',
      commentText: '评论模板',
      commentTextHint: '{feel} 换成本轮感想，{at} 换成上面那个账号',
      today: '今日',
      usedLike: '赞 {n}/{cap}',
      usedCollect: '藏 {n}/{cap}',
      usedComment: '评 {n}/{cap}',
      round: '已刷 {n}/{cap} 条',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败：{msg}',
      loadFailed: '读不到配置：{msg}',
      reload: '重新读取',
      backendMissing: '面板通过 /api/shua-douyin 读写配置；宿主没提供数据口时只能看不能存。',
      loading: '正在读取配置…',
      on: '开',
      off: '关',
      unlimited: '无上限',
    }

    const EN = {
      panel: 'Douyin',
      title: 'Douyin feed runner · settings',
      lead: 'Saved straight into the local config file, effective from the next round. These bounds say how much it may do, not how much to farm.',
      interact: 'Interactions',
      like: 'Like',
      collect: 'Collect',
      comment: 'Comment',
      quotaLike: 'Daily like quota',
      quotaCollect: 'Daily collect quota',
      quotaComment: 'Daily comment quota',
      pick: 'Feed',
      maxPerDay: 'Rounds per day',
      minGap: 'Minutes between rounds',
      windowStart: 'Start hour',
      windowEnd: 'Stop hour',
      atTitle: '@ and wording',
      atHandle: 'Mention in comments',
      atHandleHint: 'Douyin nickname or ID, with or without a leading @; empty means no mention',
      commentText: 'Comment template',
      commentTextHint: '{feel} becomes the reaction, {at} becomes the handle above',
      today: 'Today',
      usedLike: 'like {n}/{cap}',
      usedCollect: 'collect {n}/{cap}',
      usedComment: 'comment {n}/{cap}',
      round: '{n}/{cap} rounds',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      failed: 'Save failed: {msg}',
      loadFailed: 'Cannot read the config: {msg}',
      reload: 'Reload',
      backendMissing: 'The panel reads and writes through /api/shua-douyin; without that route it can only display.',
      loading: 'Reading the config…',
      on: 'On',
      off: 'Off',
      unlimited: 'No limit',
    }

    const STYLES = `
.sdPage{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.sdBodies{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.sdColumn{display:flex;flex-direction:column;box-sizing:border-box;width:100%;max-width:720px;min-height:100%;margin:0 auto;padding:0 clamp(20px,4vw,40px) 28px;gap:16px}
.sdHeading{padding-top:26px;margin:0}
.sdHeading h1{margin:0;font-size:20px;line-height:28px;font-weight:500}
.sdLead{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.sdCard{border:0.5px solid var(--dsw-alias-border-l3);border-radius:16px;padding:6px 16px;background:var(--dsw-alias-bg-layer-1)}
.sdCardTitle{margin:12px 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.sdRow{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:11px 0;border-top:0.5px solid var(--dsw-alias-border-l1)}
.sdRowLabel{display:flex;flex-direction:column;gap:2px;min-width:0}
.sdRowLabel > span:first-child{font-size:14px}
.sdHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.sdRowControl{display:flex;align-items:center;gap:10px;flex:none}
.sdSwitch{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 10px 0 6px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.sdSwitch:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sdSwitchOn{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}
.sdKnob{width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-border-l2);transition:background .15s}
.sdSwitchOn .sdKnob{background:var(--dsw-alias-state-business-primary)}
.sdSlider{display:flex;align-items:center;gap:10px}
.sdSlider input[type=range]{width:150px;accent-color:var(--dsw-alias-state-business-primary)}
.sdValue{min-width:44px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:13px}
.sdNumber{width:64px;height:26px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:13px}
.sdText{width:100%;max-width:320px;height:28px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:13px}
.sdText:focus,.sdNumber:focus{border-color:var(--dsw-alias-state-business-primary);outline:0}
.sdFooter{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:2px 0 8px}
.sdStats{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.sdActions{display:flex;align-items:center;gap:10px;margin-left:auto}
.sdButton{height:30px;padding:0 16px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:15px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.sdButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sdButtonPrimary{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,transparent);background:var(--dsw-alias-state-business-primary);color:#fff}
.sdButtonPrimary:hover:not(:disabled){filter:brightness(1.05);color:#fff}
.sdButton:disabled{opacity:.55;cursor:default}
.sdError{margin:0;padding:10px 14px;border-radius:12px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary);font-size:13px}
@media (max-width:640px){.sdColumn{padding-inline:16px}.sdSlider input[type=range]{width:110px}}
`

    const API = (() => {
      try { return new URL('api/shua-douyin', document.baseURI).pathname } catch { return '/api/shua-douyin' }
    })()

    async function api(path, options) {
      const { timeout = 8000, ...rest } = options || {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'sdRow' },
        h('div', { className: 'sdRowLabel' },
          h('span', null, label),
          hint ? h('span', { className: 'sdHint' }, hint) : null),
        h('div', { className: 'sdRowControl' }, children))
    }

    function Switch({ checked, onChange, t }) {
      return h('button', {
        type: 'button',
        className: checked ? 'sdSwitch sdSwitchOn' : 'sdSwitch',
        'aria-pressed': checked ? 'true' : 'false',
        onClick: () => onChange(!checked),
        key: 'sw',
      },
      h('span', { className: 'sdKnob', 'aria-hidden': 'true' }),
      h('span', null, checked ? t('on') : t('off')))
    }

    function Slider({ value, min, max, step, onChange, t }) {
      const shown = Number.isFinite(Number(value)) ? Number(value) : 0
      return h('div', { className: 'sdSlider' },
        h('input', {
          type: 'range', min, max, step, value: shown,
          onChange: (event) => onChange(Number(event.target.value)),
        }),
        h('span', { className: 'sdValue' }, shown < 0 ? (t ? t('unlimited') : '∞') : String(shown)))
    }

    function SettingsPage({ t }) {
      const [cfg, setCfg] = React.useState(null)
      const [stats, setStats] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(() => {
        api('/config')
          .then((payload) => { setCfg(payload.config || {}); setError(null) })
          .catch((e) => setError(e.message))
        api('/stats').then((payload) => { setStats(payload) }).catch(() => {})
      }, [])

      React.useEffect(() => { load() }, [load])

      React.useEffect(() => {
        if (!notice) return undefined
        const timer = window.setTimeout(() => setNotice(null), 2200)
        return () => window.clearTimeout(timer)
      }, [notice])

      const merge = (next) => setCfg((cur) => ({ ...cur, ...next }))
      const mergeInner = (key, next) => setCfg((cur) => ({ ...cur, [key]: { ...((cur && cur[key]) || {}), ...next } }))

      const save = () => {
        if (!cfg) return
        setBusy(true)
        api('/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cfg),
        })
          .then((payload) => { setCfg(payload.config || cfg); setNotice('saved'); load() })
          .catch((e) => setNotice('failed:' + e.message))
          .finally(() => setBusy(false))
      }

      const shell = (children) => h('section', { className: 'sdPage', 'aria-label': t('title') },
        h('div', { className: 'sdBodies' },
          h('div', { className: 'sdColumn' }, children)))

      const heading = h('div', { className: 'sdHeading', key: 'heading' },
        h('h1', null, t('title')),
        h('p', { className: 'sdLead' }, t('lead')))

      const reloadButton = h('button', {
        type: 'button', className: 'sdButton', onClick: load, key: 'reload',
      }, t('reload'))

      if (!cfg) {
        const children = [heading]
        if (error) {
          children.push(h('p', { className: 'sdError', key: 'error' }, t('loadFailed', { msg: error })))
          children.push(h('p', { className: 'sdHint', key: 'hint' }, t('backendMissing')))
        }
        children.push(h('div', { className: 'sdFooter', key: 'footer' },
          h('p', { className: 'sdStats' }, error ? null : t('loading')),
          h('div', { className: 'sdActions' }, reloadButton)))
        return shell(children)
      }

      const interact = cfg.interact || {}
      const quota = cfg.quota || {}
      const used = (stats && stats.quota) || { like: 0, collect: 0, comment: 0 }
      // 额度 -1 在面板里显示成「无上限」，不要让人看到「3/-1」
      const capLabel = (capValue) => {
        const c = Number(capValue)
        return Number.isFinite(c) && c < 0 ? t('unlimited') : String(Number.isFinite(c) ? c : 0)
      }

      const noticeText = notice === 'saved'
        ? t('saved')
        : notice && notice.startsWith('failed:') ? t('failed', { msg: notice.slice(7) }) : null

      const interactCard = h('div', { className: 'sdCard', key: 'interact' },
        h('p', { className: 'sdCardTitle' }, t('interact')),
        h(Row, { key: 'like', label: t('like') },
          h(Switch, { checked: interact.like === true, onChange: (v) => mergeInner('interact', { like: v }), t })),
        h(Row, { key: 'collect', label: t('collect') },
          h(Switch, { checked: interact.collect === true, onChange: (v) => mergeInner('interact', { collect: v }), t })),
        h(Row, { key: 'comment', label: t('comment') },
          h(Switch, { checked: interact.comment === true, onChange: (v) => mergeInner('interact', { comment: v }), t })),
        h(Row, { key: 'ql', label: t('quotaLike'), hint: t('usedLike', { n: used.like || 0, cap: capLabel(quota.like) }) },
          h(Slider, { value: quota.like, min: -1, max: 20, step: 1, t, onChange: (v) => mergeInner('quota', { like: v }) })),
        h(Row, { key: 'qc', label: t('quotaCollect'), hint: t('usedCollect', { n: used.collect || 0, cap: capLabel(quota.collect) }) },
          h(Slider, { value: quota.collect, min: -1, max: 20, step: 1, t, onChange: (v) => mergeInner('quota', { collect: v }) })),
        h(Row, { key: 'qm', label: t('quotaComment'), hint: t('usedComment', { n: used.comment || 0, cap: capLabel(quota.comment) }) },
          h(Slider, { value: quota.comment, min: -1, max: 20, step: 1, t, onChange: (v) => mergeInner('quota', { comment: v }) })))

      const feedCard = h('div', { className: 'sdCard', key: 'feed' },
        h('p', { className: 'sdCardTitle' }, t('pick')),
        h(Row, { key: 'max', label: t('maxPerDay'), hint: stats ? t('round', { n: stats.count || 0, cap: capLabel(cfg.maxPerDay) }) : null },
          h(Slider, { value: cfg.maxPerDay, min: -1, max: 30, step: 1, t, onChange: (v) => merge({ maxPerDay: v }) })),
        h(Row, { key: 'gap', label: t('minGap') },
          h(Slider, { value: cfg.minGapMin, min: 0, max: 240, step: 5, t, onChange: (v) => merge({ minGapMin: v }) })),
        h(Row, { key: 'start', label: t('windowStart') },
          h('input', {
            className: 'sdNumber', type: 'number', min: 0, max: 23, step: 1,
            value: cfg.windowStart === undefined ? 9 : cfg.windowStart,
            onChange: (event) => merge({ windowStart: Number(event.target.value) }),
          })),
        h(Row, { key: 'end', label: t('windowEnd') },
          h('input', {
            className: 'sdNumber', type: 'number', min: 0, max: 24, step: 1,
            value: cfg.windowEnd === undefined ? 22 : cfg.windowEnd,
            onChange: (event) => merge({ windowEnd: Number(event.target.value) }),
          })))

      const atCard = h('div', { className: 'sdCard', key: 'at' },
        h('p', { className: 'sdCardTitle' }, t('atTitle')),
        h(Row, { key: 'handle', label: t('atHandle'), hint: t('atHandleHint') },
          h('input', {
            className: 'sdText', type: 'text', placeholder: '@大肥鱼',
            value: cfg.atHandle || '',
            onChange: (event) => merge({ atHandle: event.target.value }),
          })),
        h(Row, { key: 'tpl', label: t('commentText'), hint: t('commentTextHint') },
          h('input', {
            className: 'sdText', type: 'text', placeholder: '{feel} {at}',
            value: cfg.commentText || '',
            onChange: (event) => merge({ commentText: event.target.value }),
          })))

      const statsLine = stats
        ? t('today') + '：' + t('usedLike', { n: used.like || 0, cap: capLabel(quota.like) })
          + ' · ' + t('usedCollect', { n: used.collect || 0, cap: capLabel(quota.collect) })
          + ' · ' + t('usedComment', { n: used.comment || 0, cap: capLabel(quota.comment) })
        : ''

      const footer = h('div', { className: 'sdFooter', key: 'footer' },
        h('p', { className: 'sdStats', key: 'stats' },
          h('span', null, statsLine),
          noticeText ? h('span', { role: 'status' }, noticeText) : null),
        h('div', { className: 'sdActions', key: 'actions' },
          reloadButton,
          h('button', {
            type: 'button', className: 'sdButton sdButtonPrimary', disabled: busy, onClick: save, key: 'save',
          }, busy ? t('saving') : t('save'))))

      return shell([heading, interactCard, feedCard, atCard, footer])
    }

    function PanelIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
      },
      h('path', {
        d: 'M9 4.5v12.2a2.8 2.8 0 1 1-2.2-2.74',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M9 6.2l9-1.8v9.6a2.8 2.8 0 1 1-2.2-2.74',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function insertStyles(css) {
      const element = document.createElement('style')
      element.setAttribute('data-shua-douyin-styles', '')
      element.textContent = css
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'shua-douyin: dictionaries')
        ctx.effect(() => insertStyles(STYLES), 'shua-douyin: styles')
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, SettingsPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => t('panel'),
        }, PanelIcon))
      },
    }
  },
})
