// 爬虫数据 → .dbook 转换器
// 用法:
//   node build_dbook_from_crawler.mjs <book_id>                → 段评包 <book_id>.dbook（只含 tsukkomi/ + meta.json）
//   node build_dbook_from_crawler.mjs <book_id> --with-text <正文目录>  → 完整书（正文目录内 book-chapters/NNNN.txt 或 chapters/NNNN.txt）
//   node build_dbook_from_crawler.mjs --list                  → 列出已抓取的书
//
// 输入: ciweimao_data/<book_id>/<division_id>/tsukkomi/*.json + _chapters.json（爬虫面板产出）
// 输出: <book_id>.dbook（桌面 dsh 目录），可导入书架 App
import fs from 'node:fs'
import path from 'node:path'
import { createHash, createHmac, createDecipheriv, randomBytes } from 'node:crypto'
import zlib from 'node:zlib'

const APP_VERSION = '2.9.365'
const DEVICE_TOKEN = 'ciweimao_'
const AES_KEY_STR = 'sD6doAOcW7hm7iaeK6UlcdtAIWlZGlBr'
const HMAC_KEY = 'a90f3731745f1c30ee77cb13fc00005a'
const SIGNATURES = HMAC_KEY + 'CkMxWNB666'
const UA = 'Android  com.kuangxiangciweimao.novel.c  2.9.365, Xiaomi, 24030PN60G, 34, 14'
const _here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const DATA_ROOT = path.join(_here, 'ciweimao_data')
const TOKEN_FILE = path.join(_here, '_ciweimao_app_token.json')
const MAGIC = 'DLCBOOK1'

const sleep = ms => new Promise(r => setTimeout(r, ms))

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

// ---------- .dbook 写入 ----------
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

// ---------- 主逻辑 ----------
function listCrawled() {
  if (!fs.existsSync(DATA_ROOT)) { console.log('无 ciweimao_data 目录'); return }
  const books = fs.readdirSync(DATA_ROOT).filter(d => /^\d+$/.test(d))
  for (const bookId of books) {
    const bdir = path.join(DATA_ROOT, bookId)
    const divs = fs.readdirSync(bdir).filter(d => /^\d+$/.test(d))
    for (const divId of divs) {
      const cj = path.join(bdir, divId, '_chapters.json')
      const tk = path.join(bdir, divId, 'tsukkomi')
      if (!fs.existsSync(cj)) continue
      let n = 0, title = ''
      try {
        const ch = JSON.parse(fs.readFileSync(cj, 'utf8'))
        n = ch.length
        title = ch[0]?.chapter_title?.replace(/^第.+章\s*/, '') || ''
      } catch {}
      const tkCount = fs.existsSync(tk) ? fs.readdirSync(tk).filter(f => f.endsWith('.json') && !f.startsWith('_')).length : 0
      console.log(`  book_id=${bookId} 卷=${divId} 章节=${n} 段评文件=${tkCount} 首章=${title}`)
    }
  }
}

async function fetchBookInfo(bookId) {
  try {
    const r = await apiPost('/book/get_info_by_id', { book_id: String(bookId) })
    const info = r?.data?.book_info || r?.data || {}
    return {
      book_id: String(bookId),
      book_name: info.book_name || '',
      author: info.author_name || info.author || '',
    }
  } catch (e) {
    return { book_id: String(bookId), book_name: '', author: '' }
  }
}

function findDivs(bookId) {
  const bdir = path.join(DATA_ROOT, bookId)
  if (!fs.existsSync(bdir)) return []
  // ★数字排序，字典序会让 ≥10 卷乱序
  return fs.readdirSync(bdir).filter(d => /^\d+$/.test(d)).sort((a, b) => Number(a) - Number(b))
}

