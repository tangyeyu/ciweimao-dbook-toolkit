// 段评工具箱 · 统一入口页
// 零依赖 Node http server。把所有爬虫/打包面板聚合成一个门户，打开即用。
// 用法：node dsh_toolbox.mjs [port]（默认 8888），双击 段评工具箱.bat 启动
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const _here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.TOOLBOX_PORT) || Number(process.argv[2]) || 8888

// 各面板：name=名称, port=监听端口, target=该面板管理页 URL
const PANELS = [
  { key: 'qidian',    name: '起点段评爬虫', port: 8791, note: 'CDP 驱动 · 游客免登录' },
  { key: 'ciweimao',  name: '刺猬猫段评爬虫', port: 8788, note: 'App 签名 · 含楼中楼' },
  { key: 'pack',      name: '段评打包工具', port: 8789, note: '.dbook 打包/重排' },
  { key: 'txt2shelf', name: 'txt 转书架', port: 8793, note: 'txt→章节+自动校准' },
  { key: 'dashboard', name: '全景进度看板', port: 8800, note: '聚合所有任务进度' },
]

function html() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>段评工具箱</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#12141a;color:#b9bec9;font:15px/1.7 "Microsoft YaHei",system-ui,sans-serif}
  header{padding:22px 28px;background:linear-gradient(90deg,#1b1e25,#16181d);border-bottom:1px solid #252a33}
  h1{font-size:20px;margin:0;color:#e8a33d;font-weight:700}
  h1 span{font-size:12px;color:#767c8a;margin-left:10px;font-weight:400}
  main{max-width:960px;margin:28px auto;padding:0 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
  .card{background:#1b1e25;border:1px solid #252a33;border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:8px}
  .card .top{display:flex;align-items:center;justify-content:space-between}
  .card h2{font-size:16px;margin:0;color:#e5e9f0}
  .dot{width:10px;height:10px;border-radius:50%;background:#666;box-shadow:0 0 6px rgba(0,0,0,.4)}
  .dot.on{background:#3ddc84;box-shadow:0 0 8px rgba(61,220,132,.6)}
  .dot.off{background:#ff5f56;box-shadow:0 0 8px rgba(255,95,86,.5)}
  .card .port{font-size:12px;color:#767c8a}
  .card .note{font-size:12px;color:#767c8a;flex:1}
  .card button{background:#e8a33d;border:0;color:#16181d;font-weight:700;padding:8px 0;border-radius:8px;cursor:pointer;font-size:14px}
  .card button:hover{background:#f0b154}
  .card button:disabled{background:#3a3f4a;color:#767c8a;cursor:not-allowed}
  .hint{text-align:center;color:#767c8a;font-size:13px;margin-top:10px}
</style></head><body>
<header><h1>🐳 段评工具箱<span>统一入口 · 点卡片打开对应面板</span></h1></header>
<main id="grid"></main>
<div class="hint">提示：浏览器连接问题 / 滑块暂停问题——打开「起点段评爬虫」后点左上『🚀 打开浏览器』或『✅ 继续抓取』即可。</div>
<script>
var PANELS = ${JSON.stringify(PANELS)};
var grid = document.getElementById('grid');
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function render(list){
  var cards = list.map(function(p){
    return '<div class="card">' +
      '<div class="top"><h2>' + esc(p.name) + '</h2><span class="dot ' + (p.on ? 'on' : 'off') + '"></span></div>' +
      '<div class="port">端口 ' + p.port + '</div>' +
      '<div class="note">' + esc(p.note) + '</div>' +
      '<button data-key="' + p.key + '" ' + (p.on ? '' : 'disabled') + '>打开面板</button>' +
    '</div>';
  }).join('');
  grid.innerHTML = cards;
  grid.querySelectorAll('button').forEach(function(b){
    b.onclick = function(){ var p = PANELS.find(function(x){ return String(x.key) === b.getAttribute('data-key'); }); if(p) window.open('http://127.0.0.1:' + p.port + '/', '_blank'); };
  });
}
async function tick(){
  try {
    var r = await fetch('/api/probe'); var d = await r.json();
    render(PANELS.map(function(p){ p.on = d[p.key] ? d[p.key].ok : false; return p; }));
  } catch(e){ render(PANELS.map(function(p){ p.on = false; return p; })); }
}
tick(); setInterval(tick, 3000);
</script>
</body></html>`
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html())
    return
  }
  if (url.pathname === '/api/probe') {
    const out = {}
    async function tryFetch(port, pathname) {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 2500)
      try {
        const rr = await fetch('http://127.0.0.1:' + port + pathname, { signal: ctl.signal })
        clearTimeout(t)
        return rr.ok
      } catch (e) { clearTimeout(t); return false }
    }
    await Promise.all(PANELS.map(async (p) => {
      // 先探测 /api/status，404 就回退到根路径（某些面板没有 status 接口）
      let ok = await tryFetch(p.port, '/api/status')
      if (!ok) ok = await tryFetch(p.port, '/')
      out[p.key] = { ok }
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

server.listen(PORT, () => console.log('🐳 段评工具箱 running at http://127.0.0.1:' + PORT))
