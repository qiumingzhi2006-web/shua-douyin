#!/usr/bin/env node
/**
 * shua-douyin 的执行体：在独立 node 进程里跑（不跑在 DSH 的 Electron 主进程里），
 * 这样 playwright 与系统 Edge 的行为与普通命令行脚本一致。
 *
 * 用法：
 *   node runner.mjs --login    打开窗口扫码，最多等 8 分钟
 *   node runner.mjs --status   只读登录态
 *   node runner.mjs            刷一轮（受窗口时间/每日上限/最小间隔频控）
 *   node runner.mjs --config   打印当前配置
 *
 * 与上一代 qq-douyin-alt.js 的差别：
 *   - 不再写死任何人的路径：数据落在 $SHUA_DOUYIN_HOME（默认 ~/.dsh/shua-douyin）
 *   - 不再依赖 NapCat/OneBot 或某个特定模型：结果写到 journal 并回给调用方
 *   - 互动（点赞/收藏/评论）默认全关，由配置显式打开
 *   - 结果以 RESULT:{...} 一行输出，其余都是日志
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HOME = process.env.SHUA_DOUYIN_HOME || path.join(os.homedir(), '.dsh', 'shua-douyin')
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROFILE_DIR = path.join(HOME, 'profile')
const STATE_FILE = path.join(HOME, 'state.json')
const JOURNAL_FILE = path.join(HOME, 'journal.jsonl')
const CONFIG_FILE = path.join(HOME, 'config.json')
const LOG_FILE = path.join(HOME, 'run.log')

const DEFAULTS = {
  browserChannel: 'msedge',
  feedUrl: 'https://www.douyin.com/jingxuan',
  windowStart: 9,
  windowEnd: 22,
  maxPerDay: 6,
  minGapMin: 45,
  keepSeen: 200,
  interact: { like: false, collect: false, comment: false },
  quota: { like: 6, collect: 4, comment: 3 },
  commentText: '{feel} {at}',
  atHandle: '',
  mentionWaitMs: 1500,
  hearVideo: false,
  earRunner: '',
  model: {
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4.5-flash',
    persona: '你是「肥鱼」，一条爱吃白饭的蓝色大肥鱼。说话短句口语，不用敬语，软萌爱摸鱼，只吐槽事情不吐槽人。',
  },
}

const FALLBACK_LINES = [
  '这条先记着，回头细看。',
  '刷到的，有点意思。',
  '留个记号，慢慢看。',
  '今天先看这些。',
]

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true })
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch { /* 日志不影响主流程 */ }
  process.stderr.write(line + '\n')
}

function emit(obj) {
  process.stdout.write('RESULT:' + JSON.stringify(obj) + '\n')
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function loadConfig() {
  const raw = readJson(CONFIG_FILE, {})
  return {
    ...DEFAULTS,
    ...raw,
    interact: { ...DEFAULTS.interact, ...(raw.interact || {}) },
    model: { ...DEFAULTS.model, ...(raw.model || {}) },
  }
}

function loadState() {
  const st = readJson(STATE_FILE, null)
  const base = { date: '', count: 0, lastAt: 0, seen: [], quota: { date: '', like: 0, collect: 0, comment: 0 } }
  if (!st || typeof st !== 'object') return base
  const q = st.quota && typeof st.quota === 'object' ? st.quota : {}
  return {
    date: st.date || '',
    count: Number(st.count) || 0,
    lastAt: Number(st.lastAt) || 0,
    seen: Array.isArray(st.seen) ? st.seen : [],
    quota: { date: q.date || '', like: Number(q.like) || 0, collect: Number(q.collect) || 0, comment: Number(q.comment) || 0 },
  }
}

function saveState(st) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8') } catch (e) { log('状态写入失败: ' + e.message) }
}

