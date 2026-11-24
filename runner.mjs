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

const HOME = process.env.SHUA_DOUYIN_HOME || path.join(os.homedir(), '.dsh', 'shua-douyin')
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
      for (const el of Array.from(document.querySelectorAll('div[class*="video"]'))) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
        if (t.length >= 20 && t.length <= 220) out.push(t)
      }
      return out.slice(0, 40)
    })
    for (const c of batch) if (!cards.has(c)) cards.set(c, true)
  }
  return [...cards.keys()]
}

async function generateFeel(cfg, text) {
  const apiKey = cfg.model.apiKey || process.env.SHUA_DOUYIN_API_KEY || ''
  if (!apiKey) {
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
  comment: ['[data-e2e="video-player-comment"]', '[data-e2e="feed-comment"]', '[data-e2e="comment-icon"]'],
  commentBox: ['[data-e2e="comment-input"]', 'div[contenteditable="true"]', 'textarea[placeholder*="评论"]', 'textarea'],
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

  if (cfg.interact.like) {
    const max = quotaCap(cap.like)
    if (overQuota(st.quota.like, max)) result.skipped.like = `今日点赞额度用完（${quotaText(st.quota.like, max)}）`
    else {
      const r = await clickAny(page, SEL.like, ['点赞', '赞'])
      if (r.ok) {
        result.liked = true
        result.via.like = r.via
        if (!r.already) st.quota.like += 1
        await page.waitForTimeout(900)
      } else result.skipped.like = '没找到点赞按钮（页面结构可能变了，可跑 --probe 看）'
    }
  }

  if (cfg.interact.collect) {
    const max = quotaCap(cap.collect)
    if (overQuota(st.quota.collect, max)) result.skipped.collect = `今日收藏额度用完（${quotaText(st.quota.collect, max)}）`
    else {
      const r = await clickAny(page, SEL.collect, ['收藏'])
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
        const opened = await clickAny(page, SEL.comment, ['评论'])
        if (!opened.ok) result.skipped.comment = '没找到评论入口'
        else {
          await page.waitForTimeout(2000)
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
            const pub = await clickAny(page, SEL.publish, ['发送', '发布'])
            if (!pub.ok) {
              await page.keyboard.press('Enter').catch(() => {})
            }
            result.commented = true
            result.via.comment = pub.ok ? pub.via : 'Enter'
            st.quota.comment += 1
            result.text = text
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

async function doRun({ force }) {
  const cfg = loadConfig()
  const now = new Date()
  const hour = now.getHours()
  if (hour < cfg.windowStart || hour >= cfg.windowEnd) {
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

  const { ctx, page } = await openBrowser({ interactive: false })
  try {
    const cards = await readFeed(page, cfg.feedUrl)
    if (cards.length === 0) {
      emit({ ok: false, skipped: '没读到卡片（可能被要求登录，或页面结构变了）', count: st.count })
      return
    }
    const fresh = cards.filter((c) => !st.seen.includes(c))
    if (fresh.length === 0) {
      emit({ ok: false, skipped: '这一轮全是刷过的', count: st.count })
      return
    }
    const picked = fresh[Math.floor(Math.random() * fresh.length)]
    const feel = await generateFeel(cfg, picked)
    const interaction = await interact(cfg, page, st, feel)
    st.count += 1
    st.lastAt = now.getTime()
    st.seen = [...st.seen, picked].slice(-cfg.keepSeen)
    saveState(st)
    appendJournal({ title: picked.slice(0, 200), note: feel, interaction, source: '推荐流' })
    emit({
      ok: true,
      title: picked.slice(0, 200),
      feel,
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
    await page.goto(cfg.feedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(6000)
    const loggedIn = await isLoggedIn(ctx)
    const dataE2e = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((e) => e.getAttribute('data-e2e')))).slice(0, 80)).catch(() => [])
    const hits = {}
    for (const [k, sels] of Object.entries(SEL)) {
      hits[k] = []
      for (const s of sels) {
        try { if (await page.locator(s).count()) hits[k].push(s) } catch { /* 忽略 */ }
      }
    }
    emit({ ok: true, loggedIn, title: await page.title(), dataE2e, hits })
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
  else await doRun({ force: argv.includes('--force') })
} catch (e) {
  log('异常: ' + (e && e.stack ? e.stack : e))
  emit({ ok: false, error: e && e.message ? e.message : String(e) })
  process.exitCode = 1
}
