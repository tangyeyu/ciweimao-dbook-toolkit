// txt2shelf_panel.mjs —— txt 转书架 + 段评自动精校准可视化面板
// 端口 8793（argv[2] 或 TXT2SHELF_PORT 覆盖）
// 功能：txt 切章（固定格式）→ 段评源（起点爬虫数据 / .dbook 段评包）→ 滑窗标题自动校准
//       → 段评按校准重排 → 输出书架书目录（meta.json + chapters/ + tsukkomi/）→ 打包 .dbook
// 段落号对齐（起点）：seg N(N>=1) = txt 行 N；seg -1(章评)/-10(公告) → para 0（标题行）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const PORT = Number(process.env.TXT2SHELF_PORT || process.argv[2] || 8793)
const _here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const QIDIAN_ROOT = process.env.QIDIAN_DATA || path.join(_here, 'qidian_data')
const OUT_ROOT = path.join(_here, 'shelf_out')

// ---------- txt 切章（固定格式，与 txt2shelf.mjs 一致） ----------
const CN = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
const CN_UNIT = { '十': 10, '百': 100, '千': 1000, '万': 10000 }
function cnToNum(s) {
  s = s.trim()
  if (!s) return NaN
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (s === '十') return 10
  let total = 0, section = 0, num = 0
  for (const ch of s) {
    if (ch in CN) num = CN[ch]
    else if (ch in CN_UNIT) {
      const u = CN_UNIT[ch]
      section += (num || (u >= 1000 ? 1 : u === 10 && section === 0 ? 1 : num || 0)) * u
      if (u >= 10000) { total += section; section = 0 }
      num = 0
    } else return NaN
  }
  return total + section + num
}
function decodeText(buf, encArg) {
  const dw = enc => { try { return new TextDecoder(enc).decode(buf) } catch { return new TextDecoder('utf-8').decode(buf) } }
  if (encArg === 'utf8' || encArg === 'gbk') return dw(encArg)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return dw('gbk') }
}
const RE_CHAP = /^第([〇零一二三四五六七八九十百千0-9]+)章[\s:：、.．]*(.*)$/
const RE_VOL = /^第([〇零一二三四五六七八九十百千0-9]+)(卷|回)[\s:：、.．]*(.*)$/
function splitTxt(txtPath, encArg = 'auto') {
  const buf = fs.readFileSync(txtPath)
  const text = decodeText(buf, encArg)
  const chapters = []
  let cur = null, seen = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (RE_VOL.test(line)) continue
    const m = line.match(RE_CHAP)
    if (m) {
      seen = true
      const num = cnToNum(m[1])
      if (!isNaN(num)) {
        if (cur) chapters.push(cur)
        cur = { num, title: (m[2] || '').trim() || ('第' + m[1] + '章'), bodyLines: [] }
        continue
      }
    }
    if (cur) cur.bodyLines.push(line)
  }
  if (cur) chapters.push(cur)
  if (!seen && buf.length > 3 * 1024 * 1024) {
    chapters.length = 0
    let block = [], bytes = 0
    for (const raw of text.split(/\r?\n/)) {
      const s = raw.trim()
      if (!s) continue
      block.push(s); bytes += s.length * 2
      if (bytes > 500 * 1024) { chapters.push({ num: chapters.length + 1, title: '第' + (chapters.length + 1) + '部分', bodyLines: block }); block = []; bytes = 0 }
    }
    if (block.length) chapters.push({ num: chapters.length + 1, title: '第' + (chapters.length + 1) + '部分', bodyLines: block })
  }
  return chapters
}

