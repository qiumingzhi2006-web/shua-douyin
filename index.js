/**
 * shua-douyin —— 给 DSH 的「刷抖音」插件。
 *
 * 能力：扫码登录一个小号 → 在推荐流里刷一圈 → 挑一条没刷过的 → 写一句感想
 *      → 按配置决定是否点赞/收藏/评论 → 把结果留存并回给会话。
 * 频控：生效时间段、每日上限、两轮最小间隔都由配置控制，被拦下时会说明原因。
 *
 * 执行体是同目录的 runner.mjs，跑在独立的 node 进程里（用 ELECTRON_RUN_AS_NODE
 * 复用宿主可执行文件，用户不需要自己装 node），因此 playwright 的行为与命令行一致。
 * 数据都在 ~/.dsh/shua-douyin 下：profile（浏览器登录态）、state.json、journal.jsonl。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'shua-douyin'

/** 等 tools 服务就绪再挂；apply 里还有一层 ctx.inject 兜底 */
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, 'runner.mjs')
const HOME_DIR = process.env.SHUA_DOUYIN_HOME || path.join(os.homedir(), '.dsh', 'shua-douyin')
const CONFIG_FILE = path.join(HOME_DIR, 'config.json')
const JOURNAL_FILE = path.join(HOME_DIR, 'journal.jsonl')
const STATE_FILE = path.join(HOME_DIR, 'state.json')

/** 同一时刻只放一个动作进浏览器：两个进程共用一个 profile 会互相踩 */
let busy = false

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function pad(x) {
  return String(x).padStart(2, '0')
}

function fmtTime(ts) {
  const n = Number(ts)
  if (!n) return '无'
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return String(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function readJournal(limit) {
  try {
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean).reverse()
  } catch {
    return []
  }
}

/** 跑一次 runner.mjs，返回 { ok, result, logs } */
function runRunner(args, timeoutMs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(RUNNER)) {
      resolve({ ok: false, result: { ok: false, error: 'runner.mjs 缺失：' + RUNNER }, logs: '' })
      return
    }
    const env = { ...process.env, SHUA_DOUYIN_HOME: HOME_DIR, ELECTRON_RUN_AS_NODE: '1' }
    let child
    try {
      child = spawn(process.execPath, [RUNNER, ...args], { env, cwd: HERE, windowsHide: true })
    } catch (error) {
      resolve({ ok: false, result: { ok: false, error: '启动失败：' + error.message }, logs: '' })
      return
    }
    let out = ''
    let logs = ''
    let timedOut = false
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { logs += d.toString() })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* 已退出 */ }
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, result: { ok: false, error: error.message }, logs })
    })
    child.on('close', () => {
      clearTimeout(timer)
      let result = null
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith('RESULT:')) {
          try { result = JSON.parse(line.slice(7)) } catch { /* 坏行跳过 */ }
        }
      }
      if (!result) {
        const tail = logs.trim().split(/\r?\n/).slice(-6).join('\n')
        result = { ok: false, error: timedOut ? '执行超时' : '没有拿到结果', detail: tail }
      }
      resolve({ ok: result.ok !== false, result, logs })
    })
  })
}

function guard(fn) {
  return async (args) => {
    if (busy) return { ok: false, message: '上一轮还在跑，等它结束再来（同一个登录态不能开两个窗口）。' }
    busy = true
    try {
      return await fn(args || {})
    } catch (error) {
      return { ok: false, message: '执行异常：' + (error && error.message ? error.message : String(error)) }
    } finally {
      busy = false
    }
  }
}

