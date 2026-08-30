// 刺猬猫段评可视化爬虫面板 v1
// 零依赖 Node，浏览器操作：查书 → 选卷 → 配参数 → 开爬 → 实时进度/日志
// 用法: node ciweimao_vis_crawler.mjs [端口=8788]
// 打开 http://127.0.0.1:8788
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash, createHmac, createDecipheriv, createCipheriv, publicEncrypt, constants, randomBytes } from 'node:crypto'

const APP_VERSION = '2.9.365'
const DEVICE_TOKEN = 'ciweimao_'
const AES_KEY_STR = 'sD6doAOcW7hm7iaeK6UlcdtAIWlZGlBr'
const HMAC_KEY = 'a90f3731745f1c30ee77cb13fc00005a'
const SIGNATURES = HMAC_KEY + 'CkMxWNB666'
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxX5AMAGSDhTxsIEahC5t
Jxypy8qyPijOT2rsMhuUDvENtWpl4axsfLRpD1AlghzBSpNgi1idyZ/OtJFvZsjj
+drdEO7rCzxMBOlZdw79Gwo06QFSD8JL8X4f49YcGl2+LI5d0KBY2wXdh7urEHQC
xLK/Lxu9e9ADHXzY26tpCJyvF5LITKZPnzYjGt4fhCEhuoPoeVlJdRAMmGeoRZQ/
DeRTSAQ1iS3HqalTYRcM4AIiLumivk3vpz8RFsTT0SCKX0zgFRwxkC8pya9/Ls7j
ALth10rUJTac7fv/801DM6ybAW3IqLgFFUucOwyUF2opRB5AHdoUaa5h4Hb6vwRl
tQIDAQAB
-----END PUBLIC KEY-----`
const UA = 'Android  com.kuangxiangciweimao.novel.c  2.9.365, Xiaomi, 24030PN60G, 34, 14'

// 数据/令牌路径：相对脚本所在目录，随仓库一起走（可用环境变量覆盖）
const _here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const DATA_ROOT = process.env.CIWEMAO_DATA || path.join(_here, 'ciweimao_data')
const TOKEN_FILE = process.env.CIWEMAO_TOKEN || path.join(_here, '_ciweimao_app_token.json')
const PORT = Number(process.argv[2] || 8788)

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- 加密/签名 ----------
function aesEncryptStr(plain) {
  const key = createHash('sha256').update(AES_KEY_STR, 'utf8').digest()
  const c = createCipheriv('aes-256-cbc', key, Buffer.alloc(16))
  c.setAutoPadding(false)
  const buf = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()])
  return buf.toString('base64')
}
function decryptResponse(raw) {
  const key = createHash('sha256').update(AES_KEY_STR, 'utf8').digest()
  const d = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16))
  d.setAutoPadding(false)
  const buf = Buffer.concat([d.update(Buffer.from(raw, 'base64')), d.final()])
  const pad = buf[buf.length - 1]
  const plain = pad >= 1 && pad <= 16 ? buf.subarray(0, buf.length - pad) : buf
  return JSON.parse(plain.toString('utf8'))
}
function rsaEncrypt(plain) {
  return publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(plain, 'utf8')).toString('base64')
}
function randStr() {
  const now = new Date()
  const mmss = String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0')
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let r = ''
  for (let i = 0; i < 12; i++) r += chars[randomBytes(1)[0] % chars.length]
  return mmss + r
}
function hmacP(rs, account) {
  const msg = `account=${encodeURIComponent(account)}&app_version=${APP_VERSION}&rand_str=${rs}&signatures=${SIGNATURES}`
  return createHmac('sha256', HMAC_KEY).update(msg, 'utf8').digest('base64')
}
function getHost() {
  const t = readToken()
  if (!t) return 'https://app1.hbooker.com'
  const last = String(t.reader_id || '').slice(-1)
  return ('1' <= last && last <= '5') ? 'https://app1.happybooker.cn' : 'https://app1.hbooker.com'
}

// ---------- token ----------
function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) } catch { return null }
}
function saveToken(cfg) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(cfg, null, 2))
}

// ---------- API ----------
// login=false 时用于登录类接口（无 account/login_token）
async function apiPost(pathname, params, opts = {}) {
  const { login = false, retries = 4 } = opts
  const t = readToken()
  for (let i = 0; i < retries; i++) {
    try {
      const body = new URLSearchParams(params)
      body.set('app_version', APP_VERSION)
      body.set('device_token', DEVICE_TOKEN)
      const rs = randStr()
      body.set('rand_str', rs)
      body.set('p', hmacP(rs, login ? '' : (t?.account || '')))
      if (!login && t) {
        body.set('account', t.account)
        body.set('login_token', t.login_token)
      }
      const res = await fetch(getHost() + pathname, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          'charsets': 'utf-8',
          'Host': new URL(getHost()).host,
        },
        body: body.toString(),
      })
      return decryptResponse(await res.text())
    } catch (e) {
      if (i === retries - 1) throw e
      await sleep(300 * (i + 1))
    }
  }
}

// ---------- 日志 ----------
const logBuf = []
function log(msg) {
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`
  logBuf.push(line)
  if (logBuf.length > 800) logBuf.splice(0, logBuf.length - 800)
  console.log(line)
}

