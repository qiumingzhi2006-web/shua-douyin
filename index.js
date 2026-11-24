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
        return {
          ok: true,
          message: `刷到一条（本轮候选 ${res.candidates} 条，没看过 ${res.fresh} 条）：\n\n`
            + `「${res.title}」\n→ ${res.feel}\n\n${flags}　今日 ${res.count}/${res.maxPerDay}`,
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
        const rows = readJournal(limit)
        const head = `今日已刷 ${todayCount}/${maxPerDay} 条，上轮：${fmtTime(st.lastAt)}，累计记录 ${Array.isArray(st.seen) ? st.seen.length : 0} 条`
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
      name: 'dy_config',
      description: '读写这个插件的配置（存在 ~/.dsh/shua-douyin/config.json）：生效时段、每日上限、最小间隔、'
        + '是否点赞/收藏/评论、评论内容、模型 API key 与模型名。'
        + 'action=get 返回全部配置；action=set 需要 key（支持点路径，如 model.apiKey）与 value。',
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
    console.log('[shua-douyin] 工具已注册：dy_run / dy_status / dy_login / dy_report / dy_config')
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], registerAll)
      return
    } catch {
      /* 老宿主没有 inject 语义，退回同步注册 */
    }
  }
  registerAll()
}