async function build(bookId, textDir) {
  const divs = findDivs(bookId)
  if (!divs.length) { console.error(`✗ 没找到 ${bookId} 的抓取数据（ciweimao_data/${bookId}/）`); process.exit(1) }

  // 合并所有卷的章节与段评（多卷书章节索引连续递增，tsukkomi 文件按章节号存）
  const chapters = []
  const tkFiles = []
  for (const divId of divs) {
    const base = path.join(DATA_ROOT, bookId, divId)
    const cjFile = path.join(base, '_chapters.json')
    const tkDir = path.join(base, 'tsukkomi')
    if (fs.existsSync(cjFile)) {
      const ch = JSON.parse(fs.readFileSync(cjFile, 'utf8'))
      // 章节索引可能跨卷重复（每卷从 1 开始）——按出现顺序重排成全局索引
      chapters.push(...ch)
    }
    if (fs.existsSync(tkDir)) {
      for (const f of fs.readdirSync(tkDir)) {
        if (f.endsWith('.json') && !f.startsWith('_')) tkFiles.push({ divId, file: f })
      }
    }
  }
  // 重排全局章节索引：跨卷时 chapters 数组顺序 = 阅读顺序，索引连续分配
  // ★每卷 chapter_index 都从 1 开始，只用 chapter_index 去重会丢掉卷2+全部章节。
  //   按出现顺序无条件分配全局序号（同卷同 index 只出现一次，天然正确）。
  const ordered = []
  const keyToGlobal = {} // 'divId:chapter_index' -> 全局序号（段评映射用）
  for (const divId of divs) {
    const cjFile = path.join(DATA_ROOT, bookId, divId, '_chapters.json')
    if (!fs.existsSync(cjFile)) continue
    const ch = JSON.parse(fs.readFileSync(cjFile, 'utf8'))
    for (const c of ch) {
      ordered.push(c)
      c._g = ordered.length
      keyToGlobal[divId + ':' + c.chapter_index] = ordered.length
    }
  }
  const chaptersFinal = ordered
  const titles = {}
  for (const c of chaptersFinal) titles[String(c._g)] = c.chapter_title || ''
  // 段评文件映射到全局序号：某卷内 tsukkomi/NNNN.json 对应同卷 _chapters.json 里 chapter_index=NNN 的全局序号
  // ★每卷 _chapters.json 只解析一次（原实现对每个段评文件重复读、缺文件直接崩溃）
  const divChapterCache = {}
  for (const divId of divs) {
    const cjFile = path.join(DATA_ROOT, bookId, divId, '_chapters.json')
    divChapterCache[divId] = fs.existsSync(cjFile) ? JSON.parse(fs.readFileSync(cjFile, 'utf8')) : []
  }
  const tkByGlobal = new Map()
  for (const { divId, file } of tkFiles) {
    const idx = file.replace(/^0+/, '').replace(/\.json$/, '')
    const divChapters = divChapterCache[divId] || []
    const match = divChapters.find(c => String(c.chapter_index) === idx)
    const globalIdx = match ? keyToGlobal[divId + ':' + match.chapter_index] : null
    if (globalIdx) tkByGlobal.set(globalIdx, { file, divId })
  }

  // 段评统计
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

  const meta = {
    book_id: String(bookId),
    book_name: '',
    author: '',
    chapter_count: chaptersFinal.length,
    has_tsukkomi: tkByGlobal.size > 0,
    tsukkomi_count: tkTotal,
    chapter_tsukkomi: chTk,
    built_at: new Date().toISOString(),
  }
  // 从接口补书名/作者
  const info = await fetchBookInfo(bookId)
  meta.book_name = info.book_name || meta.book_name || bookId
  meta.author = info.author

  // 文件表
  const files = []
  files.push({ name: 'meta.json', data: Buffer.from(JSON.stringify({ ...meta, titles }), 'utf8') })
  if (textDir) {
    for (const c of chaptersFinal) {
      const pad = String(c._g).padStart(4, '0')
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

  const outFile = path.join(_here, `${bookId}.dbook`)
  buildDbook(meta, files, outFile)
  console.log(`✅ ${meta.book_name} → ${outFile}`)
  console.log(`   章节 ${meta.chapter_count} · 段评 ${meta.tsukkomi_count} · 文件 ${files.length} · ${(fs.statSync(outFile).size/1024/1024).toFixed(1)} MB${textDir ? '（含正文）' : '（段评包）'}（卷数 ${divs.length}）`)
}

// ---------- CLI ----------
const args = process.argv.slice(2)
if (args.includes('--list')) {
  listCrawled()
} else {
  const bookId = args.find(a => /^\d+$/.test(a))
  if (!bookId) { console.log('用法: node build_dbook_from_crawler.mjs <book_id> [--with-text <正文目录>] | --list'); process.exit(1) }
  const ti = args.indexOf('--with-text')
  const textDir = ti >= 0 ? args[ti + 1] : null
  build(bookId, textDir)
}