// ---------- 任务状态 ----------
let task = null // { running, paused, bookId, bookName, divisionId, divisionName, outDir, chapters, todo[], doneSet, doneOrder[], concurrency, delay, startTime, current }

function simplify(t) {
  return {
    id: t.tsukkomi_id,
    para: t.paragraph_index,
    user: t.reader_info ? t.reader_info.reader_name : '',
    uid: t.reader_info ? t.reader_info.reader_id : '',
    ip: t.reader_info ? t.reader_info.ip_home : '',
    content: t.tsukkomi_content,
    like: t.like_amount,
    unlike: t.unlike_amount,
    lou: t.member_lou,
    reply: t.reply_num,
    hot_reply: (t.hot_reply || []).map(r => ({ user: r.reader_info ? r.reader_info.reader_name : '', content: r.tsukkomi_content || r.reply_content || '' })),
    time: t.ctime,
  }
}

async function fetchChapter(ch, delay) {
  const num = await apiPost('/chapter/get_tsukkomi_num', { chapter_id: ch.chapter_id })
  const info = (num.data && num.data.tsukkomi_num_info) || []
  const paragraphs = []
  for (const p of info) {
    let list = []
    let page = 0
    for (;;) {
      const r = await apiPost('/chapter/get_paragraph_tsukkomi_list_new', { chapter_id: ch.chapter_id, paragraph_index: p.paragraph_index, page, count: 2000 })
      const got = (r.data && r.data.tsukkomi_list) || []
      if (!got.length) break
      list.push(...got)
      const amount = Number(r.data.paragraph_info?.paragraph_tsukkomi_amount || 0)
      if (list.length >= amount && amount > 0) break
      page++
      if (page > 50) break
      await sleep(delay)
    }
    paragraphs.push({ paragraph_index: p.paragraph_index, amount: String(list.length), tsukkomi: list.map(simplify) })
    await sleep(delay)
  }
  return {
    chapter_id: ch.chapter_id,
    chapter_index: ch.chapter_index,
    chapter_title: ch.chapter_title,
    is_paid: ch.is_paid,
    tsukkomi_amount: ch.tsukkomi_amount,
    fetched_at: new Date().toISOString(),
    paragraphs,
  }
}

async function workerLoop(wid, delay) {
  task.activeWorkers++
  while (task.running) {
    if (task.paused) { await sleep(500); continue }
    let ch
    const q = task.queue
    for (let i = 0; i < q.length; i++) {
      if (q[i].done) continue
      q[i].done = true
      ch = q[i].ch
      break
    }
    if (!ch) {
      // 没有待抓项了——若自己是最后一个活跃 worker 且队列全部处理过，则结束
      const allDone = task.activeWorkers === 1 && task.queue.every(q => q.done)
      if (allDone && task.running) {
        task.running = false
        task.paused = false
        saveState()
        const mins = ((Date.now() - task.startTime) / 60000).toFixed(1)
        log(`✅ 全部完成！共 ${task.completed} 章，用时 ${mins} 分钟`)
      }
      break
    }
    task.current = ch
    try {
      const data = await fetchChapter(ch, delay)
      const fname = `${String(ch.chapter_index).padStart(4, '0')}.json`
      fs.writeFileSync(path.join(task.outDir, fname), JSON.stringify(data, null, 1))
      task.doneSet.add(ch.chapter_index)
      task.doneOrder.push(ch.chapter_index)
      task.completed++
      const t = data.paragraphs.reduce((s, p) => s + p.tsukkomi.length, 0)
      log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} 段=${data.paragraphs.length} 吐槽=${t} ✓`)
      saveState()
    } catch (e) {
      log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} FAIL: ${String(e.message || e).slice(0, 140)}`)
      // 失败不计数，重试由下一次轮询自然完成（done 标记已置，需回滚）
      q.forEach(item => { if (item.ch.chapter_index === ch.chapter_index) item.done = false })
    }
    task.current = null
  }
  task.activeWorkers--
}