// ---------- 标题归一化（校准用） ----------
const PREFIX_RE = /^第[〇零一二三四五六七八九十百千0-9]+章[\s:：、.．]*/
function normTitle(s) {
  if (!s) return ''
  return String(s)
    .replace(PREFIX_RE, '')
    .replace(/【[^】]*】/g, '')
    .replace(/[·•.．]/g, '·') // 统一间隔号（txt「·」vs 起点「.」）
    .replace(/[……]{2,}/g, '…')
    .replace(/[—–-]{2,}/g, '-')
    .replace(/[♡♥]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

// ---------- 自动精校准（滑窗标题匹配） ----------
// txtTitles: txt 章纯标题数组（1..N）；segTitles: 段评源标题数组（键=源章号字符串，值=标题原文）
// existing: 已有校准映射（优先复用，含手动修正；auto 只补缺）
// 返回 { aligned: {源章号: txt0基索引}, report: {matched, reused, skippedSource, skippedTxt, details[]} }
function calibrate(txtTitles, segTitles, existing) {
  const T = txtTitles.map(t => normTitle(t))
  const SKeys = Object.keys(segTitles)
  const S = SKeys.map(k => normTitle(segTitles[k]))
  const aligned = {}
  const report = { matched: 0, reused: 0, skippedSource: 0, skippedTxt: 0, details: [] }
  if (!S.length) return { aligned, report }
  // 0. 复用已有映射（之前校准结果/手动修正优先）
  if (existing) {
    for (const k of Object.keys(existing)) {
      const v = existing[k]
      if (segTitles[k] !== undefined && v >= 0 && v < T.length) {
        aligned[k] = v
        report.reused++
      }
    }
    if (report.reused) report.details.push(`复用已有校准映射 ${report.reused} 条`)
  }
  // 1. 起始偏移：用 T 前 15 章在 S 上滑窗找最优起点（连续匹配数最多）
  const win = Math.min(15, T.length)
  let bestStart = 0, bestScore = -1
  for (let off = 0; off <= Math.max(0, S.length - win); off++) {
    let score = 0
    for (let k = 0; k < win; k++) if (T[k] && T[k] === S[off + k]) score++
    if (score > bestScore) { bestScore = score; bestStart = off }
  }
  if (bestScore < Math.max(1, win / 3)) {
    report.details.push('⚠ 起始滑窗匹配度过低（' + bestScore + '/' + win + '），请检查段评源是否对应本书')
  }
  // 2. 从 bestStart 逐章推进：txt 每章在源当前位置窗口 ±6 内找精确标题匹配（已映射的源章跳过）
  let j = bestStart
  for (let i = 0; i < T.length; i++) {
    if (!T[i]) continue
    if (Object.values(aligned).includes(i)) { report.matched++; continue } // 已有映射（reuse）
    let found = -1
    for (let d = -6; d <= 12; d++) {
      const k = j + d
      if (k < 0 || k >= S.length) continue
      if (aligned[SKeys[k]] !== undefined) continue
      if (S[k] && S[k] === T[i]) { found = k; break }
    }
    if (found >= 0) {
      if (found > j) { // 跳过的源条目 = 源独有（公告/占位）
        for (let k = j; k < found; k++) {
          if (aligned[SKeys[k]] === undefined) { report.skippedSource++; report.details.push('源独有跳过: ' + (segTitles[SKeys[k]] || SKeys[k])) }
        }
      }
      aligned[SKeys[found]] = i
      report.matched++
      j = found + 1
    } else {
      report.skippedTxt++
      report.details.push('txt独有无段评: ' + txtTitles[i])
    }
  }
  // 源尾部残留
  for (; j < S.length; j++) {
    if (aligned[SKeys[j]] === undefined) { report.skippedSource++; report.details.push('源独有跳过: ' + (segTitles[SKeys[j]] || SKeys[j])) }
  }
  return { aligned, report }
}

// ---------- 段评源加载 ----------
// source: {type:'qidian', bookId} | {type:'dbook', dbookPath}
// 返回 { segTitles, tkDir, fileList }（fileList 不载入内容，重排时逐个读）
function loadSource(source) {
  if (source.type === 'qidian') {
    const bdir = path.join(QIDIAN_ROOT, String(source.bookId))
    const cjFile = path.join(bdir, '_chapters.json')
    const tkDir = path.join(bdir, 'tsukkomi')
    if (!fs.existsSync(cjFile) || !fs.existsSync(tkDir)) throw new Error('起点数据不存在: ' + bdir + '（缺 _chapters.json 或 tsukkomi/）')
    const chapters = JSON.parse(fs.readFileSync(cjFile, 'utf8'))
    const segTitles = {}
    for (const c of chapters) segTitles[String(c.chapter_index)] = c.chapter_title || ''
    const fileList = fs.readdirSync(tkDir).filter(f => f.endsWith('.json') && /^\d+\.json$/.test(f))
    let bookName = ''
    try { bookName = JSON.parse(fs.readFileSync(path.join(bdir, '_book.json'), 'utf8')).book_name || '' } catch {}
    // 已有校准映射（含手动修正）优先复用
    let existing = null
    try { existing = JSON.parse(fs.readFileSync(path.join(bdir, '_aligned.json'), 'utf8')) } catch {}
    return { segTitles, tkDir, fileList, bookName, isQidian: true, existing }
  }
  if (source.type === 'dbook') {
    if (!fs.existsSync(source.dbookPath)) throw new Error('找不到 dbook: ' + source.dbookPath)
    const buf = fs.readFileSync(source.dbookPath)
    if (buf.toString('ascii', 0, 8) !== 'DLCBOOK1') throw new Error('不是合法 dbook 文件')
    let off = 8
    const metaLen = buf.readUInt32LE(off); off += 4
    const meta = JSON.parse(buf.toString('utf8', off, off + metaLen)); off += metaLen
    const fileCount = buf.readUInt32LE(off); off += 4
    const segTitles = meta.titles || {}
    const tks = []
    for (let i = 0; i < fileCount; i++) {
      const nameLen = buf.readUInt32LE(off); off += 4
      const name = buf.toString('utf8', off, off + nameLen); off += nameLen
      const gzLen = buf.readUInt32LE(off); off += 4
      if (name.startsWith('tsukkomi/')) tks.push({ name: name.slice('tsukkomi/'.length), gz: buf.subarray(off, off + gzLen) })
      off += gzLen
    }
    return { segTitles, tkDir: null, fileList: tks, bookName: meta.book_name || '', isQidian: false, metaBookId: meta.book_id }
  }
  throw new Error('未知段评源类型: ' + source.type)
}

// ---------- 重排段评到 txt 序 ----------
// src: loadSource 结果；aligned: {源章号: txt0基}; txtN: txt 章数
// 输出 { meta.json, tsukkomi/NNNN.json } 写到 outDir
function rebuildTsukkomi(src, aligned, txtN, outDir, bookId, bookName, author) {
  const tkOut = path.join(outDir, 'tsukkomi')
  fs.mkdirSync(tkOut, { recursive: true })
  const chapter_tsukkomi = {}
  let total = 0, mapped = 0
  if (src.isQidian) {
    for (const f of src.fileList) {
      const qdIdx = f.replace(/\.json$/, '').replace(/^0+/, '') // 剥前导零：文件名 0001 → key "1"
      const t0 = aligned[qdIdx]
      if (t0 === undefined) continue
      const j = JSON.parse(fs.readFileSync(path.join(src.tkDir, f), 'utf8'))
      const paragraphs = (j.segments || []).map(s => {
        const segId = s.segmentId
        const pi = segId >= 1 ? segId : 0
        return {
          paragraph_index: pi,
          amount: String((s.tsukkomi || []).length),
          tsukkomi: (s.tsukkomi || []).map(tk => ({
            id: tk.id, para: tk.para, user: tk.user, uid: tk.uid, ip: tk.ip, content: tk.content,
            like: tk.like, unlike: tk.unlike, lou: tk.lou, reply: tk.reply,
            hot_reply: tk.hot_reply || '', time: tk.createTime || tk.time, essence: tk.essence, root: tk.root
          }))
        }
      })
      const outName = String(Number(t0) + 1).padStart(4, '0') + '.json'
      fs.writeFileSync(path.join(tkOut, outName), JSON.stringify({ book_id: bookId, chapter_id: j.chapter_id, paragraphs }, null, 1), 'utf8')
      const cnt = paragraphs.reduce((a, p) => a + (p.tsukkomi ? p.tsukkomi.length : 0), 0)
      total += cnt
      chapter_tsukkomi[String(Number(t0) + 1)] = cnt
      mapped++
    }
  } else {
    // dbook 源：tsukkomi 文件已含 paragraphs（直接复用），按源标题映射重命名
    for (const tk of src.fileList) {
      const segKey = tk.name.replace(/\.json$/, '').replace(/^0+/, '')
      const t0 = aligned[segKey]
      if (t0 === undefined) continue
      const j = JSON.parse(zlib.gunzipSync(tk.gz).toString('utf8'))
      const outName = String(Number(t0) + 1).padStart(4, '0') + '.json'
      fs.writeFileSync(path.join(tkOut, outName), JSON.stringify(j, null, 1), 'utf8')
      const cnt = (j.paragraphs || []).reduce((a, p) => a + (p.tsukkomi ? p.tsukkomi.length : 0), 0)
      total += cnt
      chapter_tsukkomi[String(Number(t0) + 1)] = cnt
      mapped++
    }
  }
  // meta.json
  const titles = {}
  for (let i = 0; i < txtN; i++) titles[String(i + 1)] = txtTitlesCache[i] || ''
  const meta = {
    book_id: String(bookId),
    book_name: bookName,
    author: author || '',
    chapter_count: txtN,
    has_tsukkomi: mapped > 0,
    tsukkomi_count: total,
    chapter_tsukkomi,
    titles,
    source: 'txt2shelf',
    aligned: true,
    updated_at: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1), 'utf8')
  return { mapped, total, meta }
}
let txtTitlesCache = []

// ---------- 打包 dbook ----------
function buildDbook(meta, files, outFile) {
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8')
  const parts = [Buffer.from('DLCBOOK1', 'ascii')]
  const mb = Buffer.alloc(4); mb.writeUInt32LE(metaBuf.length, 0); parts.push(mb)
  parts.push(metaBuf)
  const fc = Buffer.alloc(4); fc.writeUInt32LE(files.length, 0); parts.push(fc)
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const nl = Buffer.alloc(4); nl.writeUInt32LE(nameBuf.length, 0); parts.push(nl)
    parts.push(nameBuf)
    const gz = zlib.gzipSync(f.data)
    const gl = Buffer.alloc(4); gl.writeUInt32LE(gz.length, 0); parts.push(gl)
    parts.push(gz)
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, Buffer.concat(parts))
}