function appendJournal(entry) {
  try { fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n') } catch { /* 忽略 */ }
}

let UI_MODE = false

async function openBrowser({ interactive }) {
  const cfg = loadConfig()
  ensureHome()
  const args = ['--disable-blink-features=AutomationControlled']
  if (interactive) {
    args.push('--window-position=120,60', '--window-size=1200,820')
  } else {
    args.push('--window-position=-32000,-32000', '--window-size=1280,800')
  }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: cfg.browserChannel,
    headless: false,
    viewport: { width: 1200, height: 800 },
    locale: 'zh-CN',
    args,
  })
  const page = ctx.pages()[0] || (await ctx.newPage())
  try { await page.bringToFront() } catch { /* 后台窗口没有前台语义 */ }
  return { ctx, page, cfg }
}

async function isLoggedIn(ctx) {
  const cookies = await ctx.cookies()
  return cookies.some((c) => ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'].includes(c.name) && c.value && c.value.length > 8)
}

async function doLogin() {
  const { ctx, page } = await openBrowser({ interactive: true })
  let ok = false
  try {
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {})
    log('登录窗口已打开，请扫码登录小号（最多等 8 分钟）')
    const deadline = Date.now() + 8 * 60 * 1000
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000)
      if (await isLoggedIn(ctx)) { ok = true; break }
    }
  } finally {
    await ctx.close()
  }
  log(ok ? '登录成功，登录态已保存' : '超时未检测到登录')
  emit({ ok, loggedIn: ok })
}

async function doStatus() {
  const st = loadState()
  let loggedIn = false
  try {
    const { ctx } = await openBrowser({ interactive: false })
    try { loggedIn = await isLoggedIn(ctx) } finally { await ctx.close() }
  } catch (e) {
    log('读取登录态失败: ' + e.message)
  }
  const today = new Date().toISOString().slice(0, 10)
  emit({
    ok: true,
    loggedIn,
    count: st.date === today ? st.count : 0,
    lastAt: st.lastAt,
    seen: st.seen.length,
    home: HOME,
  })
}

async function readFeed(page, feedUrl) {
  await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(6000)
  const title = await page.title()
  if (title.includes('验证码')) throw new Error('撞到验证码中间页，先人工过一次')
  const cards = new Map()
  for (let round = 0; round < 4; round++) {
    await page.mouse.wheel(0, 900)
    await page.waitForTimeout(2200)
    const batch = await page.evaluate(() => {
      const out = []
      for (const el of Array.from(document.querySelectorAll('[data-aweme-id]'))) {
        const id = el.getAttribute('data-aweme-id') || ''
        if (!/^\d{15,}$/.test(id)) continue
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
        if (t.length < 8) continue
        out.push({ id, title: t.slice(0, 160) })
      }
      return out.slice(0, 40)
    })
    for (const c of batch) if (!cards.has(c.id)) cards.set(c.id, c)
  }
  return [...cards.values()]
}

/** 把视频的音频直链交给「机器人耳朵」转成文字；没装耳朵时返回空串，不影响原来的一轮 */
async function transcribeAudio(cfg, url) {
  if (!url) return ''
  const ear = String(cfg.earRunner || '').trim() || path.join(SELF_DIR, '..', 'dsh-robot-ear', 'runner.mjs')
  if (!fs.existsSync(ear)) {
    log('耳朵不在预期位置：' + ear + '（可在配置 earRunner 里指过去）')
    return ''
  }
  log('把音频交给耳朵：' + url.slice(0, 90))
  return await new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(process.execPath, [ear, '--run', url], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
    } catch (e) {
      log('启动耳朵失败：' + (e && e.message ? e.message : e))
      resolve('')
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 10 * 60 * 1000)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { log('[ear] ' + d.toString().trim().slice(0, 120)) })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT:'))
      if (!line) { log('耳朵没给结果'); resolve(''); return }
      try {
        const r = JSON.parse(line.slice('RESULT:'.length))
        if (!r.ok) { log('耳朵转写失败：' + (r.error || '')); resolve(''); return }
        resolve(String(r.text || ''))
      } catch { resolve('') }
    })
  })
}