function setByPath(obj, dotted, value) {
  const parts = String(dotted).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

function tools() {
  return [
    {
      name: 'dy_run',
      description: '让小号在抖音刷一轮：打开推荐流、抓视频卡片、随机挑一条没刷过的、写一句吐槽、'
        + '按配置决定是否点赞/收藏/评论，结果写进本地 journal 并回给会话。'
        + '频控由配置控制（生效时段、每日上限、最小间隔），被拦下时返回跳过原因，不会硬刷。'
        + '只有用户明确要求刷一轮时才调用；force 会跳过最小间隔，但跳不过每日上限与时段。',
      parameters: {
        force: { type: 'boolean', description: '跳过「距上轮不足 N 分钟」的限制；每日上限与时段仍然生效' },
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
      execute: guard(async (args) => {
        const r = await runRunner(args.force === true ? ['--force'] : [], 300000)
        const res = r.result || {}
        if (res.skipped) return { ok: false, message: '这一轮没刷：' + res.skipped }
        if (!r.ok || res.error) {
          return { ok: false, message: '这一轮失败：' + (res.error || '未知原因') + (res.detail ? '\n' + res.detail : '') }
        }
        const it = res.interaction || {}
        const flags = `赞${it.liked ? '✓' : '✗'} 藏${it.collected ? '✓' : '✗'} 评${it.commented ? '✓' : '✗'}`
        const name = String(it.at || '').replace(/^@/, '')
        const atLine = it.at ? `　@${name}${it.mentioned ? '✓' : '（联想没匹配，@ 只作为文字发出）'}` : '　（未设 atHandle，评论不带 @）'
        const why = Object.keys(it.skipped || {}).map((k) => `${k}: ${it.skipped[k]}`).join('；')
        const q = it.quota ? `\n今日互动：赞 ${it.quota.like} · 藏 ${it.quota.collect} · 评 ${it.quota.comment}` : ''
        const maxRounds = Number(res.maxPerDay)
        const rounds = Number.isFinite(maxRounds) && maxRounds < 0
          ? `今日 ${res.count} 条（无上限）`
          : `今日 ${res.count}/${res.maxPerDay}`
        return {
          ok: true,
          message: `刷到一条（本轮候选 ${res.candidates} 条，没看过 ${res.fresh} 条）：\n\n`
            + `「${res.title}」\n→ ${res.feel}\n\n${flags}${atLine}　${rounds}`
            + (it.text ? `\n评论内容：${it.text}` : '')
            + (why ? `\n没做成的：${why}` : '')
            + q,
        }
      }),
    },
    {
      name: 'dy_status',
      description: '检查小号登录态与今日进度（会短暂开一次屏幕外浏览器读 cookie，约 30-60 秒）。'
        + '用户问「小号还能刷吗」「登录掉没掉」「今天刷了几条」时用它。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
      execute: guard(async () => {
        const r = await runRunner(['--status'], 200000)
        const res = r.result || {}
        if (!r.ok && res.error) return { ok: false, message: '读取失败：' + res.error + (res.detail ? '\n' + res.detail : '') }
        return {
          ok: true,
          message: `登录态：${res.loggedIn ? '有效（小号已登录）' : '无效（需要 dy_login 扫码）'}\n`
            + `今日已刷：${res.count} 条　上轮：${fmtTime(res.lastAt)}\n`
            + `已记录看过的：${res.seen || 0} 条　数据目录：${res.home || HOME_DIR}`,
        }
      }),
    },
    {
      name: 'dy_login',
      description: '弹出抖音登录窗口给小号扫码：窗口出现在屏幕左上角，最多等 8 分钟，检测到登录后自动关窗并把登录态存进插件的数据目录。'
        + '仅当 dy_status 报告未登录、或用户要求换号时使用。会占用真实桌面，必须由用户在窗口里亲手扫码。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
      execute: guard(async () => {
        const r = await runRunner(['--login'], 660000)
        const res = r.result || {}
        if (res.loggedIn) return { ok: true, message: '登录成功，登录态已保存。之后可以直接 dy_run。' }
        return {
          ok: false,
          message: '没检测到登录：' + (res.error || '可能错过了扫码（最多等 8 分钟），重新调用一次 dy_login 即可'),
        }
      }),
    },
    {
      name: 'dy_report',
      description: '只读本地文件，秒回：今天刷了几条、最近几次刷到什么、写了什么感想、有没有互动。'
        + '用户问「今天刷了什么」「最近发过啥」时用这个，不要用 dy_status。',
      parameters: {
        limit: { type: 'number', description: '看最近几条，默认 5，最多 20' },
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)
        const cfg = readJson(CONFIG_FILE, {})
        const maxPerDay = Number(cfg.maxPerDay) || 6
        const st = readJson(STATE_FILE, {})
        const today = new Date().toISOString().slice(0, 10)
        const todayCount = st.date === today ? (Number(st.count) || 0) : 0
        const cap = cfg.quota || {}
        const q = st.quota && st.quota.date === today ? st.quota : { like: 0, collect: 0, comment: 0 }
        const atName = String(cfg.atHandle || '').replace(/^@/, '').trim()
        const rows = readJournal(limit)
        // 额度 -1 是「不限」，这里统一成「3（无上限）」这种说法
        const usedText = (used, capValue) => {
          const n = Number(used) || 0
          const c = Number(capValue)
          return Number.isFinite(c) && c < 0 ? `${n}（无上限）` : `${n}/${Number.isFinite(c) ? c : 0}`
        }
        const rounds = Number(maxPerDay) < 0
          ? `今日已刷 ${todayCount} 条（无上限）`
          : `今日已刷 ${todayCount}/${maxPerDay} 条`
        const head = `${rounds}，上轮：${fmtTime(st.lastAt)}，累计记录 ${Array.isArray(st.seen) ? st.seen.length : 0} 条`
          + `\n互动额度：赞 ${usedText(q.like, cap.like)}　藏 ${usedText(q.collect, cap.collect)}　评 ${usedText(q.comment, cap.comment)}`
          + `\n@账号：${atName ? '@' + atName : '未设置（评论不带 @）'}`
        if (rows.length === 0) return { ok: true, message: head + '\n\n还没有任何刷片记录。' }
        const body = rows.map((r, i) => {
          const it = r.interaction || {}
          const flags = `赞${it.liked ? '✓' : '✗'} 藏${it.collected ? '✓' : '✗'} 评${it.commented ? '✓' : '✗'}`
          return `${i + 1}. ${fmtTime(r.ts)} · ${String(r.title || '').slice(0, 60)}\n   → ${String(r.note || '')}（${flags}）`
        }).join('\n')
        return { ok: true, message: `${head}\n\n最近 ${rows.length} 次：\n${body}` }
      },
    },
    {
      name: 'dy_probe',
      description: '诊断用：打开推荐页（屏幕外窗口），返回页面里实际出现的 data-e2e 标记和点赞/收藏/评论/输入框选择器的命中情况。'
        + '当 dy_run 报告「没找到点赞按钮/评论入口/输入框」时用这个，约 30-60 秒。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
      execute: guard(async () => {
        const r = await runRunner(['--probe'], 200000)
        const res = r.result || {}
        if (!r.ok && res.error) return { ok: false, message: '诊断失败：' + res.error }
        const hit = Object.entries(res.hits || {})
          .map(([k, v]) => `${k}：${(v || []).length ? v.join(' / ') : '没命中'}`)
          .join('\n')
        return {
          ok: true,
          message: `登录态：${res.loggedIn ? '有效' : '未登录（先 dy_login）'}\n页面标题：${res.title}\n\n`
            + `选择器命中：\n${hit}\n\n页面里的 data-e2e（前 80 个）：\n${(res.dataE2e || []).join(', ') || '（空）'}`,
        }
      }),
    },
    {
      name: 'dy_config',
      description: '读写这个插件的配置（存在 ~/.dsh/shua-douyin/config.json）：生效时段、每日上限（maxPerDay）、最小间隔、'
        + '是否点赞/收藏/评论（interact.like / .collect / .comment）、每日互动额度（quota.like / .collect / .comment）、'
        + '评论里 @ 的账号（atHandle，填昵称或抖音号，不填就不 @）、评论模板（commentText，支持 {feel} 与 {at} 两个占位）、'
        + '模型 API key 与模型名。'
        + 'action=get 返回全部配置；action=set 需要 key（支持点路径，如 model.apiKey、quota.comment）与 value。'
        + '额度类（quota.like / .collect / .comment、maxPerDay）填 -1 表示不限，不再按天拦截。',
      parameters: {
        action: { type: 'string', description: 'get 或 set' },
        key: { type: 'string', description: 'set 时的配置路径，如 maxPerDay、interact.like、model.apiKey' },
        value: { type: 'string', description: 'set 时的值；能解析成 JSON 就按 JSON 存（true/false/数字），否则按字符串' },
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: v.message }],
      },
      execute: async (args) => {
        const action = String(args.action || 'get').toLowerCase()
        const cfg = readJson(CONFIG_FILE, {})
        if (action !== 'set') {
          return { ok: true, message: '当前配置：\n' + JSON.stringify(cfg, null, 2) + '\n\n数据目录：' + HOME_DIR }
        }
        const key = String(args.key || '').trim()
        if (!key) return { ok: false, message: 'set 需要 key，例如 maxPerDay' }
        let value = args.value
        if (typeof value === 'string') {
          try { value = JSON.parse(value) } catch { /* 当普通字符串 */ }
        }
        setByPath(cfg, key, value)
        try {
          fs.mkdirSync(HOME_DIR, { recursive: true })
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
        } catch (error) {
          return { ok: false, message: '写配置失败：' + error.message }
        }
        return { ok: true, message: `已设置 ${key} = ${JSON.stringify(value)}` }
      },
    },
  ]
}

