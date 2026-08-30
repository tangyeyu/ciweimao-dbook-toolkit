// 起点本章说(段评)可视化爬虫面板 v1
// 零依赖 Node，CDP 驱动（需要 Chrome 开着起点页面）：查书 → 选范围 → 配参数 → 开爬 → 实时进度/日志
// 用法: node qidian_vis_crawler.mjs [端口=8791]
// 打开 http://127.0.0.1:8791
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const _here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const CDP_URL = process.env.QIDIAN_CDP || 'http://127.0.0.1:9222'
const DATA_ROOT = process.env.QIDIAN_DATA || path.join(_here, 'qidian_data')
const PORT = Number(process.argv[2] || 8791)

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- CDP ----------
let cdp = null // { call(method, params), close() }
let cdpPageUrl = ''

async function findPageTab() {
  const list = await (await fetch(CDP_URL + '/json/list')).json()
  const page = list.find(t => t.type === 'page' && t.url.includes('qidian.com'))
  if (!page) throw new Error('未找到起点页面标签：请先启动 Chrome 并打开 https://www.qidian.com/ 任意页面')
  return page
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      call(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id
          pending.set(mid, { res, rej })
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      },
      close() { ws.close() },
    })
    ws.onerror = e => reject(new Error('ws: ' + e.message))
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
      }
    }
  })
}
async function evaluate(expr) {
  if (!cdp) throw new Error('CDP 未连接')
  const r = await cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('页面执行异常: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300))
  return r.result?.value
}
async function pageFetch(url, headers = {}) {
  // 在起点页面上下文内 fetch（同源自动带 cookie，绕过 WAF）
  const opt = { method: 'GET', headers: Object.assign({ 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://www.qidian.com/' }, headers) }
  const raw = await evaluate(`(async () => { try { const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(opt)}); const t = await r.text(); return JSON.stringify({ status: r.status, text: t }); } catch (e) { return JSON.stringify({ status: 0, error: String(e) }); } })()`)
  const j = JSON.parse(raw)
  if (j.error) throw new Error('页面fetch失败: ' + j.error)
  if (j.status === 202) throw new Error('WAF 挑战页：请到浏览器里完成人机验证后重试')
  return j
}
async function getCsrf() {
  const v = await evaluate(`(document.cookie.match(/_csrfToken=([^;]+)/)||[])[1]||''`)
  if (!v) throw new Error('页面缺少 _csrfToken cookie，请刷新一下浏览器里的起点页面')
  return v
}

// 导航到书页，等渲染后从 DOM 提取书名 + 章节列表（页面上下文 fetch HTML 会被 WAF 挑战页拦截，导航方式可行）
async function getCatalogByNav(bookId) {
  await evaluate(`location.href = ${JSON.stringify('https://www.qidian.com/book/' + bookId + '/')}; 'nav'`)
  await sleep(3500)
  const data = await evaluate(`(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/chapter/"]')) {
      const m = (a.getAttribute('href') || '').match(/\\/chapter\\/(\\d+)\\/(\\d+)\\//);
      if (!m) continue;
      const key = m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      let title = (a.textContent || '').trim().slice(0, 80);
      // 目录顶部快捷链接「最新章节」必须剔除（它指向最新章节但非目录项）
      if (/最新章节/.test(title)) continue;
      // 空标题保留：可能是正文首章（起点第一章常无文本），用占位名
      if (!title) title = '第' + (out.length + 1) + '章';
      // 过滤短公告类顶部入口
      if (title.length < 4 && /公告|简介|设定|最新/.test(title)) continue;
      out.push({ book_id: m[1], chapter_id: m[2], chapter_index: out.length + 1, chapter_title: title, is_vip: false });
    }
    const h1 = document.querySelector('#bookName, .book-info h1, h1');
    const title = h1 ? h1.textContent.trim() : '';
    let author = '';
    const authorEl = document.querySelector('.book-info .author .name, .book-info .author a, .book-info .author');
    if (authorEl) author = (authorEl.textContent || '').trim().replace(/^作者[:：]/, '');
    return { title, author, chapters: out };
  })()`)
  if (!data.chapters || !data.chapters.length) throw new Error('目录解析为空：页面可能没渲染出章节（书不存在或浏览器被验证页挡住）')
  return data
}

async function ensureCdp() {
  try {
    const page = await findPageTab()
    cdpPageUrl = page.url
    if (!cdp) cdp = await connect(page.webSocketDebuggerUrl)
    return { ok: true, url: page.url }
  } catch (e) {
    cdp = null
    return { ok: false, error: String(e.message || e) }
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
let task = null

function simplify(r) {
  return {
    id: r.reviewId,
    para: r.segmentId,
    user: r.nickName,
    uid: r.userId,
    ip: r.ipAddress || '',
    content: r.content,
    like: r.likeCount,
    unlike: r.dislikeCount,
    lou: r.level,
    reply: r.rootReviewReplyCount,
    hot_reply: r.quoteContent || '',
    time: r.createTimestamp,
    createTime: r.createTime,
    essence: !!r.essenceStatus,
    root: r.rootReviewId,
    quoteUser: r.quoteNickName || '',
    quoteReview: r.quoteReviewId || '',
  }
}

async function fetchChapter(ch, delay) {
  const sum = await pageFetch('https://www.qidian.com/ajax/chapterReview/reviewSummary?' + new URLSearchParams({
    bookId: ch.book_id, chapterId: ch.chapter_id, _csrfToken: await getCsrf(),
  }))
  const obj = JSON.parse(sum.text)
  if (obj.code !== 0) throw new Error('reviewSummary code=' + obj.code + ' ' + (obj.msg || ''))
  const segments = (obj.data && obj.data.list) || []
  const out = []
  for (const seg of segments) {
    const reviews = []
    let page = 1
    for (;;) {
      const r = await pageFetch('https://www.qidian.com/ajax/chapterReview/reviewList?' + new URLSearchParams({
        bookId: ch.book_id, chapterId: ch.chapter_id, page: String(page), pageSize: '10',
        segmentId: String(seg.segmentId), type: '2', _csrfToken: await getCsrf(),
      }))
      const j = JSON.parse(r.text)
      if (j.code !== 0) throw new Error('reviewList code=' + j.code + ' ' + (j.msg || ''))
      const list = (j.data && j.data.list) || []
      if (!list.length) break
      reviews.push(...list)
      if (list.length < 10) break
      page++
      await sleep(delay)
    }
    out.push({ segmentId: seg.segmentId, reviewNum: seg.reviewNum, isHot: !!seg.isHotSegment, tsukkomi: reviews.map(simplify) })
    await sleep(delay)
  }
  return {
    book_id: ch.book_id,
    chapter_id: ch.chapter_id,
    chapter_index: ch.chapter_index,
    chapter_title: ch.chapter_title,
    is_vip: !!ch.is_vip,
    fetched_at: new Date().toISOString(),
    segments: out,
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
      const t = data.segments.reduce((s, p) => s + p.tsukkomi.length, 0)
      log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} 段=${data.segments.length} 段评=${t} ✓`)
      saveState()
    } catch (e) {
      log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} FAIL: ${String(e.message || e).slice(0, 140)}`)
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
      const cdpSt = await ensureCdp()
      const st = {
        cdp: cdpSt,
        task: task ? {
          running: task.running,
          paused: task.paused,
          bookId: task.bookId,
          bookName: task.bookName,
          total: task.todoCount,
          completed: task.completed,
          failed: task.failed,
          current: task.current ? `#${task.current.chapter_index} ${task.current.chapter_title}` : null,
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
      const cdpSt = await ensureCdp()
      if (!cdpSt.ok) return json(res, 400, { error: cdpSt.error })
      const cat = await getCatalogByNav(String(book_id))
      return json(res, 200, { book_name: cat.title || book_id, author: cat.author, chapter_count: cat.chapters.length, chapters: cat.chapters })
    }
    if (req.method === 'POST' && p === '/api/start') {
      if (task && task.running) return json(res, 400, { error: '任务已在运行' })
      const { book_id, book_name, chapter_start, chapter_end, concurrency, delay } = await readBody(req)
      if (!book_id) return json(res, 400, { error: '缺 book_id' })
      const cdpSt = await ensureCdp()
      if (!cdpSt.ok) return json(res, 400, { error: cdpSt.error })
      const outDir = path.join(DATA_ROOT, String(book_id), 'tsukkomi')
      fs.mkdirSync(outDir, { recursive: true })
      const cacheFile = path.join(DATA_ROOT, String(book_id), '_chapters.json')
      let chapters = []
      if (fs.existsSync(cacheFile)) chapters = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (!chapters.length) {
        const cat = await getCatalogByNav(String(book_id))
        chapters = cat.chapters
        fs.writeFileSync(cacheFile, JSON.stringify(chapters))
      }
      let list = chapters
      const cs = Number(chapter_start || 1), ce = Number(chapter_end || Infinity)
      if (cs > 1 || isFinite(ce)) list = list.filter(c => c.chapter_index >= cs && c.chapter_index <= ce)
      let doneSet = new Set()
      const stFile = path.join(outDir, '_state.json')
      if (fs.existsSync(stFile)) doneSet = new Set(JSON.parse(fs.readFileSync(stFile, 'utf8')).done || [])
      const queue = list.map(ch => ({ ch, done: doneSet.has(ch.chapter_index) }))
      const todoCount = queue.filter(q => !q.done).length
      if (!todoCount) return json(res, 200, { note: '无新章节（全部已抓）', total: list.length })
      task = {
        running: true, paused: false,
        bookId: String(book_id), bookName: book_name || '',
        outDir, chapters: list, queue,
        doneSet, doneOrder: [...doneSet], completed: doneSet.size,
        failed: 0, todoCount,
        concurrency: Math.max(1, Math.min(8, Number(concurrency) || 3)),
        delay: Math.max(50, Number(delay) || 300),
        startTime: Date.now(), current: null,
        activeWorkers: 0,
      }
      log(`开始抓取《${book_name || book_id}》: 总 ${list.length} 章, 待抓 ${todoCount} 章, 并发 ${task.concurrency}, 间隔 ${task.delay}ms`)
      for (let w = 0; w < task.concurrency; w++) workerLoop(w, task.delay)
      return json(res, 200, { ok: true, total: list.length, todo: todoCount })
    }
    if (req.method === 'POST' && p === '/api/pause') {
      if (task && task.running) { task.paused = !task.paused; log(task.paused ? '已暂停' : '已继续') }
      return json(res, 200, { paused: task?.paused || false })
    }
    if (req.method === 'POST' && p === '/api/stop') {
      if (task) { task.running = false; task.paused = false; saveState(); log('已停止，进度已保存') }
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String(e.message || e) })
  }
})

server.listen(PORT, () => {
  console.log(`\n  起点本章说段评可视化爬虫面板已启动`)
  console.log(`  打开 http://127.0.0.1:${PORT}\n`)
})

// ---------- 页面 ----------
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>起点段评爬虫面板</title>
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
.msg { font-size:12px; margin-top:8px; min-height:18px; }
.okmsg { color:var(--ok); } .errmsg { color:var(--err); }
.hint { background:#1c2431; border:1px solid #2b3a4d; border-radius:8px; padding:10px 12px; font-size:12px; color:var(--dim); margin-top:10px; line-height:1.8; }
.hint code { background:#14161b; padding:1px 6px; border-radius:4px; color:var(--acc); }
@media (max-width:640px){ body{padding:10px} }
</style>
</head>
<body>
<h1>📖 起点段评<span class="acc">爬虫面板</span></h1>
<div class="sub">零依赖 Node · 需要 Chrome 开着起点页面（CDP 9222） · 断点续传 · 数据存 qidian_data/&lt;book_id&gt;/tsukkomi/</div>

<div class="card">
  <h2>🔌 浏览器连接 <span id="cdpTag" class="tag">检查中…</span></h2>
  <div class="hint">
    步骤：① 启动 Chrome：<code>chrome.exe --remote-debugging-port=9222 --user-data-dir=某个独立目录</code><br>
    ② 在打开的 Chrome 里访问 <code>https://www.qidian.com/</code>（任意书页即可，无需登录）<br>
    ③ 回到本页面点「重新检测」。爬虫会借用该浏览器抓取，期间别关标签页。
  </div>
  <div class="row"><button id="btnCdp" class="ghost">🔄 重新检测</button></div>
</div>

<div class="card">
  <h2>📖 选择书籍</h2>
  <div class="grid">
    <div><label>书 ID（URL 末尾数字，如 www.qidian.com/book/1010868264/）</label><input id="bookId" placeholder="如 1010868264"></div>
    <div><label>书名（自动查询）</label><input id="bookName" readonly placeholder="—"></div>
  </div>
  <div class="row"><button id="btnLoad">查询书籍</button></div>
  <div id="bookMsg" class="msg"></div>
</div>

<div class="card">
  <h2>⚙️ 抓取参数</h2>
  <div class="grid">
    <div><label>起始章（1 起）</label><input id="cStart" value="1"></div>
    <div><label>结束章（留空=全部）</label><input id="cEnd" placeholder="留空"></div>
    <div><label>并发</label><input id="concurrency" type="number" value="3" min="1" max="8"></div>
    <div><label>间隔 ms（防封建议 ≥300）</label><input id="delay" type="number" value="300" min="50"></div>
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
let taskRunning = false
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
function setMsg(id, text, ok) { const el = $(id); el.textContent = text; el.className = 'msg ' + (ok ? 'okmsg' : 'errmsg') }

async function refresh() {
  try {
    const st = await api('/api/status')
    const tag = $('cdpTag')
    if (st.cdp.ok) { tag.textContent = '已连接 ✓ ' + (st.cdp.url.match(/qidian\.com[^\\s]*/) || [''])[0].slice(0, 50); tag.style.color = 'var(--ok)' }
    else { tag.textContent = '未连接 ✗'; tag.style.color = 'var(--err)' }
    const t = st.task
    taskRunning = t ? t.running : false
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

$('btnCdp').onclick = async () => {
  const st = await api('/api/status')
  setMsg('bookMsg', st.cdp.ok ? '浏览器连接正常 ✓' : '未连接：' + (st.cdp.error || '请按上方步骤操作'), st.cdp.ok)
  refresh()
}

$('btnLoad').onclick = async () => {
  const bookId = $('bookId').value.trim()
  if (!bookId) return setMsg('bookMsg', '先填书 ID', false)
  setMsg('bookMsg', '查询中…', true)
  const r = await api('/api/load-book', { book_id: bookId })
  if (r.error) return setMsg('bookMsg', '查询失败：' + r.error, false)
  $('bookName').value = r.book_name + (r.author ? '（' + r.author + '）' : '')
  setMsg('bookMsg', '找到《' + r.book_name + '》共 ' + r.chapter_count + ' 章，作者 ' + (r.author || '?'), true)
}

$('btnStart').onclick = async () => {
  if (!$('bookId').value.trim()) return setMsg('bookMsg', '先填书 ID', false)
  const r = await api('/api/start', {
    book_id: $('bookId').value.trim(),
    book_name: ($('bookName').value || '').split('（')[0],
    chapter_start: $('cStart').value.trim(),
    chapter_end: $('cEnd').value.trim(),
    concurrency: $('concurrency').value,
    delay: $('delay').value,
  })
  if (r.error) setMsg('bookMsg', '启动失败：' + r.error, false)
  else if (r.note) setMsg('bookMsg', r.note, true)
  else setMsg('bookMsg', '已启动：共 ' + r.total + ' 章，待抓 ' + r.todo + ' 章', true)
}

$('btnPause').onclick = async () => { await api('/api/pause', {}) }
$('btnStop').onclick = async () => { await api('/api/stop', {}); refresh() }
</script>
</body>
</html>`