/** 没有模型时的兜底：从听来的口播里摘一句最像主题的，让评论真的跟内容有关 */
function pickTranscriptLine(src) {
  const marker = '（它自己口播的内容，供参考）'
  const at = String(src || '').indexOf(marker)
  if (at < 0) return ''
  const body = src.slice(at + marker.length).replace(/\s+/g, ' ')
  const parts = body.split(/[。！？!?；;，,]/).map((s) => s.trim())
    .filter((s) => s.length >= 10 && s.length <= 34 && !/我的心里|感谢观看/.test(s))
  if (!parts.length && body.length >= 12) {
    // whisper 的中文常常一个标点都不给：退化成取中段一段话，总比空着强
    const mid = Math.floor(body.length / 2)
    const seg = body.slice(Math.max(0, mid - 12), Math.min(body.length, mid + 12)).trim()
    if (seg.length >= 8) parts.push(seg)
  }
  if (!parts.length) return ''
  return parts[Math.floor(parts.length / 2)].replace(/["'“”「」]/g, '').slice(0, 34)
}

async function generateFeel(cfg, text) {
  const apiKey = cfg.model.apiKey || process.env.SHUA_DOUYIN_API_KEY || ''
  if (!apiKey) {
    const quoted = pickTranscriptLine(text)
    if (quoted) return `听到「${quoted}」，这句我记下了`
    return FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)]
  }
  const body = {
    model: cfg.model.model,
    messages: [
      { role: 'system', content: cfg.model.persona },
      { role: 'user', content: `你刚刷到这一条：${text}\n用一句自己的话吐槽或感慨，40 字以内，口语，不要 emoji、不要引号、不要解释。` },
    ],
    max_tokens: 700,
  }
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(cfg.model.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      })
      const txt = await r.text()
      let parsed = null
      try { parsed = JSON.parse(txt) } catch { parsed = null }
      if (!parsed || !parsed.choices || !parsed.choices[0]) throw new Error('模型返回异常: ' + txt.slice(0, 120))
      let out = String(parsed.choices[0].message.content || '').replace(/["'“”]/g, '').replace(/\s+/g, ' ').trim()
      if (!out) continue
      const stop = out.search(/[。！？!?]/)
      if (stop > 0) out = out.slice(0, stop)
      if (Array.from(out).length > 50) out = Array.from(out).slice(0, 49).join('') + '…'
      return out
    } catch (e) {
      log(`模型尝试 ${i + 1} 失败: ${e.message}`)
    }
  }
  return FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)]
}

/* ---------- 互动：点赞 / 收藏 / 评论（含 @ 提及） ---------- */

const SEL = {
  like: ['[data-e2e="video-player-digg"]', '[data-e2e="feed-like"]', '[data-e2e="like-icon"]', '[data-e2e="digg-icon"]'],
  collect: ['[data-e2e="video-player-collect"]', '[data-e2e="feed-collect"]', '[data-e2e="collect-icon"]'],
  comment: ['[data-e2e="feed-comment-icon"]', '[data-e2e="video-player-comment"]', '[data-e2e="feed-comment"]', '[data-e2e="comment-icon"]'],
  commentBox: ['div[role="textbox"]', '[contenteditable]', 'input[placeholder*="精彩评论"]', 'input[placeholder*="评论"]', '[data-e2e="comment-input"]', 'div[contenteditable="true"]', 'textarea'],
  publish: ['[data-e2e="comment-publish"]', '[data-e2e="comment-publish-btn"]', 'button:has-text("发送")', 'button:has-text("发布")'],
  atItem: ['[data-e2e="comment-at-item"]', '[role="option"]', '[class*="at-list"] li', '[class*="suggest"] li'],
}

/** 额度用 -1 表示不限；其余按整数天计数 */
function quotaCap(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return n < 0 ? -1 : Math.round(n)
}

function overQuota(used, cap) {
  return cap < 0 ? false : used >= cap
}