function saveState() {
  const st = { done: [...task.doneOrder] }
  fs.writeFileSync(path.join(task.outDir, '_state.json'), JSON.stringify(st))
}

// ---------- HTTP ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  try {
    if (req.method === 'GET' && p === '/') return res.end(PAGE_HTML)
    if (req.method === 'GET' && p === '/api/status') {
      const t = readToken()
      const st = {
        token: t ? { account: t.account, nick: t.nick_name, reader_id: t.reader_id } : null,
        task: task ? {
          running: task.running,
          paused: task.paused,
          bookId: task.bookId,
          bookName: task.bookName,
          divisionName: task.divisionName,
          total: task.todoCount,
          completed: task.completed,
          failed: task.failed,
          current: task.current ? `${task.current.chapter_index} ${task.current.chapter_title}` : null,
          percent: task.chapters.length ? Math.round(task.completed / task.chapters.length * 100) : 0,
          elapsedSec: Math.round((Date.now() - task.startTime) / 1000),
          recent: task.doneOrder.slice(-5).map(i => `#${i}`),
        } : null,
        log: logBuf.slice(-60),
      }
      return json(res, 200, st)
    }
    if (req.method === 'POST' && p === '/api/load-book') {
      const { book_id } = await readBody(req)
      if (!book_id) return json(res, 400, { error: '缺 book_id' })
      const info = await apiPost('/book/get_info_by_id', { book_id: String(book_id) })
      const bi = info.data?.book_info
      if (!bi) return json(res, 400, { error: `查书失败: ${info.error?.msg || '未知'}`, raw: info })
      const dv = await apiPost('/book/get_division_list', { book_id: String(book_id) })
      const divs = (dv.data?.division_list || []).map(d => ({ id: d.division_id, name: d.division_name }))
      return json(res, 200, { book_name: bi.book_name, author: bi.author_name, intro: (bi.book_intro || '').slice(0, 120), divisions: divs })
    }
    if (req.method === 'POST' && p === '/api/start') {
      if (task && task.running) return json(res, 400, { error: '任务已在运行' })
      const { book_id, book_name, division_id, division_name, chapter_start, chapter_end, concurrency, delay } = await readBody(req)
      if (!book_id || !division_id) return json(res, 400, { error: '缺 book_id/division_id' })
      const outDir = path.join(DATA_ROOT, String(book_id), String(division_id), 'tsukkomi')
      fs.mkdirSync(outDir, { recursive: true })
      // 章节列表（缓存）
      const cacheFile = path.join(DATA_ROOT, String(book_id), String(division_id), '_chapters.json')
      let chapters = []
      if (fs.existsSync(cacheFile)) chapters = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (!chapters.length) {
        const ch = await apiPost('/chapter/get_updated_chapter_by_division_id', { division_id: String(division_id) })
        chapters = ch.data?.chapter_list || []
        if (!chapters.length) return json(res, 400, { error: `取章节列表失败: ${ch.error?.msg || '空'}` })
        fs.writeFileSync(cacheFile, JSON.stringify(chapters))
      }
      // 范围过滤
      let list = chapters
      const cs = Number(chapter_start || 1), ce = Number(chapter_end || Infinity)
      if (cs > 1 || isFinite(ce)) list = list.filter(c => c.chapter_index >= cs && c.chapter_index <= ce)
      // 断点续传
      let doneSet = new Set()
      const stFile = path.join(outDir, '_state.json')
      if (fs.existsSync(stFile)) doneSet = new Set(JSON.parse(fs.readFileSync(stFile, 'utf8')).done || [])
      const queue = list.map(ch => ({ ch, done: doneSet.has(ch.chapter_index) }))
      const todoCount = queue.filter(q => !q.done).length
      if (!todoCount) return json(res, 200, { note: '无新章节（全部已抓）', total: list.length })
      task = {
        running: true, paused: false,
        bookId: String(book_id), bookName: book_name || '',
        divisionId: String(division_id), divisionName: division_name || '',
        outDir, chapters: list, queue,
        doneSet, doneOrder: [...doneSet], completed: doneSet.size,
        failed: 0, todoCount,
        concurrency: Math.max(1, Math.min(8, Number(concurrency) || 4)),
        delay: Math.max(0, Number(delay) || 200),
        startTime: Date.now(), current: null,
        activeWorkers: 0,
      }
      log(`开始抓取《${book_name || book_id}》卷「${division_name || division_id}」: 总 ${list.length} 章, 待抓 ${todoCount} 章, 并发 ${task.concurrency}`)
      for (let w = 0; w < task.concurrency; w++) workerLoop(w, task.delay)
      return json(res, 200, { ok: true, total: list.length, todo: todoCount })
    }
    if (req.method === 'POST' && p === '/api/pause') {
      if (task && task.running) { task.paused = !task.paused; log(task.paused ? '已暂停' : '已继续') }
      return json(res, 200, { paused: task?.paused || false })
    }
    if (req.method === 'POST' && p === '/api/stop') {
      if (task) { task.running = false; task.paused = false; saveState(); log('已停止，进度已保存'); }
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && p === '/api/send-code') {
      const { account } = await readBody(req)
      if (!account) return json(res, 400, { error: '缺账号' })
      const ts = String(Date.now())
      const hashvalue = createHash('md5').update(aesEncryptStr(account + ts), 'utf8').digest('hex')
      const r = await apiPost('/signup/send_verify_code', { login_name: account, timestamp: ts, verify_type: '5', hashvalue }, { login: true })
      if (r.code === 100000) return json(res, 200, { ok: true })
      return json(res, 400, { error: r.error?.msg || `code=${r.code}`, raw: r })
    }
    if (req.method === 'POST' && p === '/api/login') {
      const { account, password, ver_code } = await readBody(req)
      if (!account || !password || !ver_code) return json(res, 400, { error: '缺账号/密码/验证码' })
      const r = await apiPost('/signup/login', {
        login_name: account,
        passwd: rsaEncrypt(password),
        sign: rsaEncrypt(`${account}_${password}`),
        to_code: '1',
        ver_code: String(ver_code),
      }, { login: true })
      const d = r.data
      if (d && d.login_token) {
        const cfg = { account: d.reader_info.account, login_token: d.login_token, reader_id: d.reader_info.reader_id, nick_name: d.reader_info.nick_name }
        saveToken(cfg)
        log(`登录成功: ${cfg.nick_name} (${cfg.account})`)
        return json(res, 200, { ok: true, ...cfg })
      }
      return json(res, 400, { error: r.error?.msg || `code=${r.code}`, raw: r })
    }
    if (req.method === 'POST' && p === '/api/check-token') {
      try {
        const r = await apiPost('/chapter/get_tsukkomi_num', { chapter_id: '1' })
        return json(res, 200, { ok: r.code === 100000, code: r.code })
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e) })
      }
    }
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String(e.message || e) })
  }
})

