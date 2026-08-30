// 刺猬猫/起点段评 .dbook 打包面板 v2（双平台）
// 零依赖 Node，浏览器操作：扫描已抓取的书 → 一键打包 .dbook（段评包/完整书）
// 用法: node dbook_pack_panel.mjs [端口=8789]
// 打开 http://127.0.0.1:8789
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'
import { createHash, createHmac, createDecipheriv, randomBytes } from 'node:crypto'

const APP_VERSION = '2.9.365'
const DEVICE_TOKEN = 'ciweimao_'
const AES_KEY_STR = 'sD6doAOcW7hm7iaeK6UlcdtAIWlZGlBr'
const HMAC_KEY = 'a90f3731745f1c30ee77cb13fc00005a'
const SIGNATURES = HMAC_KEY + 'CkMxWNB666'
const UA = 'Android  com.kuangxiangciweimao.novel.c  2.9.365, Xiaomi, 24030PN60G, 34, 14'
const _here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const DATA_ROOT = process.env.CIWEMAO_DATA || path.join(_here, 'ciweimao_data')
const QIDIAN_ROOT = process.env.QIDIAN_DATA || path.join(_here, 'qidian_data')
const TOKEN_FILE = process.env.CIWEMAO_TOKEN || path.join(_here, '_ciweimao_app_token.json')
const OUT_DIR = process.env.DBOOK_OUT || path.join(_here, 'dbook_out')
const MAGIC = 'DLCBOOK1'
const PORT = Number(process.argv[2] || 8789)

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- 签名/API（与爬虫面板同款） ----------
function readToken() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) } catch { return null } }
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
function decryptResponse(raw) {
  const key = createHash('sha256').update(AES_KEY_STR, 'utf8').digest()
  const d = createDecipheriv('aes-256-cbc', key, Buffer.alloc(16))
  d.setAutoPadding(false)
  const buf = Buffer.concat([d.update(Buffer.from(raw, 'base64')), d.final()])
  const pad = buf[buf.length - 1]
  const plain = pad >= 1 && pad <= 16 ? buf.subarray(0, buf.length - pad) : buf
  return JSON.parse(plain.toString('utf8'))
}
function getHost() {
  const t = readToken()
  if (!t) return 'https://app1.hbooker.com'
  const last = String(t.reader_id || '').slice(-1)
  return ('1' <= last && last <= '5') ? 'https://app1.happybooker.cn' : 'https://app1.hbooker.com'
}
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
      if (!login && t) { body.set('account', t.account); body.set('login_token', t.login_token) }
      const res = await fetch(getHost() + pathname, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'charsets': 'utf-8', 'Host': new URL(getHost()).host },
        body: body.toString(),
      })
      return decryptResponse(await res.text())
    } catch (e) {
      if (i === retries - 1) throw e
      await sleep(300 * (i + 1))
    }
  }
}

// ---------- 扫描已抓取的书（刺猬猫：ciweimao_data/<book_id>/<division_id>/；起点：qidian_data/<book_id>/） ----------
function scanBooks() {
  const books = []
  // 刺猬猫（卷层级）
  if (fs.existsSync(DATA_ROOT)) {
    for (const bookId of fs.readdirSync(DATA_ROOT)) {
      if (!/^\d+$/.test(bookId)) continue
      const bdir = path.join(DATA_ROOT, bookId)
      const divs = fs.readdirSync(bdir).filter(d => /^\d+$/.test(d)).sort()
      let chapters = 0, tkFiles = 0, tkTotal = 0, firstTitle = ''
      const chTk = {}
      for (const divId of divs) {
        const cj = path.join(bdir, divId, '_chapters.json')
        const tkDir = path.join(bdir, divId, 'tsukkomi')
        if (fs.existsSync(cj)) {
          try {
            const ch = JSON.parse(fs.readFileSync(cj, 'utf8'))
            if (!firstTitle && ch[0]?.chapter_title) firstTitle = ch[0].chapter_title
            chapters += ch.length
          } catch {}
        }
        if (fs.existsSync(tkDir)) {
          const files = fs.readdirSync(tkDir).filter(f => f.endsWith('.json') && !f.startsWith('_'))
          tkFiles += files.length
          for (const f of files) {
            try {
              const j = JSON.parse(fs.readFileSync(path.join(tkDir, f), 'utf8'))
              for (const p of (j.paragraphs || [])) tkTotal += (p.tsukkomi || []).length
            } catch {}
          }
        }
      }
      books.push({ platform: 'ciweimao', book_id: bookId, divisions: divs.length, chapters, tk_files: tkFiles, tsukkomi_count: tkTotal, first_title: firstTitle, book_name: '' })
    }
  }
  // 起点（无卷，tsukkomi 直接在书目录下）
  if (fs.existsSync(QIDIAN_ROOT)) {
    for (const bookId of fs.readdirSync(QIDIAN_ROOT)) {
      if (!/^\d+$/.test(bookId)) continue
      const bdir = path.join(QIDIAN_ROOT, bookId)
      const tkDir = path.join(bdir, 'tsukkomi')
      let chapters = 0, tkFiles = 0, tkTotal = 0, firstTitle = '', bookName = ''
      const cj = path.join(bdir, '_chapters.json')
      if (fs.existsSync(cj)) {
        try {
          const ch = JSON.parse(fs.readFileSync(cj, 'utf8'))
          chapters = ch.length
          if (ch[0]?.chapter_title) firstTitle = ch[0].chapter_title
        } catch {}
      }
      const bj = path.join(bdir, '_book.json')
      if (fs.existsSync(bj)) { try { bookName = JSON.parse(fs.readFileSync(bj, 'utf8')).book_name || '' } catch {} }
      if (fs.existsSync(tkDir)) {
        const files = fs.readdirSync(tkDir).filter(f => f.endsWith('.json') && !f.startsWith('_'))
        tkFiles += files.length
        for (const f of files) {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(tkDir, f), 'utf8'))
            for (const s of (j.segments || [])) tkTotal += (s.tsukkomi || []).length
          } catch {}
        }
      }
      books.push({ platform: 'qidian', book_id: bookId, divisions: 1, chapters, tk_files: tkFiles, tsukkomi_count: tkTotal, first_title: firstTitle, book_name: bookName })
    }
  }
  return books
}

