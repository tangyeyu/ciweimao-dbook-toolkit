// 生成 HTML 阅读器（正文段落 + 段评弹层）
// 用法: node gen_reader_html.mjs [起始章] [结束章]  不传参=只跑第一章(001-005已有数据的也生成)
import fs from 'node:fs'
import path from 'node:path'

const BOOK_DIR = process.env.BOOK_DIR || path.join(process.cwd(), 'book')
const OUT_DIR = path.join(BOOK_DIR, 'reader')
const CH_OUT = path.join(OUT_DIR, 'chapter')

const meta = JSON.parse(fs.readFileSync(path.join(BOOK_DIR, 'chapters.json'), 'utf8'))
const chapters = meta.chapters
const BOOK_NAME = meta.book || 'book'
const TOTAL = meta.total || chapters.length

// 表情代码简单替换
const EMOJI_MAP = {
  '#(可爱)': '😊', '#(笑)': '😄', '#(泪)': '😭', '#(怒)': '😠', '#(汗)': '😅',
  '#(囧)': '😳', '#(无语)': '😑', '#(滑稽)': '😏', '#(惊喜)': '😮', '#(心)': '❤️',
}
function fmtEmoji(s) {
  if (!s) return s
  let out = s
  for (const [k, v] of Object.entries(EMOJI_MAP)) out = out.split(k).join(v)
  // 兜底：其它 #(xxx) 保留
  return out
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildChapterHtml(idx) {
  const txtFile = path.join(BOOK_DIR, 'book-chapters', `${String(idx).padStart(4, '0')}.txt`)
  const tkFile = path.join(BOOK_DIR, 'tsukkomi', `${String(idx).padStart(4, '0')}.json`)
  if (!fs.existsSync(txtFile)) return null
  const raw = fs.readFileSync(txtFile, 'utf8')
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
  // 去掉导航残留行（正文/序章/前言 等单独成行的）
  while (lines.length && /^(正文|序章|序言|前言|楔子|番外说明|公告)$/.test(lines[0])) lines.shift()

  let tkData = null
  if (fs.existsSync(tkFile)) {
    try { tkData = JSON.parse(fs.readFileSync(tkFile, 'utf8')) } catch (e) { tkData = null }
  }
  // 段落 → 吐槽映射（服务端 paragraph_index == 行序号，0=标题）
  const byPara = new Map()
  if (tkData) for (const p of tkData.paragraphs) byPara.set(Number(p.paragraph_index), p.tsukkomi)

  // 标题：第一行（第X章 ...）
  let title = lines[0] || `第${idx}章`
  const titleMatch = lines[0]?.match(/^(第[一二三四五六七八九十百千\d]+章.*)$/)
  if (titleMatch) title = titleMatch[1]

  // 段落渲染
  const parasHtml = []
  const usedIdx = new Set()
  lines.forEach((line, i) => {
    const tks = byPara.get(i)
    usedIdx.add(i)
    const badge = tks && tks.length
      ? `<button class="badge" data-para="${i}" onclick="showTks(${i})">💬 ${tks.length}</button>`
      : ''
    const cls = i === 0 ? 'para title' : 'para'
    parasHtml.push(`<p class="${cls}">${esc(line)}${badge}</p>`)
  })
  // 有吐槽但 txt 缺行的（理论上不该发生，兜底列出）
  for (const [pi, tks] of byPara) {
    if (!usedIdx.has(pi) && tks.length) {
      parasHtml.push(`<p class="para miss"><span class="miss-tag">[缺失段${pi}]</span>${badgeFor(pi)}</p>`)
    }
  }
  function badgeFor(pi) {
    const tks = byPara.get(pi)
    return tks && tks.length ? `<button class="badge" data-para="${pi}" onclick="showTks(${pi})">💬 ${tks.length}</button>` : ''
  }

  // 吐槽 JSON 内嵌（script 标签，注意转义 </script>）
  const tkJson = JSON.stringify([...byPara.entries()].map(([pi, tks]) => ({ para: pi, tks })))
    .replace(/</g, '\\u003c')

  const prevIdx = idx > 1 ? idx - 1 : null
  const nextIdx = idx < TOTAL ? idx + 1 : null
  const prevLink = prevIdx ? `<a class="navbtn" href="${String(prevIdx).padStart(4, '0')}.html">‹ 上一章</a>` : '<span class="navbtn dim">‹ 上一章</span>'
  const nextLink = nextIdx ? `<a class="navbtn" href="${String(nextIdx).padStart(4, '0')}.html">下一章 ›</a>` : '<span class="navbtn dim">下一章 ›</span>'

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} - ${esc(BOOK_NAME)}</title>
<style>
:root{--bg:#1a1c22;--fg:#c8ccd4;--dim:#6a7180;--accent:#e8a33d;--card:#242731;--line:#333846}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--fg);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding-bottom:env(safe-area-inset-bottom)}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(26,28,34,.96);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.topbar a,.topbar button{background:none;border:none;color:var(--accent);font-size:15px;cursor:pointer;padding:4px 8px;border-radius:6px}
.topbar .spacer{flex:1}
.topbar .fs{color:var(--dim);font-size:13px}
.content{max-width:720px;margin:0 auto;padding:16px 18px 80px}
.para{font-size:17px;line-height:1.9;letter-spacing:.02em;margin-bottom:14px;text-align:justify;position:relative;text-indent:2em}
.para.title{font-size:21px;font-weight:700;text-align:center;text-indent:0;margin:8px 0 26px;color:#e8eaef}
.badge{display:inline-block;vertical-align:middle;margin-left:8px;font-size:12px;color:#f0c877;background:rgba(232,163,61,.12);border:1px solid rgba(232,163,61,.4);border-radius:999px;padding:1px 8px;cursor:pointer;line-height:1.6;user-select:none}
.badge:active{background:rgba(232,163,61,.3)}
.nav{display:flex;justify-content:space-between;margin-top:34px;padding-top:16px;border-top:1px solid var(--line)}
.navbtn{color:var(--accent);text-decoration:none;font-size:15px;padding:8px 10px;border-radius:8px;background:rgba(232,163,61,.08)}
.navbtn.dim{color:var(--dim);opacity:.5;pointer-events:none}
/* 弹层 */
.mask{position:fixed;inset:0;background:rgba(0,0,0,.55);opacity:0;pointer-events:none;transition:opacity .25s;z-index:50}
.mask.show{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-radius:16px 16px 0 0;transform:translateY(100%);transition:transform .3s cubic-bezier(.2,.8,.25,1);z-index:51;max-height:72vh;display:flex;flex-direction:column}
.sheet.show{transform:translateY(0)}
.sheet-head{display:flex;align-items:center;padding:14px 16px 10px;border-bottom:1px solid var(--line);flex-shrink:0}
.sheet-head b{color:var(--accent);font-size:15px}
.sheet-head .x{margin-left:auto;background:none;border:none;color:var(--dim);font-size:22px;cursor:pointer;padding:2px 8px}
.sheet-body{overflow-y:auto;padding:8px 16px 24px;-webkit-overflow-scrolling:touch}
.tk{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.tk .avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#3a4a6b,#5b3a6b);display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;flex-shrink:0}
.tk .body{flex:1;min-width:0}
.tk .who{font-size:13px;color:var(--dim)}
.tk .who .lou{color:#8a93a5;margin-left:6px;font-size:11px}
.tk .txt{font-size:15px;line-height:1.6;margin-top:3px;color:#dfe2e8;white-space:pre-wrap;word-break:break-word}
.tk .meta{font-size:11px;color:#5d6472;margin-top:4px}
.tk .hot{margin-top:6px;padding:6px 10px;background:rgba(232,163,61,.07);border-radius:8px;font-size:13px;color:#aeb4c0}
.tk .hot .hw{color:var(--accent);font-size:12px}
.empty{padding:30px 0;text-align:center;color:var(--dim);font-size:14px}
.toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;font-size:13px;padding:8px 16px;border-radius:999px;opacity:0;transition:opacity .3s;z-index:60;pointer-events:none}
</style>
</head>
<body>
<div class="topbar">
  <a href="../index.html">☰ 目录</a>
  <span class="spacer"></span>
  <button class="fs" onclick="adj(-1)">A-</button>
  <button class="fs" onclick="adj(1)">A+</button>
  <button class="fs" onclick="toggleTheme()">🌙</button>
</div>
<div class="content" id="content">
${parasHtml.join('\n')}
<div class="nav">${prevLink}${nextLink}</div>
</div>

<div class="mask" id="mask" onclick="hideTks()"></div>
<div class="sheet" id="sheet">
  <div class="sheet-head"><b id="sheetTitle">段评</b><button class="x" onclick="hideTks()">✕</button></div>
  <div class="sheet-body" id="sheetBody"></div>
</div>
<div class="toast" id="toast"></div>

<script>
const TKDATA = ${tkJson};
const EMOJI = {"#(可爱)":"😊","#(笑)":"😄","#(泪)":"😭","#(怒)":"😠","#(汗)":"😅","#(囧)":"😳","#(无语)":"😑","#(滑稽)":"😏","#(惊喜)":"😮","#(心)":"❤️"};
function fmtEmoji(s){if(!s)return s;for(const k in EMOJI)s=s.split(k).join(EMOJI[k]);return s}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function showTks(para){
  const entry = TKDATA.find(e => e.para === para)
  const body = document.getElementById('sheetBody')
  if(!entry || !entry.tks.length){ body.innerHTML = '<div class="empty">这段没有段评（或已加载）</div>' }
  else {
    body.innerHTML = entry.tks.map(t => {
      const name = t.user || '匿名'
      const hot = (t.hot_reply || []).map(h => '<div class="hot"><span class="hw">' + esc(h.user||'') + '：</span>' + esc(fmtEmoji(h.content||'')) + '</div>').join('')
      return '<div class="tk"><div class="avatar">' + esc(name.slice(0,1)) + '</div><div class="body"><div class="who">' + esc(name)
        + (t.lou ? '<span class="lou">#' + t.lou + '</span>' : '')
        + '</div><div class="txt">' + esc(fmtEmoji(t.content)) + '</div><div class="meta">'
        + (t.time || '') + (t.like && t.like !== '0' ? ' · 👍 ' + t.like : '')
        + (t.reply && t.reply !== '0' ? ' · 💬' + t.reply : '') + '</div>' + hot + '</div></div>'
    }).join('')
  }
  document.getElementById('sheetTitle').textContent = '段评 (' + (entry ? entry.tks.length : 0) + ')'
  document.getElementById('sheet').classList.add('show')
  document.getElementById('mask').classList.add('show')
}
function hideTks(){document.getElementById('sheet').classList.remove('show');document.getElementById('mask').classList.remove('show')}
let fs = 17
function adj(d){fs = Math.min(26, Math.max(14, fs + d));document.querySelectorAll('.para').forEach(p => p.style.fontSize = fs + 'px')}
function toggleTheme(){
  const r = document.documentElement
  const dark = r.style.getPropertyValue('--bg') !== '#f7f7f5'
  r.style.setProperty('--bg', dark ? '#f7f7f5' : '#1a1c22')
  r.style.setProperty('--fg', dark ? '#2b2f36' : '#c8ccd4')
  r.style.setProperty('--card', dark ? '#ffffff' : '#242731')
  r.style.setProperty('--line', dark ? '#e2e2e2' : '#333846')
}
let toastTimer
function toast(s){const t=document.getElementById('toast');t.textContent=s;t.style.opacity=1;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.style.opacity=0,1600)}
</script>
</body>
</html>`
}

// ---- main ----
fs.mkdirSync(CH_OUT, { recursive: true })
let from = 1, to = 1
const a = process.argv[2], b = process.argv[3]
if (a && b) { from = Number(a); to = Number(b) } else {
  // 默认：所有已有 tsukkomi 数据的章
  const have = []
  for (let i = 1; i <= 831; i++) if (fs.existsSync(path.join(BOOK_DIR, 'tsukkomi', `${String(i).padStart(4, '0')}.json`))) have.push(i)
  if (have.length) { from = Math.min(...have); to = Math.max(...have) }
}
let ok = 0
for (let i = from; i <= to; i++) {
  const html = buildChapterHtml(i)
  if (!html) continue
  fs.writeFileSync(path.join(CH_OUT, `${String(i).padStart(4, '0')}.html`), html)
  ok++
}
console.log(`生成 ${ok} 章 HTML -> ${CH_OUT}`)