server.listen(PORT, () => {
  console.log(`\n  刺猬猫段评可视化爬虫面板已启动`)
  console.log(`  打开 http://127.0.0.1:${PORT}\n`)
})

// ---------- 页面 ----------
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>刺猬猫段评爬虫面板</title>
<style>
:root { --bg:#16181d; --card:#1e2229; --line:#2b3038; --fg:#e8eaed; --dim:#9aa0a6; --acc:#e8a33d; --ok:#4ade80; --err:#f87171; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); color:var(--fg); font:14px/1.6 "Microsoft YaHei",sans-serif; padding:20px; }
h1 { font-size:20px; margin-bottom:4px; } h1 .acc { color:var(--acc); }
.sub { color:var(--dim); margin-bottom:20px; font-size:12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
.card h2 { font-size:14px; margin-bottom:12px; color:var(--acc); }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; }
label { display:block; font-size:12px; color:var(--dim); margin-bottom:4px; }
input,select,button { width:100%; background:#14161b; border:1px solid var(--line); color:var(--fg); border-radius:6px; padding:8px 10px; font-size:13px; }
input:focus,select:focus { outline:1px solid var(--acc); }
button { cursor:pointer; background:var(--acc); color:#16181d; font-weight:700; border:none; }
button:disabled { opacity:.4; cursor:not-allowed; }
button.ghost { background:#2a2f38; color:var(--fg); font-weight:400; }
.row { display:flex; gap:8px; align-items:center; margin-top:12px; flex-wrap:wrap; }
.row button { width:auto; padding:8px 18px; }
.status { display:flex; gap:20px; flex-wrap:wrap; margin-top:8px; font-size:13px; }
.status b { color:var(--acc); font-size:16px; }
.bar { height:10px; background:#14161b; border-radius:5px; overflow:hidden; margin-top:10px; }
.bar>div { height:100%; background:linear-gradient(90deg,#e8a33d,#f0c468); width:0; transition:width .4s; }
#log { background:#101216; border:1px solid var(--line); border-radius:8px; padding:10px; height:280px; overflow-y:auto; font:12px/1.7 Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
#log .ok { color:var(--ok); } #log .err { color:var(--err); }
.tag { display:inline-block; background:#2a2f38; color:var(--dim); border-radius:4px; padding:1px 8px; font-size:11px; margin-left:6px; }
#loginForm { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; }
.msg { font-size:12px; margin-top:8px; min-height:18px; }
.okmsg { color:var(--ok); } .errmsg { color:var(--err); }
@media (max-width:640px){ body{padding:10px} }
</style>
</head>
<body>
<h1>📚 刺猬猫段评<span class="acc">爬虫面板</span></h1>
<div class="sub">零依赖 Node · 浏览器操作 · 断点续传 · 数据存 ciweimao_data/&lt;book_id&gt;/&lt;division_id&gt;/tsukkomi/</div>

<div class="card" id="loginCard">
  <h2>🔑 登录态 <span id="tokenTag" class="tag">检查中…</span></h2>
  <div id="loginForm">
    <div><label>手机号</label><input id="acc" placeholder="注册手机号"></div>
    <div><label>密码</label><input id="pw" type="password" placeholder="密码"></div>
    <div><label>短信验证码</label><input id="code" placeholder="6位数字"><button id="btnSend" class="ghost" style="margin-top:4px">发验证码</button></div>
  </div>
  <div class="row"><button id="btnLogin" class="ghost">登录</button></div>
  <div id="loginMsg" class="msg"></div>
</div>

<div class="card">
  <h2>📖 选择书籍与卷</h2>
  <div class="grid">
    <div><label>书 ID（URL 末尾数字）</label><input id="bookId" placeholder="如 100000001"></div>
    <div><label>书名（自动查询）</label><input id="bookName" readonly placeholder="—"></div>
  </div>
  <div class="row"><button id="btnLoad">查询书籍</button></div>
  <div style="margin-top:10px"><label>卷列表</label><select id="division"><option value="">（先查询书籍）</option></select></div>
</div>

<div class="card">
  <h2>⚙️ 抓取参数</h2>
  <div class="grid">
    <div><label>起始章（章节号，1 起）</label><input id="cStart" value="1"></div>
    <div><label>结束章（留空=全部）</label><input id="cEnd" placeholder="留空"></div>
    <div><label>并发</label><input id="concurrency" type="number" value="4" min="1" max="8"></div>
    <div><label>间隔 ms</label><input id="delay" type="number" value="200" min="0"></div>
  </div>
  <div class="row">
    <button id="btnStart">▶ 开始抓取</button>
    <button id="btnPause" class="ghost" disabled>⏸ 暂停</button>
    <button id="btnStop" class="ghost" disabled>⏹ 停止</button>
  </div>
</div>

<div class="card">
  <h2>📊 进度</h2>
  <div class="status">
    <div>完成 <b id="sDone">0</b></div>
    <div>待抓 <b id="sTodo">0</b></div>
    <div>进度 <b id="sPct">0%</b></div>
    <div>用时 <b id="sTime">0s</b></div>
    <div>状态 <b id="sState">空闲</b></div>
    <div>当前 <b id="sCur" style="font-size:12px;color:var(--dim)">—</b></div>
  </div>
  <div class="bar"><div id="barFill"></div></div>
</div>

<div class="card">
  <h2>📜 日志</h2>
  <div id="log"></div>
</div>

<script>
const $ = id => document.getElementById(id)
let taskRunning = false, taskPaused = false
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
function setMsg(id, text, ok) { const el = $(id); el.textContent = text; el.className = 'msg ' + (ok ? 'okmsg' : 'errmsg') }

async function refresh() {
  try {
    const st = await api('/api/status')
    // 登录态
    const tag = $('tokenTag')
    if (st.token) tag.textContent = '已登录：' + st.token.nick + ' (' + st.token.account + ')'
    else tag.textContent = '未登录'
    // 任务
    const t = st.task
    taskRunning = t ? t.running : false
    taskPaused = t ? t.paused : false
    if (t) {
      $('sDone').textContent = t.completed
      $('sTodo').textContent = t.todoCount
      $('sPct').textContent = t.percent + '%'
      $('sTime').textContent = t.elapsedSec + 's'
      $('sState').textContent = t.running ? (t.paused ? '⏸ 已暂停' : '⏳ 抓取中') : '空闲'
      $('sCur').textContent = t.current || '—'
      $('barFill').style.width = t.percent + '%'
      $('btnStart').disabled = t.running
      $('btnPause').disabled = !t.running
      $('btnStop').disabled = !t.running
      $('btnPause').textContent = t.paused ? '▶ 继续' : '⏸ 暂停'
    } else {
      $('sDone').textContent = '0'; $('sTodo').textContent = '0'; $('sPct').textContent = '0%'
      $('sTime').textContent = '0s'; $('sState').textContent = '空闲'; $('sCur').textContent = '—'
      $('barFill').style.width = '0%'
      $('btnStart').disabled = false; $('btnPause').disabled = true; $('btnStop').disabled = true
    }
    // 日志
    if (st.log && st.log.length) {
      const lg = $('log')
      const lastLen = lg.dataset.len ? Number(lg.dataset.len) : 0
      if (st.log.length > lastLen) {
        lg.textContent = st.log.join('\\n')
        lg.dataset.len = st.log.length
        lg.scrollTop = lg.scrollHeight
      }
    }
  } catch (e) { /* 服务暂不可达 */ }
}
setInterval(refresh, 1500); refresh()

$('btnLoad').onclick = async () => {
  const bookId = $('bookId').value.trim()
  if (!bookId) return setMsg('loginMsg', '先填书 ID', false)
  const r = await api('/api/load-book', { book_id: bookId })
  if (r.error) return setMsg('loginMsg', '查询失败：' + r.error, false)
  $('bookName').value = r.book_name
  const sel = $('division'); sel.innerHTML = ''
  for (const d of r.divisions) {
    const o = document.createElement('option')
    o.value = d.id; o.textContent = d.name
    sel.appendChild(o)
  }
  setMsg('loginMsg', '找到《' + r.book_name + '》' + r.divisions.length + ' 个卷', true)
}

$('btnSend').onclick = async () => {
  const account = $('acc').value.trim()
  if (!account) return setMsg('loginMsg', '先填手机号', false)
  setMsg('loginMsg', '发送中…', true)
  const r = await api('/api/send-code', { account })
  if (r.ok) setMsg('loginMsg', '验证码已发送，注意查收短信', true)
  else setMsg('loginMsg', '发送失败：' + (r.error || '未知'), false)
}

$('btnLogin').onclick = async () => {
  const account = $('acc').value.trim(), password = $('pw').value, ver_code = $('code').value.trim()
  if (!account || !password || !ver_code) return setMsg('loginMsg', '账号/密码/验证码都要填', false)
  const r = await api('/api/login', { account, password, ver_code })
  if (r.ok) setMsg('loginMsg', '登录成功：' + r.nick_name, true)
  else setMsg('loginMsg', '登录失败：' + (r.error || '未知'), false)
}

$('btnStart').onclick = async () => {
  const sel = $('division')
  if (!sel.value) return setMsg('loginMsg', '先查询书籍并选卷', false)
  const r = await api('/api/start', {
    book_id: $('bookId').value.trim(),
    book_name: $('bookName').value,
    division_id: sel.value,
    division_name: sel.options[sel.selectedIndex].textContent.split('（')[0],
    chapter_start: $('cStart').value.trim(),
    chapter_end: $('cEnd').value.trim(),
    concurrency: $('concurrency').value,
    delay: $('delay').value,
  })
  if (r.error) setMsg('loginMsg', '启动失败：' + r.error, false)
  else if (r.note) setMsg('loginMsg', r.note, true)
  else setMsg('loginMsg', '已启动：共 ' + r.total + ' 章，待抓 ' + r.todo + ' 章', true)
}

$('btnPause').onclick = async () => { await api('/api/pause', {}) }
$('btnStop').onclick = async () => { await api('/api/stop', {}); refresh() }
</script>
</body>
</html>`