// 拉书名（接口，读 token；仅刺猬猫书需要，起点书名已由爬虫面板存 _book.json）
async function fetchBookNames(books) {
  const t = readToken()
  if (!t) return books  // 未登录：书名留空
  for (const b of books) {
    if (b.platform === 'qidian' && b.book_name) continue
    try {
      const r = await apiPost('/book/get_info_by_id', { book_id: b.book_id })
      const info = r?.data?.book_info || r?.data || {}
      b.book_name = info.book_name || ''
      await sleep(150)
    } catch { b.book_name = '' }
  }
  return books
}

// ---------- .dbook 打包（多卷合并，与 build_dbook_from_crawler 同逻辑） ----------
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b }
function buildDbook(meta, files, outFile) {
  const parts = []
  parts.push(Buffer.from(MAGIC, 'ascii'))
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8')
  parts.push(u32(metaBuf.length), metaBuf)
  parts.push(u32(files.length))
  for (const f of files) {
    const gz = zlib.gzipSync(f.data, { level: 9 })
    const nameBuf = Buffer.from(f.name, 'utf8')
    parts.push(u32(nameBuf.length), nameBuf, u32(gz.length), gz)
  }
  fs.writeFileSync(outFile, Buffer.concat(parts))
}

async function packBook(bookId, textDir, platform) {
  if (platform === 'qidian') return packQidian(bookId, textDir)
  // ---- 刺猬猫（多卷合并） ----
  const divs = fs.readdirSync(path.join(DATA_ROOT, bookId)).filter(d => /^\d+$/.test(d)).sort()
  if (!divs.length) throw new Error('没有卷数据')
  let chapters = []
  const indexMap = {}
  const ordered = []
  for (const divId of divs) {
    const cjFile = path.join(DATA_ROOT, bookId, divId, '_chapters.json')
    if (!fs.existsSync(cjFile)) continue
    const ch = JSON.parse(fs.readFileSync(cjFile, 'utf8'))
    for (const c of ch) {
      if (!(c.chapter_index in indexMap)) { indexMap[c.chapter_index] = ordered.length + 1; ordered.push(c) }
    }
    chapters = ordered
  }
  const titles = {}
  for (const c of ordered) titles[String(indexMap[c.chapter_index])] = c.chapter_title || ''
  // 段评映射
  const tkByGlobal = new Map()
  for (const divId of divs) {
    const tkDir = path.join(DATA_ROOT, bookId, divId, 'tsukkomi')
    const cjFile = path.join(DATA_ROOT, bookId, divId, '_chapters.json')
    if (!fs.existsSync(tkDir) || !fs.existsSync(cjFile)) continue
    const divChapters = JSON.parse(fs.readFileSync(cjFile, 'utf8'))
    for (const f of fs.readdirSync(tkDir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue
      const idx = f.replace(/^0+/, '').replace(/\.json$/, '')
      const match = divChapters.find(c => String(c.chapter_index) === idx)
      const gIdx = match ? indexMap[match.chapter_index] : null
      if (gIdx) tkByGlobal.set(gIdx, { file: f, divId })
    }
  }
  let tkTotal = 0
  const chTk = {}
  for (const [gIdx, { divId, file }] of tkByGlobal) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, bookId, divId, 'tsukkomi', file), 'utf8'))
      let n = 0
      for (const p of (j.paragraphs || [])) n += (p.tsukkomi || []).length
      chTk[gIdx] = n; tkTotal += n
    } catch {}
  }
  // 书名
  let bookName = ''
  try {
    const r = await apiPost('/book/get_info_by_id', { book_id: String(bookId) })
    const info = r?.data?.book_info || r?.data || {}
    bookName = info.book_name || ''
  } catch {}
  const meta = {
    book_id: String(bookId),
    book_name: bookName || ordered[0]?.chapter_title?.replace(/^第.+章\s*/, '') || bookId,
    author: '',
    chapter_count: ordered.length,
    has_tsukkomi: tkByGlobal.size > 0,
    tsukkomi_count: tkTotal,
    chapter_tsukkomi: chTk,
    built_at: new Date().toISOString(),
  }
  const files = []
  files.push({ name: 'meta.json', data: Buffer.from(JSON.stringify({ ...meta, titles }), 'utf8') })
  if (textDir && fs.existsSync(textDir)) {
    for (const c of ordered) {
      const pad = String(indexMap[c.chapter_index]).padStart(4, '0')
      for (const sub of ['book-chapters', 'chapters']) {
        const f = path.join(textDir, sub, pad + '.txt')
        if (fs.existsSync(f)) { files.push({ name: `chapters/${pad}.txt`, data: fs.readFileSync(f) }); break }
      }
    }
  }
  for (const [gIdx, { divId, file }] of tkByGlobal) {
    const pad = String(gIdx).padStart(4, '0')
    files.push({ name: `tsukkomi/${pad}.json`, data: fs.readFileSync(path.join(DATA_ROOT, bookId, divId, 'tsukkomi', file)) })
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `${bookId}.dbook`)
  buildDbook(meta, files, outFile)
  const size = fs.statSync(outFile).size
  return { meta, files: files.length, size, outFile, divisions: divs.length }
}