// ---------- HTTP ----------
const logBuf = []
function log(msg) {
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`
  logBuf.push(line)
  if (logBuf.length > 500) logBuf.splice(0, logBuf.length - 500)
  console.log(line)
}
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
  let url
  try { url = new URL(req.url, 'http://x') } catch { return json(res, 400, { error: 'bad request' }) }
  const p = url.pathname
  try {
    if (req.method === 'GET' && p === '/') return res.end(PAGE_HTML)
    if (req.method === 'GET' && p === '/api/log') return json(res, 200, { log: logBuf.slice(-80) })
    if (req.method === 'POST' && p === '/api/pipeline') {
      // 一键：txt 转换 + 段评加载 + 自动校准 + 重排
      const b = await readBody(req)
      const txtPath = b.txt
      if (!txtPath || !fs.existsSync(txtPath)) return json(res, 400, { error: 'txt 文件不存在: ' + txtPath })
      const src = loadSource(b.source || { type: 'qidian', bookId: b.bookId })
      // 1. 切章
      const chapters = splitTxt(txtPath, b.encoding || 'auto')
      if (!chapters.length) return json(res, 400, { error: 'txt 未切到任何章节' })
      txtTitlesCache = chapters.map(c => c.title)
      // 2. 校准（复用已有映射优先，滑窗补缺）
      const { aligned, report } = calibrate(txtTitlesCache, src.segTitles, src.existing)
      // 3. 输出书目录（bookId 优先 -- 段评源一致则直接匹配；否则 txt hash）
      let bookId = String(b.bookId || src.metaBookId || ('txt' + crypto.createHash('md5').update(path.basename(txtPath)).digest('hex').slice(0, 8)))
      const bookName = b.bookName || src.bookName || path.basename(txtPath).replace(/\.txt$/i, '').trim()
      const author = b.author || ''
      const outDir = path.join(OUT_ROOT, bookId)
      fs.mkdirSync(outDir, { recursive: true })
      const cdir = path.join(outDir, 'chapters')
      fs.mkdirSync(cdir, { recursive: true })
      for (let i = 0; i < chapters.length; i++) {
        fs.writeFileSync(path.join(cdir, String(i + 1).padStart(4, '0') + '.txt'), chapters[i].title + '\n' + chapters[i].bodyLines.join('\n'), 'utf8')
      }
      const r = rebuildTsukkomi(src, aligned, chapters.length, outDir, bookId, bookName, author)
      log(`✅ 转换+校准完成: ${bookName} (${bookId}) txt ${chapters.length} 章, 段评 ${r.mapped} 章 ${r.total} 条`)
      return json(res, 200, { ok: true, bookId, bookName, txtChapters: chapters.length, mapped: r.mapped, total: r.total, report, outDir })
    }
    if (req.method === 'POST' && p === '/api/pack') {
      const b = await readBody(req)
      const outDir = path.join(OUT_ROOT, String(b.bookId))
      const metaPath = path.join(outDir, 'meta.json')
      if (!fs.existsSync(metaPath)) return json(res, 400, { error: '未找到书目录，先执行转换' })
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      const files = [{ name: 'meta.json', data: fs.readFileSync(metaPath) }]
      const chaptersDir = path.join(outDir, 'chapters')
      if (fs.existsSync(chaptersDir)) {
        for (const f of fs.readdirSync(chaptersDir).filter(f => f.endsWith('.txt')).sort()) files.push({ name: 'chapters/' + f, data: fs.readFileSync(path.join(chaptersDir, f)) })
      }
      const tkDir = path.join(outDir, 'tsukkomi')
      if (fs.existsSync(tkDir)) {
        for (const f of fs.readdirSync(tkDir).filter(f => f.endsWith('.json')).sort()) files.push({ name: 'tsukkomi/' + f, data: fs.readFileSync(path.join(tkDir, f)) })
      }
      const outFile = path.join(OUT_ROOT, String(b.bookId) + '.dbook')
      buildDbook(meta, files, outFile)
      log(`📦 打包完成: ${outFile} (${(fs.statSync(outFile).size / 1048576).toFixed(2)}MB, ${files.length} 文件)`)
      return json(res, 200, { ok: true, outFile, files: files.length, size: fs.statSync(outFile).size })
    }
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    log('❌ ' + String(e.message || e))
    return json(res, 500, { error: String(e.message || e) })
  }
})

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>txt2shelf 转换校准面板</title>
<style>
:root{--bg:#13151a;--card:#1b1e25;--fg:#b9bec9;--dim:#767c8a;--acc:#e8a33d;--line:#252a33;--ok:#4ade80;--err:#f87171}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:14px/1.6 'Microsoft YaHei',sans-serif;padding:20px;max-width:960px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px}.sub{color:var(--dim);font-size:12px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
label{display:block;color:var(--dim);font-size:12px;margin:10px 0 4px}
input,select{width:100%;background:#0f1116;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:8px 10px;font-size:13px}
input:focus,select:focus{outline:none;border-color:var(--acc)}
.row{display:flex;gap:10px}.row>*{flex:1}
button{background:var(--acc);color:#1a1206;border:none;border-radius:6px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;margin-top:14px}
button.ghost{background:transparent;color:var(--acc);border:1px solid var(--acc)}
button:disabled{opacity:.45;cursor:not-allowed}
#log{background:#0f1116;border:1px solid var(--line);border-radius:8px;padding:10px;height:220px;overflow:auto;font:12px/1.5 Consolas,monospace;white-space:pre-wrap;color:#9aa4b2}
#report{margin-top:10px;font-size:13px}
.kpi{display:inline-block;background:#0f1116;border:1px solid var(--line);border-radius:6px;padding:4px 10px;margin:2px 6px 2px 0;font-size:12px}
.kpi b{color:var(--acc)}
.ok{color:var(--ok)}.err{color:var(--err)}
details{margin-top:8px}summary{cursor:pointer;color:var(--dim);font-size:12px}
.detail{font-size:11px;color:var(--dim);max-height:180px;overflow:auto;padding-left:14px;border-left:2px solid var(--line);margin-top:4px}
</style></head>
<body>
<h1>📚 txt2shelf 转换 · 自动校准面板</h1>
<div class="sub">txt 转书架固定格式 + 段评源自动精校准（滑窗标题匹配）→ 输出书架书目录 / 打包 .dbook</div>

<div class="card">
  <label>小说 txt 文件路径（本机绝对路径）</label>
  <input id="txt" placeholder="C:\\Users\\...\\xxx.txt" value="">
  <div class="row">
    <div><label>txt 编码</label>
      <select id="enc"><option value="auto">auto（自动识别）</option><option value="utf8">utf8</option><option value="gbk">gbk</option></select></div>
    <div><label>段评来源</label>
      <select id="srcType"><option value="qidian">起点爬虫数据（qidian_data）</option><option value="dbook">.dbook 段评包</option></select></div>
  </div>
  <div class="row" id="qidianRow">
    <div><label>起点 book_id（qidian_data 目录下）</label><input id="bookId" placeholder="如 1014892472"></div>
  </div>
  <div id="dbookRow" style="display:none">
    <label>.dbook 段评包路径</label><input id="dbookPath" placeholder="C:\\...\\1014892472.dbook">
  </div>
  <div class="row">
    <div><label>book_id 覆盖（可选，段评包一致则免自检）</label><input id="bookIdOv" placeholder="留空自动"></div>
    <div><label>书名（可选）</label><input id="bookName" placeholder="留空自动取文件名"></div>
    <div><label>作者（可选）</label><input id="author" placeholder="如 宇宙鸽"></div>
  </div>
  <button id="btnRun">▶ 一键转换 + 自动校准 + 重排</button>
  <button id="btnPack" class="ghost" disabled>📦 打包 .dbook</button>
  <div id="report"></div>
</div>

<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <b>运行日志</b><button id="btnLog" class="ghost" style="margin:0;padding:3px 10px;font-size:12px">刷新</button>
  </div>
  <div id="log"></div>
</div>

<script>
var lastBookId = ''
function $(id){return document.getElementById(id)}
function logln(s){$('log').textContent += s + '\\n'; $('log').scrollTop = $('log').scrollHeight}
$('srcType').onchange = function(){
  $('qidianRow').style.display = this.value === 'qidian' ? '' : 'none'
  $('dbookRow').style.display = this.value === 'dbook' ? '' : 'none'
}
async function api(path, body){
  var r = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{})})
  return r.json()
}
$('btnRun').onclick = async function(){
  var b = {txt: $('txt').value.trim(), encoding: $('enc').value, source:{}}
  if (!$('txt').value.trim()) { alert('请填写 txt 路径'); return }
  if ($('srcType').value === 'qidian') { b.source = {type:'qidian', bookId: $('bookId').value.trim()} }
  else { b.source = {type:'dbook', dbookPath: $('dbookPath').value.trim()} }
  if ($('bookIdOv').value.trim()) b.bookId = $('bookIdOv').value.trim()
  if ($('bookName').value.trim()) b.bookName = $('bookName').value.trim()
  if ($('author').value.trim()) b.author = $('author').value.trim()
  this.disabled = true; $('btnPack').disabled = true
  logln('>>> 开始转换+校准…')
  try {
    var r = await api('/api/pipeline', b)
    if (!r.ok) { logln('❌ ' + (r.error||'失败')); return }
    lastBookId = r.bookId
    var rep = r.report
    var html = '<span class="kpi">📖 txt <b>' + r.txtChapters + '</b> 章</span>'
      + '<span class="kpi">🔗 段评匹配 <b>' + rep.matched + '</b> 章</span>'
      + '<span class="kpi">⏭ 源独有跳过 <b>' + rep.skippedSource + '</b> 条</span>'
      + '<span class="kpi">📝 txt 无段评 <b>' + rep.skippedTxt + '</b> 章</span>'
      + '<span class="kpi">💬 段评总数 <b>' + r.total + '</b> 条</span>'
      + '<div class="ok">✅ book_id=' + r.bookId + ' · ' + r.bookName + ' → ' + r.outDir + '</div>'
    if (rep.details && rep.details.length) {
      html += '<details><summary>校准明细（' + rep.details.length + ' 条）</summary><div class="detail">' + rep.details.join('<br>') + '</div></details>'
    }
    $('report').innerHTML = html
    $('btnPack').disabled = false
    logln('✅ 完成：' + r.bookId + '，段评 ' + r.mapped + ' 章 ' + r.total + ' 条，可打包')
  } catch(e) { logln('❌ ' + e.message) } finally { this.disabled = false }
}
$('btnPack').onclick = async function(){
  if (!lastBookId) return
  logln('>>> 打包…')
  var r = await api('/api/pack', {bookId: lastBookId})
  if (r.ok) { logln('📦 ' + r.outFile + '（' + (r.size/1048576).toFixed(2) + 'MB，' + r.files + ' 文件）'); alert('打包完成：' + r.outFile) }
  else logln('❌ ' + (r.error||'失败'))
}
$('btnLog').onclick = async function(){
  $('log').textContent = ''
  var r = await (await fetch('/api/log')).json()
  $('log').textContent = (r.log||[]).join('\\n')
}
$('btnLog').onclick()
</script></body></html>`

server.listen(PORT, '127.0.0.1', () => {
  log(`txt2shelf 校准面板 http://127.0.0.1:${PORT}`)
})