/* ---------- 设置面板的数据口（client.js 通过 /api/shua-douyin 读写） ---------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
    res.end(body)
}

function collectBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      raw += chunk
      if (raw.length > 200000) {
        done = true
        req.destroy()
        resolve(null)
      }
    })
    req.on('end', () => {
      if (done) return
      done = true
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve(null) }
    })
    req.on('error', () => { if (!done) { done = true; resolve(null) } })
  })
}

/** 只接受面板认识的字段，避免前端传来别的键把配置写脏 */
function sanitizePatch(body) {
  // -1 是「不限」的意思，所以下界是 -1 而不是 0
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= -1 ? Math.round(n) : undefined
  }
  const out = {}
  if (typeof body.atHandle === 'string') out.atHandle = body.atHandle.trim().slice(0, 40)
  if (typeof body.commentText === 'string') out.commentText = body.commentText.slice(0, 200)
  for (const key of ['windowStart', 'windowEnd', 'maxPerDay', 'minGapMin', 'keepSeen', 'mentionWaitMs']) {
    const v = num(body[key])
    if (v !== undefined) out[key] = v
  }
  if (out.windowStart !== undefined) out.windowStart = Math.min(Math.max(out.windowStart, 0), 23)
  if (out.windowEnd !== undefined) out.windowEnd = Math.min(Math.max(out.windowEnd, 0), 24)
  if (out.maxPerDay !== undefined && out.maxPerDay < -1) out.maxPerDay = -1
  if (out.minGapMin !== undefined && out.minGapMin < 0) out.minGapMin = 0
  if (body.interact && typeof body.interact === 'object') {
    out.interact = {
      like: body.interact.like === true,
      collect: body.interact.collect === true,
      comment: body.interact.comment === true,
    }
  }
  if (body.quota && typeof body.quota === 'object') {
    const q = {}
    for (const k of ['like', 'collect', 'comment']) {
      const v = num(body.quota[k])
      if (v !== undefined) q[k] = v
    }
    out.quota = q
  }
  return out
}