function quotaText(used, cap) {
  return cap < 0 ? `${used}（无上限）` : `${used}/${cap}`
}

function normalizeHandle(h) {
  const s = String(h || '').trim()
  if (!s) return ''
  return s.startsWith('@') ? s : '@' + s
}

/** 评论内容：模板里 {feel} 换成感想，{at} 换成 @账号 */
function buildComment(cfg, feel) {
  const at = normalizeHandle(cfg.atHandle)
  const tpl = String(cfg.commentText || '').trim() || '{feel} {at}'
  const text = tpl.replace(/\{feel\}/g, feel || '').replace(/\{at\}/g, at).replace(/\s+/g, ' ').trim()
  return { text, at }
}

/** 先按 data-e2e/结构化选择器点，再退回按文字点，返回 { ok, already, via } */
async function clickAny(page, selectors, texts) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first()
      if (!(await el.count())) continue
      if (!(await el.isVisible().catch(() => false))) continue
      const pressed = await el.getAttribute('aria-pressed').catch(() => null)
      if (pressed === 'true') return { ok: true, already: true, via: sel }
      await el.click({ timeout: 3000 })
      return { ok: true, via: sel }
    } catch { /* 换下一个选择器 */ }
  }
  const hit = await page.evaluate((words) => {
    for (const el of Array.from(document.querySelectorAll('span, div, button'))) {
      if (!el.offsetParent) continue
      const t = (el.textContent || '').trim()
      if (words.includes(t)) { el.click(); return t }
    }
    return ''
  }, texts || []).catch(() => '')
  return hit ? { ok: true, via: 'text:' + hit } : { ok: false, via: '' }
}

/** @ 之后在联想候选里挑同名项；挑不到就保留纯文本 */
async function pickAt(page, at, waitMs) {
  const name = at.replace(/^@/, '').trim()
  if (!name) return false
  await page.waitForTimeout(waitMs)
  for (const sel of SEL.atItem) {
    try {
      const items = page.locator(sel)
      const n = await items.count()
      for (let i = 0; i < Math.min(n, 8); i++) {
        const it = items.nth(i)
        if (!(await it.isVisible().catch(() => false))) continue
        const t = (await it.innerText().catch(() => '')) || ''
        if (t.includes(name)) { await it.click({ timeout: 3000 }); return true }
      }
    } catch { /* 换下一个选择器 */ }
  }
  return false
}

/** 详情页视频下方那排图标（点赞/评论/收藏/分享）在桌面版没有 data-e2e，只能按几何位置找 */
async function bottomIcons(page) {
  return page.evaluate(() => {
    const v = document.querySelector('video')
    if (!v) return []
    const vr = v.getBoundingClientRect()
    const out = []
    for (const el of Array.from(document.querySelectorAll('svg'))) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      if (r.y < vr.bottom + 40 || r.y > vr.bottom + 200) continue
      if (r.x < vr.left - 40 || r.x > vr.left + 600) continue
      out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })
    }
    const groups = []
    for (const it of out.sort((a, b) => a.x - b.x)) {
      const g = groups[groups.length - 1]
      if (g && Math.abs(it.x - g.x) < 12) continue
      groups.push(it)
    }
    return groups.map((it) => ({ cx: it.x + it.w / 2, cy: it.y + it.h / 2 }))
  }).catch(() => [])
}

/** 心形是否已点亮（抖音红 #FE2C55） */
async function likedState(page, pt) {
  if (!pt) return null
  return page.evaluate((p) => {
    const el = document.elementFromPoint(p.cx, p.cy)
    if (!el) return null
    const svg = el.tagName === 'svg' ? el : el.closest('svg')
    if (!svg) return null
    const styles = Array.from(svg.querySelectorAll('path, use, g, circle')).map((n) => {
      const s = getComputedStyle(n)
      return (s.fill || '') + '|' + (s.stroke || '')
    }).join(';')
    return /254,\s*44,\s*85|fe2c55/i.test(styles)
  }, pt)
}