// ---- 起点（无卷，tsukkomi/NNNN.json 直接对应章节号；segments 转 paragraphs 供 App 读取） ----
async function packQidian(bookId, textDir) {
  const bdir = path.join(QIDIAN_ROOT, String(bookId))
  const cjFile = path.join(bdir, '_chapters.json')
  const tkDir = path.join(bdir, 'tsukkomi')
  if (!fs.existsSync(cjFile) || !fs.existsSync(tkDir)) throw new Error('起点书数据不完整（缺 _chapters.json 或 tsukkomi/）')
  const chapters = JSON.parse(fs.readFileSync(cjFile, 'utf8'))
  const titles = {}
  for (const c of chapters) titles[String(c.chapter_index)] = c.chapter_title || ''
  // 书名
  let bookName = ''
  try { bookName = JSON.parse(fs.readFileSync(path.join(bdir, '_book.json'), 'utf8')).book_name || '' } catch {}
  // 段评统计 + 文件表（segments → paragraphs）
  const files = []
  let tkTotal = 0
  const chTk = {}
  for (const f of fs.readdirSync(tkDir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue
    const j = JSON.parse(fs.readFileSync(path.join(tkDir, f), 'utf8'))
    const paragraphs = (j.segments || []).map(s => ({
      paragraph_index: s.segmentId,
      amount: String((s.tsukkomi || []).length),
      tsukkomi: s.tsukkomi || [],
    }))
    const n = paragraphs.reduce((a, p) => a + p.tsukkomi.length, 0)
    chTk[f.replace(/\.json$/, '')] = n
    tkTotal += n
    files.push({ name: `tsukkomi/${f}`, data: Buffer.from(JSON.stringify({ ...j, paragraphs }), 'utf8') })
  }
  const meta = {
    book_id: String(bookId),
    book_name: bookName || chapters[0]?.chapter_title?.replace(/^第.+章\s*/, '') || bookId,
    author: '',
    chapter_count: chapters.length,
    has_tsukkomi: files.length > 0,
    tsukkomi_count: tkTotal,
    chapter_tsukkomi: chTk,
    built_at: new Date().toISOString(),
  }
  files.unshift({ name: 'meta.json', data: Buffer.from(JSON.stringify({ ...meta, titles }), 'utf8') })
  if (textDir && fs.existsSync(textDir)) {
    for (const c of chapters) {
      const pad = String(c.chapter_index).padStart(4, '0')
      for (const sub of ['book-chapters', 'chapters']) {
        const f = path.join(textDir, sub, pad + '.txt')
        if (fs.existsSync(f)) { files.push({ name: `chapters/${pad}.txt`, data: fs.readFileSync(f) }); break }
      }
    }
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, `${bookId}.dbook`)
  buildDbook(meta, files, outFile)
  const size = fs.statSync(outFile).size
  return { meta, files: files.length, size, outFile, divisions: 1 }
}

// ---------- 日志 ----------
const logBuf = []
function log(msg, kind = '') {
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`
  logBuf.push({ line, kind })
  if (logBuf.length > 500) logBuf.splice(0, logBuf.length - 500)
  console.log(line)
}

// ---------- HTTP ----------
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>📦 段评打包面板</title>
<style>
:root { --bg:#16181d; --card:#1e2229; --fg:#e8eaed; --dim:#9aa0a6; --line:#2b3038; --acc:#e8a33d; --ok:#4ade80; --err:#f87171; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); color:var(--fg); font:14px/1.7 "Microsoft YaHei",sans-serif; padding:16px; max-width:900px; margin:0 auto; }
h1 { font-size:22px; margin-bottom:4px; } h1 .acc { color:var(--acc); }
.sub { color:var(--dim); font-size:12px; margin-bottom:16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:14px; }
.card h2 { font-size:15px; margin-bottom:10px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
label { display:block; font-size:12px; color:var(--dim); margin-bottom:4px; }
input, select { width:100%; padding:8px; background:#101216; border:1px solid var(--line); border-radius:6px; color:var(--fg); font-size:13px; }
.row { display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
button { padding:9px 16px; border:none; border-radius:6px; font-size:13px; cursor:pointer; background:var(--acc); color:#16181d; font-weight:700; }
button.ghost { background:#2a2f38; color:var(--fg); font-weight:400; }
button:disabled { opacity:.4; cursor:not-allowed; }
.book { background:#101216; border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:10px; }
.book .top { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
.book .name { font-size:15px; font-weight:700; }
.book .id { color:var(--dim); font-size:12px; }
.book .stats { font-size:12px; color:var(--dim); margin:6px 0; }
.book .stats b { color:var(--fg); }
.book .acts { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.book .txt { flex:1; min-width:140px; }
#log { background:#101216; border:1px solid var(--line); border-radius:8px; padding:10px; height:220px; overflow-y:auto; font:12px/1.7 Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
#log .ok { color:var(--ok); } #log .err { color:var(--err); }
.empty { color:var(--dim); text-align:center; padding:30px; }
.tag { display:inline-block; background:#2a2f38; color:var(--dim); border-radius:4px; padding:1px 8px; font-size:11px; margin-left:6px; }
@media (max-width:640px){ body{padding:10px} }
</style></head>
<body>
<h1>📦 段评<span class="acc">打包面板</span></h1>
<div class="sub">爬虫面板抓完（刺猬猫 8788 / 起点 8791）→ 这里一键打包 .dbook → 手机 App 导入段评/整书 · 输出到 dbook_out/</div>
<div class="card"><h2>🔑 登录态 <span id="tokenTag" class="tag">检查中…</span></h2></div>
<div class="card">
  <h2>📚 已抓取的书 <button id="btnRefresh" class="ghost" style="float:right">刷新</button></h2>
  <div id="bookList"><div class="empty">扫描中…</div></div>
</div>
<div class="card"><h2>📜 日志</h2><div id="log"></div></div>
<script>
const $ = id => document.getElementById(id)
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
function fmt(n) { return n >= 10000 ? (n/10000).toFixed(1) + '万' : String(n) }
function mb(n) { return (n/1048576).toFixed(1) + ' MB' }
async function load() {
  try {
    const st = await api('/api/status')
    $('tokenTag').textContent = st.token ? '已登录：' + st.token.nick + ' (' + st.token.account + ')' : '未登录'
    const books = st.books || []
    const el = $('bookList')
    if (!books.length) { el.innerHTML = '<div class="empty">还没抓到书 —— 先去「爬虫面板」(刺猬猫 8788 / 起点 8791) 抓段评</div>'; return }
    el.innerHTML = books.map(function(b) {
      return '<div class="book" id="bk-' + b.book_id + '">'
        + '<div class="top"><span class="name">' + esc(b.book_name || ('书 ' + b.book_id)) + ' <span class="tag">' + (b.platform === 'qidian' ? '起点' : '刺猬猫') + '</span></span><span class="id">book_id ' + b.book_id + ' · ' + b.divisions + ' 卷</span></div>'
        + '<div class="stats">章节 <b>' + b.chapters + '</b> · 段评 <b>' + fmt(b.tsukkomi_count) + '</b> 条 · 段评文件 <b>' + b.tk_files + '</b>' + (b.first_title ? ' · 首章「' + esc(b.first_title.slice(0, 20)) + '」' : '') + '</div>'
        + '<div class="acts">'
        + '<button data-act="tk" data-id="' + b.book_id + '" data-pf="' + b.platform + '">📦 打段评包</button>'
        + '<button class="ghost" data-act="full" data-id="' + b.book_id + '" data-pf="' + b.platform + '">📚 打完整书</button>'
        + '<input class="txt" id="txt-' + b.book_id + '" placeholder="完整书需正文目录（留空=仅段评）">'
        + '</div></div>'
    }).join('')
    el.querySelectorAll('[data-act]').forEach(function(btn) {
      btn.onclick = function() {
        const id = btn.dataset.id
        const withText = btn.dataset.act === 'full' ? ($('txt-' + id).value.trim() || null) : null
        pack(id, btn.dataset.act === 'full', withText, btn, btn.dataset.pf)
      }
    })
    // 日志
    if (st.log && st.log.length) { $('log').innerHTML = st.log.map(function(l){ return '<div class="' + l.kind + '">' + esc(l.line) + '</div>' }).join(''); $('log').scrollTop = 99999 }
  } catch(e) { $('bookList').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>' }
}
async function pack(bookId, full, textDir, btn, platform) {
  const orig = btn.textContent
  btn.disabled = true
  btn.textContent = '打包中…'
  try {
    const r = await api('/api/pack', { book_id: bookId, with_text: textDir, platform })
    if (r.ok) {
      logMsg('✅ ' + r.book_name + ' → ' + r.file + ' (' + r.size_mb + ' MB, ' + r.chapters + ' 章, ' + r.tsukkomi + ' 条段评' + (r.divisions > 1 ? ', ' + r.divisions + ' 卷' : '') + ')', 'ok')
      load()
    } else logMsg('❌ ' + r.error, 'err')
  } catch(e) { logMsg('❌ ' + e.message, 'err') }
  btn.disabled = false
  btn.textContent = orig
}
function logMsg(text, kind) {
  const el = $('log')
  el.innerHTML += '<div class="' + kind + '">' + esc(text) + '</div>'
  el.scrollTop = 99999
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
$('btnRefresh').onclick = load
load()
setInterval(load, 8000)
</script></body></html>`

// ---------- 服务 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE_HTML); return
  }
  if (req.method === 'GET' && p === '/api/status') {
    const t = readToken()
    let books = scanBooks()
    books = await fetchBookNames(books)
    send(200, { token: t ? { nick: t.nick_name, account: t.account } : null, books, log: logBuf })
    return
  }
  if (req.method === 'POST' && p === '/api/pack') {
    let body = ''
    for await (const c of req) body += c
    try {
      const { book_id, with_text, platform } = JSON.parse(body || '{}')
      const pf = platform === 'qidian' ? 'qidian' : 'ciweimao'
      const root = pf === 'qidian' ? QIDIAN_ROOT : DATA_ROOT
      if (!book_id || !fs.existsSync(path.join(root, String(book_id)))) { send(400, { ok: false, error: '没有这本书的数据' }); return }
      const r = await packBook(String(book_id), with_text || null, pf)
      log(`✅ ${r.meta.book_name} → ${r.outFile}（${(r.size/1048576).toFixed(1)} MB, ${r.meta.chapter_count} 章, ${r.meta.tsukkomi_count} 条段评${r.divisions > 1 ? ', ' + r.divisions + ' 卷' : ''}）`, 'ok')
      send(200, { ok: true, book_name: r.meta.book_name, file: r.outFile, size_mb: (r.size/1048576).toFixed(1), chapters: r.meta.chapter_count, tsukkomi: r.meta.tsukkomi_count, divisions: r.divisions })
    } catch (e) {
      log(`❌ 打包失败: ${e.message}`, 'err')
      send(500, { ok: false, error: String(e.message || e) })
    }
    return
  }
  send(404, { ok: false, error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`📦 段评打包面板: http://127.0.0.1:${PORT}`)
  console.log(`   刺猬猫数据: ${DATA_ROOT}`)
  console.log(`   起点数据: ${QIDIAN_ROOT}`)
  console.log(`   输出目录: ${OUT_DIR}`)
})