async function apiHandler(req, res) {
  let pathname = '/'
  try {
    pathname = (new URL(req.url || '/', 'http://127.0.0.1').pathname || '').replace(/^\/api\/shua-douyin/, '') || '/'
  } catch { /* 保留 '/' */ }

  if (pathname === '/config' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, config: readJson(CONFIG_FILE, {}), home: HOME_DIR })
    return
  }

  if (pathname === '/config' && req.method === 'POST') {
    const body = await collectBody(req)
    if (!body || typeof body !== 'object') {
      sendJson(res, 400, { ok: false, error: '请求体不是 JSON 对象' })
      return
    }
    const patch = sanitizePatch(body)
    const cur = readJson(CONFIG_FILE, {})
    const next = { ...cur }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'interact' || k === 'quota') next[k] = { ...(cur[k] || {}), ...v }
      else next[k] = v
    }
    try {
      fs.mkdirSync(HOME_DIR, { recursive: true })
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
    } catch (error) {
      sendJson(res, 500, { ok: false, error: '写配置失败：' + error.message })
      return
    }
    sendJson(res, 200, { ok: true, config: next })
    return
  }

  if (pathname === '/stats' && req.method === 'GET') {
    const st = readJson(STATE_FILE, {})
    const today = new Date().toISOString().slice(0, 10)
    const quota = st.quota && st.quota.date === today ? st.quota : { like: 0, collect: 0, comment: 0 }
    sendJson(res, 200, {
      ok: true,
      count: st.date === today ? (Number(st.count) || 0) : 0,
      lastAt: Number(st.lastAt) || 0,
      quota,
      recent: readJournal(3),
    })
    return
  }

  sendJson(res, 404, { ok: false, error: 'unknown route: ' + pathname })
}

export function apply(ctx) {
  const specs = tools()
  const registerAll = () => {
    for (const spec of specs) {
      try {
        ctx.tools.register(defineTool(spec))
      } catch (error) {
        const msg = `[shua-douyin] ${spec.name} 注册失败：${error && error.message ? error.message : String(error)}`
        console.error(msg)
        try {
          if (ctx.logger && typeof ctx.logger.error === 'function') ctx.logger.error(msg)
        } catch { /* logger 缺席不影响其他工具 */ }
      }
    }
    console.log('[shua-douyin] 工具已注册：dy_run / dy_status / dy_login / dy_report / dy_probe / dy_config')
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], registerAll)
    } catch {
      /* 老宿主没有 inject 语义，退回同步注册 */
      registerAll()
    }
    // 设置面板的数据口：面板在 client.js，读写的是同一个 config.json
    try {
      ctx.inject(['webServer'], (scoped) => {
        const server = scoped && scoped.webServer
        if (!server || typeof server.register !== 'function') return
        scoped.effect(
          () => server.register({ kind: 'prefix', path: '/api/shua-douyin', handler: apiHandler }),
          'shua-douyin: settings api',
        )
        console.log('[shua-douyin] 设置面板数据口已挂载：/api/shua-douyin')
      })
    } catch (error) {
      console.error('[shua-douyin] 设置面板挂载失败：' + (error && error.message ? error.message : String(error)))
    }
    return
  }
  registerAll()
}