/** 抖音评论框是"点一下占位文字才激活"，先找到那句占位提示点进去 */
async function openCommentBox(page) {
  const pt = await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('div, span, p, label')) ) {
      if (!el.offsetParent) continue
      const t = (el.textContent || '').trim()
      if (t.length > 20) continue
      if (!/留下你的精彩评论吧|精彩评论|说点什么|善语结善缘/.test(t)) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      return { cx: Math.round(r.x + Math.min(r.width / 2, 120)), cy: Math.round(r.y + r.height / 2) }
    }
    return null
  }).catch(() => null)
  if (!pt) return false
  await page.mouse.click(pt.cx, pt.cy).catch(() => {})
  await page.waitForTimeout(1500)
  return true
}

/** 评论框右侧那颗红色发送按钮（Draft.js，回车是换行不发） */
async function sendComment(page) {
  const pt = await page.evaluate(() => {
    const box = document.querySelector('div[role="textbox"]') || document.querySelector('[contenteditable]')
    if (!box) return null
    const br = box.getBoundingClientRect()
    const cands = []
    for (const el of Array.from(document.querySelectorAll('div, span, button'))) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      if (r.width > 60 || r.height > 60) continue // 发送按钮是小圆点，排除大容器
      if (r.y < br.y - 12 || r.y > br.y + br.height + 12) continue
      if (r.x < br.x + 200 || r.x > br.right + 130) continue
      const bg = getComputedStyle(el).backgroundColor || ''
      cands.push({ cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), bg, x: Math.round(r.x) })
    }
    const red = cands.find((c) => /254,\s*44,\s*85|254,\s*44,\s*84|fe2c55/i.test(c.bg))
    if (red) return { cx: red.cx, cy: red.cy, why: 'red' }
    cands.sort((a, b) => b.x - a.x)
    return cands[0] ? { cx: cands[0].cx, cy: cands[0].cy, why: 'rightmost:' + cands[0].bg } : null
  }).catch(() => null)
  if (!pt) return false
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(400)
  await page.mouse.click(pt.cx, pt.cy).catch(() => {})
  await page.waitForTimeout(2000)
  return pt.why
}

