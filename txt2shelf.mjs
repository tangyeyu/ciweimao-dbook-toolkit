// txt2shelf.mjs —— 小说 txt → 段评书架固定格式（txt2shelf 标准）
// 输出目录结构与段评书架 App / .dbook 段评包完全兼容：
//   <输出目录>/meta.json         书元数据（book_id/book_name/author/chapter_count/titles…）
//   <输出目录>/chapters/NNNN.txt 每章一文件（首行=章标题原文，NNNN=txt 全局章号）
//   <输出目录>/_txt_chapters.json 章索引（index/txtNum/title/lines）
// 用法:
//   node txt2shelf.mjs <txt路径> <输出目录> [选项]
// 选项:
//   --encoding=utf8|gbk|auto  编码（默认 auto：先严格 UTF-8 失败回退 GBK）
//   --book-id=xxx             书 ID（★关键：与 .dbook 段评包 meta.book_id 一致则段评直接按文件名挂载）
//   --book-name=xxx           书名（默认取文件名去扩展名）
//   --author=xxx              作者
//   --dbook=out.dbook         同时打包成 .dbook 完整书（无段评），App「导入书」后配合同 book_id 段评包
// 固定格式约定（与 packQidian 重排版 / App parseDbook 对齐）:
//   1. 切章只认「第X章」（中文/阿拉伯数字都认）；「第X卷/第X回」是分卷标题，跳过不切章
//   2. chapters/NNNN.txt 文件名 = txt 全局章号（0001 起），段评包 tsukkomi/NNNN.json 同名即匹配
//   3. meta.titles[N] = 剥「第X章」前缀后的纯标题（与段评包 titles 一致）
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

// ---------- 参数 ----------
const args = process.argv.slice(2)
function argVal(name) {
  const eq = args.find(a => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  // 兼容 `--name value` 空格格式
  const i = args.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1]
  return undefined
}
const txtPath = args[0]
const outDir = args[1]
const encArg = argVal('encoding') || 'auto'
const bookId = argVal('book-id')
const bookNameArg = argVal('book-name')
const authorArg = argVal('author') || ''
const dbookOut = argVal('dbook')
if (!txtPath || !outDir) {
  console.error('用法: node txt2shelf.mjs <txt> <输出目录> [--encoding utf8|gbk|auto] [--book-id x] [--book-name x] [--author x] [--dbook out.dbook]')
  process.exit(1)
}
if (!fs.existsSync(txtPath)) { console.error('找不到文件:', txtPath); process.exit(1) }

// ---------- 编码检测 ----------
function decode(buf) {
  if (encArg === 'utf8' || encArg === 'gbk') return decodeWith(buf, encArg)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return decodeWith(buf, 'gbk') }
}
function decodeWith(buf, enc) {
  try { return new TextDecoder(enc).decode(buf) } catch { return new TextDecoder('utf-8').decode(buf) }
}

// ---------- 中文数字转阿拉伯 ----------
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

// ---------- 切章（固定格式） ----------
const buf = fs.readFileSync(txtPath)
const text = decode(buf)
const lines = text.split(/\r?\n/)
const RE_CHAP = /^第([〇零一二三四五六七八九十百千0-9]+)章[\s:：、.．]*(.*)$/
const RE_VOL = /^第([〇零一二三四五六七八九十百千0-9]+)(卷|回)[\s:：、.．]*(.*)$/

const chapters = [] // {num, title, bodyLines[]}
let cur = null
let seenAnyChap = false
for (const raw of lines) {
  const line = raw.trim()
  if (!line) continue
  if (RE_VOL.test(line)) continue // 分卷标题行：跳过
  const m = line.match(RE_CHAP)
  if (m) {
    seenAnyChap = true
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
if (!seenAnyChap) {
  // 全书无「第X章」标题：按 500KB 一块切，标题「第N部分」（与 App parseTxt 兜底一致）
  console.warn('⚠ 未找到「第X章」标题行，按 500KB 块切分')
  chapters.length = 0
  let block = [], bytes = 0
  for (const raw of lines) {
    const s = raw.trim()
    if (!s) continue
    block.push(s); bytes += s.length * 2
    if (bytes > 500 * 1024) { chapters.push({ num: chapters.length + 1, title: '第' + (chapters.length + 1) + '部分', bodyLines: block }); block = []; bytes = 0 }
  }
  if (block.length) chapters.push({ num: chapters.length + 1, title: '第' + (chapters.length + 1) + '部分', bodyLines: block })
}
console.log(`共 ${chapters.length} 章`)
if (chapters.length === 0) { console.error('未切到任何章节'); process.exit(1) }

// ---------- 输出固定格式 ----------
fs.mkdirSync(outDir, { recursive: true })
const cdir = path.join(outDir, 'chapters')
fs.mkdirSync(cdir, { recursive: true })
const titles = {}
const idx = []
for (let i = 0; i < chapters.length; i++) {
  const c = chapters[i]
  const fn = path.join(cdir, String(i + 1).padStart(4, '0') + '.txt')
  fs.writeFileSync(fn, c.title + '\n' + c.bodyLines.join('\n'), 'utf8')
  titles[String(i + 1)] = c.title
  idx.push({ index: i + 1, txtNum: c.num, title: c.title, lines: c.bodyLines.length + 1 })
}
fs.writeFileSync(path.join(outDir, '_txt_chapters.json'), JSON.stringify(idx, null, 1), 'utf8')

// meta.json（与段评包 meta 结构一致：titles 为剥前缀纯标题）
const fname = path.basename(txtPath).replace(/\.txt$/i, '').trim() || 'book'
const meta = {
  book_id: bookId || ('txt' + crypto.createHash('md5').update(fname).digest('hex').slice(0, 8)),
  book_name: bookNameArg || fname,
  author: authorArg,
  chapter_count: chapters.length,
  has_tsukkomi: false,
  tsukkomi_count: 0,
  chapter_tsukkomi: {},
  titles,
  source: 'txt2shelf',
  aligned: true,
  updated_at: new Date().toISOString(),
}
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1), 'utf8')

console.log('book_id:', meta.book_id)
console.log('前 5 章:', chapters.slice(0, 5).map(c => `#${c.num} ${c.title}`).join(' | '))
console.log('末 5 章:', chapters.slice(-5).map(c => `#${c.num} ${c.title}`).join(' | '))
console.log('输出到', outDir)

// ---------- 可选：打包 .dbook（DLCBOOK1 格式，与 build_dbook.mjs 一致） ----------
if (dbookOut) {
  const files = [{ name: 'meta.json', data: Buffer.from(JSON.stringify(meta), 'utf8') }]
  for (let i = 1; i <= chapters.length; i++) {
    const pad = String(i).padStart(4, '0')
    files.push({ name: `chapters/${pad}.txt`, data: fs.readFileSync(path.join(cdir, pad + '.txt')) })
  }
  // MAGIC(8B) + u32 metaLen + meta + u32 fileCount + 每文件(u32 nameLen+name+u32 gzLen+gzip)
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
  fs.writeFileSync(dbookOut, Buffer.concat(parts))
  console.log('dbook 已打包:', dbookOut, `(${(fs.statSync(dbookOut).size / 1048576).toFixed(2)}MB, ${files.length} 文件)`)
}
