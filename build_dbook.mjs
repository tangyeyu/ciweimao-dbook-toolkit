// .dbook 导入包打包工具（书架 App 用）
// 零依赖 Node。把「书目录」打成 .dbook 单文件，手机端导入书架。
// 用法: node build_dbook.mjs <书目录> <输出.dbook>
// 书目录结构:
//   chapters.json       [{index,title,file}] 或 {book,author,chapters:[...]}
//   book-chapters/0001.txt   正文（每行一段，首行标题）
//   tsukkomi/0001.json       段评（可选，simplify 格式 {paragraphs:[{paragraph_index,tsukkomi:[...]}]}）
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = 'DLCBOOK1'

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b }
function str(s) { const b = Buffer.from(s, 'utf8'); return b }

function build(bookDir, outFile, tsukkomiOnly) {
  // ---- 元信息 ----
  const cjRaw = JSON.parse(fs.readFileSync(path.join(bookDir, 'chapters.json'), 'utf8'))
  const chapters = Array.isArray(cjRaw.chapters) ? cjRaw.chapters : cjRaw
  const bookName = cjRaw.book || path.basename(bookDir)
  const author = cjRaw.author || ''
  const hasTk = fs.existsSync(path.join(bookDir, 'tsukkomi'))

  // 统计段评数 + 每章段评数
  let tkTotal = 0
  const chTk = {}
  if (hasTk) {
    const tks = fs.readdirSync(path.join(bookDir, 'tsukkomi')).filter(f => f.endsWith('.json'))
    for (const f of tks) {
      const idx = f.replace(/^0+/, '').replace(/\.json$/, '')
      try {
        const j = JSON.parse(fs.readFileSync(path.join(bookDir, 'tsukkomi', f), 'utf8'))
        let n = 0
        for (const p of (j.paragraphs || [])) n += (p.tsukkomi || []).length
        chTk[idx] = n
        tkTotal += n
      } catch {}
    }
  }

  const meta = {
    book_id: cjRaw.bookId || path.basename(bookDir),
    book_name: bookName,
    author,
    chapter_count: chapters.length,
    has_tsukkomi: hasTk,
    tsukkomi_count: tkTotal,
    chapter_tsukkomi: chTk,
    built_at: new Date().toISOString(),
  }
  // 章节标题表
  const titles = {}
  for (const c of chapters) titles[String(c.index)] = c.title || ''

  // ---- 组装文件表 ----
  const files = []
  // meta.json 始终带（段评包也带完整 meta，方便 App 校验 book_id 匹配）
  files.push({ name: 'meta.json', data: Buffer.from(JSON.stringify({ ...meta, titles }), 'utf8') })
  // 正文（tsukkomi-only 不打包正文）
  if (!tsukkomiOnly) {
    for (const c of chapters) {
      const f = path.join(bookDir, 'book-chapters', `${String(c.index).padStart(4, '0')}.txt`)
      if (fs.existsSync(f)) files.push({ name: `chapters/${String(c.index).padStart(4, '0')}.txt`, data: fs.readFileSync(f) })
    }
  }
  // 段评
  if (hasTk) {
    for (const c of chapters) {
      const f = path.join(bookDir, 'tsukkomi', `${String(c.index).padStart(4, '0')}.json`)
      if (fs.existsSync(f)) files.push({ name: `tsukkomi/${String(c.index).padStart(4, '0')}.json`, data: fs.readFileSync(f) })
    }
  }

  // ---- 写 .dbook ----
  const parts = []
  parts.push(Buffer.from(MAGIC, 'ascii'))
  const metaBuf = JSON.stringify(meta)
  parts.push(u32(Buffer.byteLength(metaBuf, 'utf8')), Buffer.from(metaBuf, 'utf8'))
  parts.push(u32(files.length))
  for (const f of files) {
    const gz = zlib.gzipSync(f.data, { level: 9 })
    const nameBuf = str(f.name)
    parts.push(u32(nameBuf.length), nameBuf, u32(gz.length), gz)
  }
  const out = Buffer.concat(parts)
  fs.writeFileSync(outFile, out)
  return { meta, fileCount: files.length, outSize: out.length }
}

const args = process.argv.slice(2)
const tsukkomiOnly = args.includes('--tsukkomi-only')
const [bookDir, outFile] = args.filter(a => !a.startsWith('--'))
if (!bookDir || !outFile) {
  console.log('用法: node build_dbook.mjs <书目录> <输出.dbook> [--tsukkomi-only]')
  console.log('  --tsukkomi-only  只打包段评（tsukkomi/ + meta.json），供书架 App「导入段评」用')
  process.exit(1)
}
const r = build(bookDir, outFile, tsukkomiOnly)
console.log(`✅ ${r.meta.book_name} → ${outFile}`)
console.log(`   模式 ${tsukkomiOnly ? '段评包(tsukkomi-only)' : '完整书'} · 章节 ${r.meta.chapter_count}, 段评 ${r.meta.tsukkomi_count}, 文件 ${r.fileCount} 个, ${(r.outSize / 1024 / 1024).toFixed(1)} MB`)