async function interact(cfg, page, st, feel) {
  const today = new Date().toISOString().slice(0, 10)
  if (!st.quota || st.quota.date !== today) st.quota = { date: today, like: 0, collect: 0, comment: 0 }

  const cap = cfg.quota || {}
  const result = {
    liked: false, collected: false, commented: false, mentioned: false,
    at: normalizeHandle(cfg.atHandle),
    via: {}, skipped: {},
    quota: { ...st.quota },
  }

  if (!cfg.interact.like && !cfg.interact.collect && !cfg.interact.comment) return result
  await page.waitForTimeout(1500)
  const bar = await bottomIcons(page)
  if (bar.length) result.via.bar = `${bar.length} 个图标（y=${bar[0].cy}）`

  if (cfg.interact.like) {
    const max = quotaCap(cap.like)
    if (overQuota(st.quota.like, max)) result.skipped.like = `今日点赞额度用完（${quotaText(st.quota.like, max)}）`
    else {
      let r = { ok: false, via: '', already: false }
      const pt = bar[0]
      if (pt) {
        const already = await likedState(page, pt)
        if (already === true) r = { ok: true, already: true, via: 'bar:红心本来就亮着' }
        else {
          await page.mouse.click(pt.cx, pt.cy).catch(() => {})
          await page.waitForTimeout(1400)
          const now = await likedState(page, pt)
          r = now === false ? { ok: false, via: 'bar:点了仍是灰心' } : { ok: true, via: 'bar:红心亮起', already: false }
        }
      }
      if (!r.ok) r = await clickAny(page, SEL.like, ['点赞', '赞'])
      if (r.ok) {
        result.liked = true
        result.via.like = r.via
        if (!r.already) st.quota.like += 1
        await page.waitForTimeout(900)
      } else result.skipped.like = '没找到点赞按钮（' + (r.via || '页面结构可能变了，可跑 --probe 看') + '）'
    }
  }

  if (cfg.interact.collect) {
    const max = quotaCap(cap.collect)
    if (overQuota(st.quota.collect, max)) result.skipped.collect = `今日收藏额度用完（${quotaText(st.quota.collect, max)}）`
    else {
      let r = { ok: false, via: '' }
      const pt = bar[2]
      if (pt) {
        await page.mouse.click(pt.cx, pt.cy).catch(() => {})
        await page.waitForTimeout(1200)
        r = { ok: true, via: 'bar:第3个图标' }
      }
      if (!r.ok) r = await clickAny(page, SEL.collect, ['收藏'])
      if (r.ok) {
        result.collected = true
        result.via.collect = r.via
        if (!r.already) st.quota.collect += 1
        await page.waitForTimeout(900)
      } else result.skipped.collect = '没找到收藏按钮'
    }
  }

  if (cfg.interact.comment) {
    const max = quotaCap(cap.comment)
    const built = buildComment(cfg, feel)
    if (overQuota(st.quota.comment, max)) result.skipped.comment = `今日评论额度用完（${quotaText(st.quota.comment, max)}）`
    else if (!built.text) result.skipped.comment = '评论内容为空（commentText 与 feel 都没东西）'
    else {
      try {
        let opened = { ok: false, via: '' }
        if (bar[1]) {
          await page.mouse.click(bar[1].cx, bar[1].cy).catch(() => {})
          await page.waitForTimeout(1800)
          opened = { ok: true, via: 'bar:第2个图标' }
        }
        if (!opened.ok) opened = await clickAny(page, SEL.comment, ['评论'])
        if (!opened.ok) result.skipped.comment = '没找到评论入口'
        else {
          await page.waitForTimeout(2000)
          await openCommentBox(page)
          await page.waitForTimeout(1200)
          let boxSel = ''
          for (const sel of SEL.commentBox) {
            try {
              const el = page.locator(sel).first()
              if ((await el.count()) && (await el.isVisible().catch(() => false))) { boxSel = sel; break }
            } catch { /* 下一个 */ }
          }
          if (!boxSel) result.skipped.comment = '没找到评论输入框'
          else {
            const box = page.locator(boxSel).first()
            await box.click({ timeout: 5000 })
            const { text, at } = built
            const name = at.replace(/^@/, '')
            if (at && name && text.includes(at)) {
              const idx = text.indexOf(at)
              const before = text.slice(0, idx).trim()
              const after = text.slice(idx + at.length).trim()
              if (before) await page.keyboard.type(before, { delay: 60 })
              await page.keyboard.type(at, { delay: 100 })
              result.mentioned = await pickAt(page, at, Number(cfg.mentionWaitMs) || 1500)
              if (!result.mentioned) result.via.at = '联想候选没匹配到，@ 只作为文本留在评论里'
              if (after) await page.keyboard.type(after, { delay: 60 })
            } else {
              await page.keyboard.type(text, { delay: 60 })
            }
            await page.waitForTimeout(800)
            const sent = await sendComment(page)
            if (!sent) await page.keyboard.press('Enter').catch(() => {})
            await page.waitForTimeout(1600)
            const echoed = await page.evaluate((t) => {
              const box = document.querySelector('div[role="textbox"]') || document.querySelector('[contenteditable]') || document.querySelector('input[placeholder*="评论"]')
              const boxText = box ? (box.value !== undefined ? String(box.value) : (box.innerText || '')) : ''
              const boxEmpty = boxText.trim() === ''
              const inList = Array.from(document.querySelectorAll('[data-e2e="comment-item"]')).some((e) => (e.innerText || '').includes(t))
              return { boxEmpty, inList, boxText: boxText.slice(0, 40) }
            }, text).catch(() => ({ boxEmpty: false, inList: false, boxText: '?' }))
            await page.screenshot({ path: HOME + '\\comment-shot.png' }).catch(() => {})
            result.commented = !!(echoed.boxEmpty || echoed.inList)
            result.via.comment = echoed.inList ? '发送（已出现在评论列表）' : echoed.boxEmpty ? '发送（输入框已清空）' : '发送（无回显，可能没发出去）'
            if (result.commented) st.quota.comment += 1
            result.text = text
            if (!result.commented && UI_MODE) {
              log('评论没回显：如果窗口里弹出验证码，请人工完成验证，我最多等 90 秒')
              for (let i = 0; i < 3; i++) {
                await page.waitForTimeout(30000)
                const ok = await page.evaluate((t) => Array.from(document.querySelectorAll('[data-e2e="comment-item"]')).some((e) => (e.innerText || '').includes(t)), text).catch(() => false)
                if (ok) {
                  result.commented = true
                  result.via.comment = '人工过验证后已发出'
                  st.quota.comment += 1
                  break
                }
              }
            }
          }
        }
      } catch (e) {
        result.skipped.comment = '评论过程中出错：' + (e && e.message ? e.message : String(e))
      }
    }
  }

  result.quota = { ...st.quota }
  return result
}

