// 生成目录页 index.html（书封 + 搜索 + 章节列表 + 每章吐槽数）
import fs from 'node:fs'
import path from 'node:path'

const BOOK_DIR = process.env.BOOK_DIR || path.join(process.cwd(), 'book')
const meta = JSON.parse(fs.readFileSync(path.join(BOOK_DIR, 'chapters.json'), 'utf8'))

// 统计每章吐槽数
const BOOK_NAME = meta.book || 'book'
const AUTHOR = meta.author || ''
const TOTAL = meta.total || meta.chapters.length
const counts = []
let totalTk = 0
for (let i = 1; i <= TOTAL; i++) {
  const f = path.join(BOOK_DIR, 'tsukkomi', `${String(i).padStart(4, '0')}.json`)
  let n = 0
  if (fs.existsSync(f)) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'))
      n = d.paragraphs.reduce((s, p) => s + p.tsukkomi.length, 0)
    } catch (e) { n = 0 }
  }
  counts.push(n)
  totalTk += n
}
const done = counts.filter(n => n > 0).length
console.log(`有段评章节: ${done}/${TOTAL}, 总吐槽: ${totalTk}`)

// 章节目录行
const rows = meta.chapters.map(c => {
  const n = counts[c.index - 1] || 0
  return `<a class="row" href="chapter/${String(c.index).padStart(4, '0')}.html" data-k="${c.title}">
  <span class="ci">${String(c.index).padStart(3, '0')}</span>
  <span class="ct">${c.title}</span>
  ${n ? `<span class="cb">💬 ${n}</span>` : '<span class="cb none">·</span>'}
</a>`
}).join('\n')

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${BOOK_NAME}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg:#1a1c22;--fg:#c8ccd4;--card:#242731;--line:#333846;--accent:#e8a33d}
body{background:var(--bg);color:var(--fg);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding-bottom:env(safe-area-inset-bottom)}
.hero{padding:36px 20px 22px;text-align:center;background:linear-gradient(160deg,#232838 0%,#1a1c22 70%)}
.cover{width:96px;height:132px;margin:0 auto 14px;border-radius:10px;background:linear-gradient(150deg,#3d2f56,#241d36);display:flex;align-items:center;justify-content:center;font-size:34px;color:#d9c9a3;box-shadow:0 8px 24px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08)}
.hero h1{font-size:22px;color:#e8eaef;letter-spacing:.08em}
.hero .author{font-size:13px;color:var(--dim,#6a7180);margin-top:6px}
.hero .stat{font-size:12px;color:#8a93a5;margin-top:10px}
.search{position:sticky;top:0;z-index:10;padding:10px 14px;background:rgba(26,28,34,.96);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.search input{width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;color:var(--fg);font-size:15px;padding:9px 14px;outline:none}
.search input::placeholder{color:#5d6472}
.list{max-width:720px;margin:0 auto;padding:6px 14px 60px}
.row{display:flex;align-items:center;gap:10px;padding:11px 10px;border-bottom:1px solid rgba(255,255,255,.045);text-decoration:none;color:var(--fg)}
.row:active{background:rgba(255,255,255,.05)}
.ci{font-size:12px;color:#5d6472;width:34px;flex-shrink:0;font-variant-numeric:tabular-nums}
.ct{flex:1;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cb{font-size:11px;color:#f0c877;background:rgba(232,163,61,.1);border-radius:999px;padding:2px 8px;flex-shrink:0}
.cb.none{background:none;color:#3a3f4a}
.none-hint{display:none}
</style>
</head>
<body>
<div class="hero">
  <div class="cover">📖</div>
  <h1>${BOOK_NAME}</h1>
  <div class="author">${AUTHOR ? `作者：${AUTHOR}` : ''}</div>
  <div class="stat">共 ${TOTAL} 章 · 段评 <b id="tkTotal">${totalTk}</b> 条 · <b>${done}</b> 章有评论</div>
</div>
<div class="search"><input id="q" placeholder="搜索章节号或标题…" autocomplete="off"></div>
<div class="list" id="list">
${rows}
</div>
<script>
const q = document.getElementById('q')
q.addEventListener('input', () => {
  const kw = q.value.trim().toLowerCase()
  const rows = document.querySelectorAll('.row')
  rows.forEach(r => {
    const k = (r.dataset.k || '').toLowerCase() + ' ' + r.querySelector('.ci').textContent.trim()
    r.style.display = (!kw || k.includes(kw)) ? 'flex' : 'none'
  })
})
</script>
</body>
</html>`

fs.writeFileSync(path.join(BOOK_DIR, 'reader', 'index.html'), html)
console.log('index.html 已生成')