async function doRun({ force, ui }) {
  UI_MODE = !!ui
  const cfg = loadConfig()
  const now = new Date()
  const hour = now.getHours()
  if (!force && (hour < cfg.windowStart || hour >= cfg.windowEnd)) {
    emit({ ok: false, skipped: `不在 ${cfg.windowStart}-${cfg.windowEnd} 点窗口内`, hour })
    return
  }
  const st = loadState()
  const today = now.toISOString().slice(0, 10)
  if (st.date !== today) { st.date = today; st.count = 0 }
  const maxRounds = quotaCap(cfg.maxPerDay)
  if (overQuota(st.count, maxRounds)) {
    emit({ ok: false, skipped: `今天已刷 ${st.count} 条（上限 ${maxRounds}）`, count: st.count })
    return
  }
  if (!force && st.lastAt && (now.getTime() - st.lastAt) / 60000 < cfg.minGapMin) {
    const wait = Math.ceil(cfg.minGapMin - (now.getTime() - st.lastAt) / 60000)
    emit({ ok: false, skipped: `距上轮不到 ${cfg.minGapMin} 分钟，还要等约 ${wait} 分钟`, count: st.count })
    return
  }

  const { ctx, page } = await openBrowser({ interactive: !!ui })
  try {
    const cards = await readFeed(page, cfg.feedUrl)
    if (cards.length === 0) {
      emit({ ok: false, skipped: '没读到卡片（可能被要求登录，或页面结构变了）', count: st.count })
      return
    }
    const fresh = cards.filter((c) => !st.seen.includes(c.id))
    if (fresh.length === 0) {
      emit({ ok: false, skipped: '这一轮全是刷过的', count: st.count })
      return
    }
    const picked = fresh[Math.floor(Math.random() * fresh.length)]
    // 进详情页顺带接住音频直链：列表页没有互动栏，也听不到声音
    let audioUrl = ''
    const catchAudio = (req) => {
      const u = req.url()
      if (!audioUrl && /media-audio/i.test(u)) audioUrl = u
      else if (!audioUrl && /\.m3u8/i.test(u)) audioUrl = u
    }
    if (cfg.hearVideo) page.on('request', catchAudio)
    await page.goto('https://www.douyin.com/video/' + picked.id, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(6000)
    let transcript = ''
    if (cfg.hearVideo) {
      if (!audioUrl) await page.waitForTimeout(4000)
      try { page.off('request', catchAudio) } catch { /* 老版本没有 off */ }
      transcript = await transcribeAudio(cfg, audioUrl)
      if (transcript) log(`耳朵听完了：${transcript.length} 字`)
    }
    const feelSource = transcript
      ? `${picked.title}\n\n（它自己口播的内容，供参考）${transcript.slice(0, 400)}`
      : picked.title
    const feel = await generateFeel(cfg, feelSource)
    const interaction = await interact(cfg, page, st, feel)
    st.count += 1
    st.lastAt = now.getTime()
    st.seen = [...st.seen, picked.id].slice(-cfg.keepSeen)
    saveState(st)
    appendJournal({ title: picked.title, note: feel, interaction, source: '推荐流', heard: transcript ? transcript.slice(0, 300) : '' })
    emit({
      ok: true,
      title: picked.title,
      url: 'https://www.douyin.com/video/' + picked.id,
      feel,
      heard: transcript ? transcript.length : 0,
      audio: audioUrl ? 'captured' : '',
      interaction,
      count: st.count,
      maxPerDay: cfg.maxPerDay,
      candidates: cards.length,
      fresh: fresh.length,
    })
  } catch (e) {
    log('刷一轮失败: ' + e.message)
    emit({ ok: false, error: e.message, count: st.count })
  } finally {
    await ctx.close()
  }
}

function doConfig() {
  emit({ ok: true, home: HOME, config: loadConfig() })
}

/** 诊断：列出推荐页里可用的 data-e2e、按钮文字，以及互动选择器的命中情况 */
async function doProbe() {
  const { ctx, page, cfg } = await openBrowser({ interactive: false })
  try {
    const urlArg = argv.find((a) => a.startsWith('--url='))
    await page.goto(urlArg ? urlArg.slice('--url='.length) : cfg.feedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(6000)
    const loggedIn = await isLoggedIn(ctx)
    const dataE2e = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((e) => e.getAttribute('data-e2e')))).slice(0, 80)).catch(() => [])
    const hits = {}
    for (const [k, sels] of Object.entries(SEL)) {
      hits[k] = []
      for (const s of sels) {
        try {
          const el = page.locator(s).first()
          const n = await el.count()
          if (!n) continue
          const vis = await el.isVisible().catch(() => null)
          const box = await el.boundingBox().catch(() => null)
          hits[k].push({ sel: s, n, vis, box })
        } catch { /* 忽略 */ }
      }
    }
    emit({ ok: true, loggedIn, title: await page.title(), dataE2e, hits, dom: await page.evaluate(() => {
      const buttons = []
      for (const el of Array.from(document.querySelectorAll('[aria-label], [title], [role="button"], button, svg')).slice(0, 150)) {
        buttons.push({
          tag: el.tagName,
          aria: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 70),
          text: (el.textContent || '').trim().slice(0, 24),
        })
      }
      const names = new Set()
      for (const el of Array.from(document.querySelectorAll('div, span, button, li')).slice(0, 2000)) {
        for (const a of Array.from(el.attributes || [])) if (a.name.indexOf('data-') === 0) names.add(a.name)
      }
      const cards = []
      for (const el of Array.from(document.querySelectorAll('[data-aweme-id]')).slice(0, 12)) {
        cards.push({ id: el.getAttribute('data-aweme-id'), text: (el.textContent || '').trim().slice(0, 40) })
      }
      return { videos: document.querySelectorAll('video').length, buttons, dataAttrs: Array.from(names).slice(0, 60), cards }
    }).catch(() => ({ videos: 0, buttons: [], dataAttrs: [] })),
    shot: await page.screenshot({ path: HOME + '\\probe.png' }).then(() => HOME + '\\probe.png').catch(() => '') })
  } catch (e) {
    emit({ ok: false, error: e && e.message ? e.message : String(e) })
  } finally {
    await ctx.close()
  }
}

const argv = process.argv.slice(2)
try {
  if (argv.includes('--login')) await doLogin()
  else if (argv.includes('--status')) await doStatus()
  else if (argv.includes('--config')) doConfig()
  else if (argv.includes('--probe')) await doProbe()
  else await doRun({ force: argv.includes('--force'), ui: argv.includes('--ui') || argv.includes('--interactive') })
} catch (e) {
  log('异常: ' + (e && e.stack ? e.stack : e))
  emit({ ok: false, error: e && e.message ? e.message : String(e) })
  process.exitCode = 1
}
