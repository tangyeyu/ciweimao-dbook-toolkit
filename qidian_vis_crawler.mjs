// 起点本章说(段评)可视化爬虫面板 v1
// 零依赖 Node，CDP 驱动（需要 Chrome 开着起点页面）：查书 → 选范围 → 配参数 → 开爬 → 实时进度/日志
// 用法: node qidian_vis_crawler.mjs [端口=8791]
// 打开 http://127.0.0.1:8791
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

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
    // ★断线/错误处理必须在 open 前接线（open 后断线时：reject 全部 pending + 置 cdp=null 触发重建）
    ws.onerror = e => {
      reject(new Error('ws: ' + e.message))
      for (const [, p] of pending) p.rej(new Error('CDP 连接断开'))
      pending.clear()
    }
    ws.onclose = () => {
      for (const [, p] of pending) p.rej(new Error('CDP 连接断开'))
      pending.clear()
      // 断线后全局 cdp 置空，下次 ensureCdp 自动重建连接
      cdp = null
    }
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
      }
    }
    ws.onopen = () => resolve({
      call(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const mid = ++id
          // ★CDP 调用超时（45s）：ws 半开连接（TCP 活着但 Chrome 无响应）时 pending 永不 settle → worker 死等
          // 超时强制关 ws → onclose 置 cdp=null → 下次 ensureCdp 自动重建连接
          const timer = setTimeout(() => {
            pending.delete(mid)
            rej(new Error('CDP 调用超时（' + method + '）'))
            try { ws.close() } catch (e) {}
          }, 45000)
          pending.set(mid, {
            res: v => { clearTimeout(timer); res(v) },
            rej: e => { clearTimeout(timer); rej(e) },
          })
          const msg = { id: mid, method, params }
          if (sessionId) msg.sessionId = sessionId
          ws.send(JSON.stringify(msg))
        })
      },
      close() { ws.close() },
    })
  })
}
async function evaluate(expr) {
  if (!cdp) throw new Error('CDP 未连接')
  const r = await cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('页面执行异常: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300))
  return r.result?.value
}
async function pageFetch(url, headers = {}, retryWaf = true) {
  // 在起点页面上下文内 fetch（同源自动带 cookie，绕过 WAF）
  const opt = { method: 'GET', headers: Object.assign({ 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://www.qidian.com/' }, headers) }
  let raw
  try {
    raw = await evaluate(`(async () => { try { const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(opt)}); const t = await r.text(); return JSON.stringify({ status: r.status, text: t }); } catch (e) { return JSON.stringify({ status: 0, error: String(e) }); } })()`)
  } catch (e) {
    // ★页面导航/刷新导致执行上下文销毁：等 WAF 刷新完成再重试
    const em = String(e.message || e)
    if (/navigated or closed|context destroyed|Cannot find context/.test(em)) {
      if (retryWaf) { await wafRefresh(); return pageFetch(url, headers, false) }
      throw e
    }
    throw e
  }
  const j = JSON.parse(raw)
  if (j.error) throw new Error('页面fetch失败: ' + j.error)
  // ★瑞数 WAF 令牌吊销检测：403 + probev3.js = 指纹失效，重载页面重新种 cookie
  const isWaf = j.status === 403 || (j.status === 202) || (j.text && j.text.includes('probev3'))
  if (isWaf) {
    if (retryWaf) {
      await wafRefresh()
      return pageFetch(url, headers, false)
    }
    // 刷新后仍被拦 = 实例级拉黑（指纹在 Chrome 实例层，清 cookie 无效）→ 抛标记，workerLoop 触发 rotateChrome 轮换全新实例
    throw new Error('WAF_BLOCKED')
  }
  return j
}
// ★WAF 轻量自愈：先清 cookie + 重导航换会话（临时会话失效时够用）；仍被拦（WAF_BLOCKED）说明是实例级拉黑，workerLoop 会调 rotateChrome() 轮换全新 Chrome 实例
let wafRefreshing = false
let wafQueue = Promise.resolve()
async function wafRefresh() {
  const myTurn = wafQueue.then(() => {})
  wafQueue = wafQueue.then(async () => {
    if (wafRefreshing) return
    wafRefreshing = true
    try {
      log('⚠️ WAF 拉黑会话，清 cookie 换新会话…')
      try { await cdp.call('Network.clearBrowserCookies') } catch {}
      // 回到书页（重新走 WAF 指纹流程 = 全新访客）
      try {
        await cdp.call('Page.navigate', { url: 'https://www.qidian.com/book/' + (task ? task.bookId : '') + '/' })
      } catch {}
      // ★给 probev3.js 充分时间重新计算指纹
      await sleep(12000)
      // 重导航后可能直接弹出腾讯滑块（IP 级风控信号）→ 暂停等人工；captchaHold 内部会自动检测恢复
      await captchaHold('刷新后')
    } finally {
      wafRefreshing = false
    }
  })
  await myTurn
}
// ---------- 腾讯滑块检测（人工验证） ----------
// 瑞数 WAF 拉黑是实例级（轮换可解）；但出现腾讯滑块（turing.captcha）通常是 IP 级风控信号——
// 轮换新实例也会被拦，正确做法是暂停任务、拉起 Chrome 窗口让用户手动过滑块（IP 解封后接口恢复）
// ★三态返回：true=检测到滑块 / false=确定没有滑块（cdp 健康）/ null=检测失败（cdp 断连等，不能当「滑块没了」）
async function checkCaptcha() {
  if (!cdp) return null
  try {
    // ★腾讯系页面普遍预加载隐藏的 turing 验证码 iframe（不弹窗也在），URL/DOM 存在性匹配恒命中 →
    // 必须判断【可见性】：预加载容器 0 尺寸/display:none（getBoundingClientRect 全 0），真实弹窗才有实际尺寸
    const has = await evaluate(`(() => {
      const vw = window.innerWidth, vh = window.innerHeight
      // ★必须【视口内可见】：起点把 turing iframe 预加载到 y=-1000000 隐藏区（getBoundingClientRect 仍有 300x150），
      // 旧 rect>20 判定对隐藏 iframe 恒命中 → 误暂停。只有 top/left 落在视口内才算真弹出。
      const inView = (r, cs) => r.width > 20 && r.height > 20 && r.top >= -5 && r.top < vh && r.left >= -5 && r.left < vw && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0
      const f = document.querySelector('iframe[src*="turing"], iframe[src*="captcha"], iframe[src*="drag_ele"], #tcaptcha_iframe');
      if (f) { const r = f.getBoundingClientRect(); const cs = getComputedStyle(f); if (inView(r, cs)) return true }
      const y = document.querySelector('.yidun_panel, .tc-drag-thumb, .yidun_slider, .tc-captcha');
      if (y) { const r2 = y.getBoundingClientRect(); const cs2 = getComputedStyle(y); if (inView(r2, cs2)) return true }
      return false;
    })()`)
    return !!has
  } catch { return null }
}
// 把 Chrome 窗口拉到前台（用户去过滑块）：按 CDP 端口找监听进程 PID，AppActivate 激活
async function bringChromeFront() {
  try {
    const cdpPort = new URL(CDP_URL).port || '9222'
    const ps = spawn('powershell', ['-NoProfile', '-Command',
      `$c=Get-NetTCPConnection -LocalPort ${cdpPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){(New-Object -ComObject WScript.Shell).AppActivate($c.OwningProcess)}`],
      { stdio: 'ignore', detached: true })
    ps.unref()
  } catch {}
}
// ★全局恢复监视器（与 worker 协程解耦）：captchaHold 只负责暂停+拉窗口，恢复由独立定时器驱动——
// 触发 captchaHold 的 worker 即使中途终结/卡死，恢复链也不会断（上次「拖完滑块没自动继续」的根因就是恢复逻辑寄生在 worker 死等里）
let resumeTimer = null
function startResumeWatcher() {
  if (resumeTimer) return
  let waited = 0
  resumeTimer = setInterval(async () => {
    if (!task || !task.running || !task.paused) { clearInterval(resumeTimer); resumeTimer = null; return }
    waited += 10
    let res
    try { res = await checkCaptcha() } catch { res = null }
    if (res === false) {
      clearInterval(resumeTimer); resumeTimer = null
      task.paused = false
      log('🧍 滑块验证已通过！自动继续抓取…')
    } else if (waited >= 300) { // 50 分钟上限：强制恢复，宁可进重试也不要永久卡死
      clearInterval(resumeTimer); resumeTimer = null
      task.paused = false
      log('🧍 等待滑块超时（50分钟），强制恢复抓取（若仍被风控会自动重试）…')
    }
    // res === null（cdp 断连）：不动作，等下次周期；cdp 恢复后自会判出结果
  }, 10000)
}
// ---------- 滑块自动解决（纯像素模板匹配 + CDP 模拟人类拖动） ----------
// 原理：腾讯滑块拼图块(.yidun_jigsaw)图案 == 背景图(.yidun_bgimg)缺口处的图案 →
// 在滑块 iframe 内把两张图画进 canvas，逐列像素差分找最小差异位置 = 缺口 x；
// 再用 CDP Input.dispatchMouseEvent 模拟人类轨迹（先快后慢+抖动）把滑块拖到缺口。
// 零模型零下载零网络费用；识别失败会回退到暂停等人工。
async function evaluateIn(sessionId, expr) {
  const r = await cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error('iframe执行异常: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200))
  return r.result?.value
}
async function solveCaptcha() {
  if (!cdp) return false
  // 1. 找滑块 target（turing/tcaptcha/drag_ele）
  const t = await cdp.call('Target.getTargets')
  const target = (t.targetInfos || []).find(x => /turing\.captcha|tcaptcha|captcha\.gtimg|drag_ele/i.test(x.url || ''))
  if (!target) return false
  // 2. attach 到滑块 target 拿 sessionId
  const att = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const sid = att.sessionId
  if (!sid) return false
  try {
    // 跨域 iframe 必须先 Runtime.enable 才能读（探测实证：不加会返回 undefined）
    await cdp.call('Runtime.enable', {}, sid).catch(() => {})
    // 3. iframe 内：读 #tcImgArea 背景图(270x193) + 拼图块(51x51)，canvas 差分找缺口 x
    const info = await evaluateIn(sid, `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      for (let k = 0; k < 20; k++) {
        const imgs = [...document.querySelectorAll('img')]
        // 拼图块：方正 naturalWidth 60-130 且显示 30-80 方形（真实起点是 96x96 显示 51）
        const jig = imgs.find(i => { if (!(i.naturalWidth === i.naturalHeight && i.naturalWidth > 60 && i.naturalWidth < 130 && i.complete)) return false; const r = i.getBoundingClientRect(); return r.width > 30 && r.width < 80 && Math.abs(r.width - r.height) < 4 })
        // 背景：带 background-image url(data:image) 的 DIV，取 base64（★真实起点背景是 css background-image，非 img）
        let bgEl = null, bgBase64 = null
        for (const el of document.querySelectorAll('*')) { const b = getComputedStyle(el).backgroundImage; if (b && b.startsWith('url("data:image')) { const m = b.match(/data:image\\/[a-z]+;base64,([A-Za-z0-9+/=]+)/); if (m) { bgBase64 = m[1]; bgEl = el; break } } }
        if (jig && bgBase64 && jig.complete) {
          const jb64 = (jig.currentSrc || jig.src).match(/base64,([A-Za-z0-9+/=]+)/)[1]
          const load = (b) => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'data:image/png;base64,' + b })
          const bi = await load(bgBase64), ji = await load(jb64)
          if (bi && ji && bi.naturalWidth > 100 && ji.naturalWidth > 0) {
            const bw = bi.naturalWidth, bh = bi.naturalHeight, jw = ji.naturalWidth, jh = ji.naturalHeight
            const c1 = document.createElement('canvas'); c1.width = bw; c1.height = bh
            const x1 = c1.getContext('2d', { willReadFrequently: true }); x1.drawImage(bi, 0, 0)
            const bd = x1.getImageData(0, 0, bw, bh).data
            // ★找最白窗口 = 白色半透明缺口（2D 滑窗，平均RGB最大）——不是和拼图块匹配（已验证方向会错）
            const bright = (x, y) => { let s = 0, n = 0; for (let yy = 0; yy < Math.min(jh, bh - y); yy += 2) { for (let xx = 0; xx < Math.min(jw, bw - x); xx += 2) { const pi = ((y + yy) * bw + (x + xx)) * 4; s += bd[pi] + bd[pi+1] + bd[pi+2]; n++ } } return n ? s / n : -1 }
            let bestX = 0, bestY = 0, bestScore = -1
            const step = Math.max(1, Math.floor(jw / 4)), yStep = Math.max(1, Math.floor(jh / 3))
            for (let y = 0; y <= bh - jh; y += yStep) for (let x = 0; x <= bw - jw; x += step) { const sc = bright(x, y); if (sc > bestScore) { bestScore = sc; bestX = x; bestY = y } }
            const fineX = Math.max(1, Math.floor(step / 2)), fineY = Math.max(1, Math.floor(yStep / 2))
            for (let y = Math.max(0, bestY - yStep); y <= Math.min(bh - jh, bestY + yStep); y += fineY) for (let x = Math.max(0, bestX - step); x <= Math.min(bw - jw, bestX + step); x += fineX) { const sc = bright(x, y); if (sc > bestScore) { bestScore = sc; bestX = x; bestY = y } }
            for (let y = Math.max(0, bestY - 2); y <= Math.min(bh - jh, bestY + 2); y++) for (let x = Math.max(0, bestX - 2); x <= Math.min(bw - jw, bestX + 2); x++) { const sc = bright(x, y); if (sc > bestScore) { bestScore = sc; bestX = x; bestY = y } }
            const bgRect = bgEl.getBoundingClientRect(), jigRect = jig.getBoundingClientRect()
            return JSON.stringify({ gapX: bestX, gapY: bestY, score: bestScore, scale: bgRect.width / bw, bgRect: { x: bgRect.x, y: bgRect.y, w: bgRect.width }, jigRect: { x: jigRect.x, y: jigRect.y, w: jigRect.width }, bw, jw, ok: true })
          }
        }
        await wait(250)
      }
      return JSON.stringify({ error: 'no mat', ok: false })
    })()`)
    const inf = JSON.parse(info)
    if (!inf.ok) { log('🧩 滑块结构未识别: ' + (inf.error || 'unknown')); return false }
    if (!(inf.score >= 0)) { log('🧩 滑块差分无有效 score'); return false }
    // 4. 主页面读滑块 iframe 的视口偏移（布局信息跨域可读）
    const frect = JSON.parse(await evaluate(`(() => { const f = document.querySelector('iframe[src*="turing"], iframe[src*="captcha"], iframe[src*="drag_ele"], #tcaptcha_iframe'); return f ? JSON.stringify(f.getBoundingClientRect()) : JSON.stringify(null) })()`))
    if (!frect) { log('🧩 找不到滑块 iframe 偏移'); return false }
    // 5. 计算拖动：拼图块中心 → 缺口中心（屏幕坐标）
    const iframeX = frect.x, iframeY = frect.y
    const startX = iframeX + inf.jigRect.x + inf.jigRect.w / 2
    const startY = iframeY + inf.jigRect.y + inf.jigRect.h / 2
    const gapCenterX = iframeX + inf.bgRect.x + (inf.gapX + (inf.jw || inf.jigRect.w) / 2) * inf.scale
    const dist = gapCenterX - startX
    if (!(dist > 5 && dist < 500)) { log('🧩 拖动距离异常: ' + dist.toFixed(1) + 'px'); return false }
    // 6. 模拟人类轨迹拖动（easeOutCubic 先快后慢 + 随机抖动 + 过冲微调）
    const steps = 28 + Math.floor(Math.random() * 10)
    const ms = 500 + Math.random() * 300
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 })
    let prevX = startX
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const ease = 1 - Math.pow(1 - t, 3)
      const jitter = (Math.random() - 0.5) * 2.4
      const x = startX + dist * ease + jitter
      const y = startY + (Math.random() - 0.5) * 2
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
      prevX = x
      await new Promise(r => setTimeout(r, ms / steps))
    }
    // 过冲回拉微调（人类习惯）
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prevX + 3 + Math.random() * 4, y: startY + (Math.random() - 0.5) * 1.5, button: 'left', buttons: 1 })
    await new Promise(r => setTimeout(r, 60 + Math.random() * 80))
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: prevX + 3, y: startY, button: 'left', buttons: 0, clickCount: 1 })
    // 7. 等 2.5s 验证滑块是否消失
    await new Promise(r => setTimeout(r, 2500))
    const gone = await checkCaptcha()
    log(`🧩 自动过滑块: 缺口x=${inf.gapX} 距离=${dist.toFixed(0)}px ${gone === false ? '✓ 通过' : (gone === true ? '✗ 滑块仍在' : '? 检测异常')}`)
    return gone === false
  } catch (e) {
    log('🧩 自动过滑块异常: ' + String(e.message || e).slice(0, 150))
    return false
  } finally {
    try { await cdp.call('Target.detachFromTarget', { sessionId: sid }) } catch (e) {}
  }
}

// 检测到滑块：【优先自动过】——像素差分找缺口+模拟拖拽（零 token 纯本地），最多 3 次；自动失败才暂停拉窗等人工（手动「✅ 继续抓取」恢复）
// 依据：用户要求「以后就自动验证滑块」，自动过不掉再兜底人工。
async function captchaHold(who) {
  const hit = await checkCaptcha()
  if (hit !== true) return false
  for (let i = 1; i <= 3; i++) {
    log(`🧩 检测到可见滑块（${who}）！自动解决（第${i}/3次）…`)
    let solved = false
    try { solved = await solveCaptcha() } catch (e) { log('🧩 自动过滑块异常: ' + String(e.message || e).slice(0, 150)) }
    if (solved) { log('🧩 滑块自动通过！继续抓取…'); return true }
    await sleep(5000)
  }
  if (task) task.paused = true
  log('🧩 自动过滑块 3 次失败，暂停——请在弹出的 Chrome 窗口拖动滑块完成验证，然后点「✅ 继续抓取」恢复…')
  await bringChromeFront()
  startResumeWatcher()
  return true
}
// ---------- WAF 实例轮换 ----------
// 瑞数拉黑的是 Chrome 实例（浏览器指纹层），清 cookie/reload 无效 → 检测到持续拉黑时杀旧实例、起全新 profile 实例（全新指纹=干净访客）
let rotating = false
async function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ]
  for (const c of cands) if (c && fs.existsSync(c)) return c
  throw new Error('找不到 chrome.exe：请设置环境变量 CHROME_PATH 指向 chrome.exe 完整路径（自动轮换功能需要）')
}
async function rotateChrome() {
  if (rotating) { await sleep(15000); return false }
  rotating = true
  try {
    const bookUrl = task && task.bookId ? `https://www.qidian.com/book/${task.bookId}/` : 'https://www.qidian.com/'
    const cdpPort = new URL(CDP_URL).port || '9222'
    log('🔄 实例级 WAF 拉黑 → 关闭旧 Chrome，轮换全新实例…')
    // 1. 关闭当前 Chrome 实例（Browser.close 关整个浏览器，含所有标签页）
    let closed = false
    try {
      const ver = await (await fetch(CDP_URL + '/json/version')).json()
      if (ver.webSocketDebuggerUrl) {
        const bws = await connect(ver.webSocketDebuggerUrl)
        await bws.call('Browser.close')
        closed = true
      }
    } catch (e) { log('  Browser.close 失败: ' + String(e.message || e).slice(0, 100)) }
    if (!closed) { try { if (cdp) await cdp.close() } catch {} }
    cdp = null
    // 2. 等端口释放（浏览器进程完全退出）
    for (let i = 0; i < 40; i++) {
      try { await fetch(CDP_URL + '/json/version'); await sleep(500) } catch { break }
      await sleep(500)
    }
    await sleep(1500)
    // 2.5 清理陈旧的轮换 profile（只删 >1 天的，防越攒越多，保留在用的/最新的）
    try {
      const now = Date.now()
      let removed = 0
      for (const name of fs.readdirSync(_here)) {
        if (!name.startsWith('_qidian_auto_')) continue
        const p = path.join(_here, name)
        try {
          if (now - fs.statSync(p).mtimeMs > 86400000) { fs.rmSync(p, { recursive: true, force: true }); removed++ }
        } catch {}
      }
      if (removed) log(`  🧹 顺手清理 ${removed} 个旧轮换 profile`)
    } catch {}
    // 3. 起新 Chrome：同 CDP 端口 + 全新独立 profile（全新指纹）
    const profile = path.join(_here, '_qidian_auto_' + Math.random().toString(36).slice(2, 10))
    const chromePath = await findChrome()
    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-fre', '--no-sandbox',
      bookUrl,
    ]
    log(`  新实例: ${chromePath} (端口 ${cdpPort}, profile ${path.basename(profile)})`)
    const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' })
    child.unref()
    // 4. 等 CDP 就绪
    let ok = false
    for (let i = 0; i < 60; i++) {
      try { const l = await (await fetch(CDP_URL + '/json/version')).json(); if (l.webSocketDebuggerUrl) { ok = true; break } } catch {}
      await sleep(500)
    }
    if (!ok) { log('❌ 新 Chrome 实例启动失败，请手动重启浏览器后继续'); return false }
    // 5. 等起点书页出现（含 WAF 指纹计算），重建连接
    let tabFound = false
    for (let i = 0; i < 30; i++) {
      try {
        const page = await findPageTab()
        if (page) { cdpPageUrl = page.url; if (!cdp) cdp = await connect(page.webSocketDebuggerUrl); tabFound = true; break }
      } catch {}
      await sleep(1000)
    }
    if (!tabFound) { log('❌ 新实例找不到起点页面标签'); return false }
    await sleep(3000) // 等指纹 + 首屏渲染
    log('✅ 新 Chrome 实例就绪，继续抓取')
    return true
  } catch (e) {
    log('❌ 轮换失败: ' + String(e.message || e).slice(0, 150))
    return false
  } finally {
    rotating = false
  }
}
async function getCsrf() {
  const v = await evaluate(`(document.cookie.match(/_csrfToken=([^;]+)/)||[])[1]||''`)
  if (!v) throw new Error('页面缺少 _csrfToken cookie，请刷新一下浏览器里的起点页面')
  return v
}

// 导航到书页，等渲染后从 DOM 提取书名 + 章节列表（页面上下文 fetch HTML 会被 WAF 挑战页拦截，导航方式可行）
// ★导航会销毁页面执行上下文：任务运行中禁止调用（否则在途 evaluate 全部报 context destroyed → 批量失败）
async function getCatalogByNav(bookId) {
  if (task && task.running) throw new Error('任务正在运行，不能导航查书（会销毁抓取中的页面上下文），请先停止')
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
  // 书名落盘（打包面板读）
  try {
    fs.mkdirSync(path.join(DATA_ROOT, String(bookId)), { recursive: true })
    fs.writeFileSync(path.join(DATA_ROOT, String(bookId), '_book.json'), JSON.stringify({ book_id: String(bookId), book_name: data.title, author: data.author, fetched_at: new Date().toISOString() }))
  } catch {}
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
  // ★csrf 章节内缓存（页面刷新/重连后缓存失效，下次自动重取）
  let csrf = ''
  const getC = async () => { if (!csrf) csrf = await getCsrf(); return csrf }
  const sum = await pageFetch('https://www.qidian.com/ajax/chapterReview/reviewSummary?' + new URLSearchParams({
    bookId: ch.book_id, chapterId: ch.chapter_id, _csrfToken: await getC(),
  }))
  const obj = JSON.parse(sum.text)
  if (obj.code !== 0) throw new Error('reviewSummary code=' + obj.code + ' ' + (obj.msg || ''))
  const segments = (obj.data && obj.data.list) || []
  const out = []
  for (const seg of segments) {
    // ★空段落（0 段评）跳过：省一次 reviewList 请求（起点段落很多是空的）
    if (!seg.reviewNum) continue
    const reviews = []
    let page = 1
    // ★翻页上限按实际段评数推算（防接口异常死循环，又不误杀 1000+ 条的大段落）
    const maxPage = Math.ceil((seg.reviewNum || 0) / 10) + 10
    for (;;) {
      const r = await pageFetch('https://www.qidian.com/ajax/chapterReview/reviewList?' + new URLSearchParams({
        bookId: ch.book_id, chapterId: ch.chapter_id, page: String(page), pageSize: '10',
        segmentId: String(seg.segmentId), type: '2', _csrfToken: await getC(),
      }))
      const j = JSON.parse(r.text)
      if (j.code !== 0) throw new Error('reviewList code=' + j.code + ' ' + (j.msg || ''))
      const list = (j.data && j.data.list) || []
      if (!list.length) break
      reviews.push(...list)
      if (list.length < 10) break
      page++
      if (page > maxPage) break
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
        log(`✅ 全部完成！共 ${task.completed} 章（失败 ${task.failed} 章），用时 ${mins} 分钟`)
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
      const msg = String(e.message || e)
      const item = q.find(it => it.ch.chapter_index === ch.chapter_index)
      if (!item) continue
      // ★实例级拉黑（wafRefresh 已试过无效 / 页面被 WAF 挑战页顶掉丢失 _csrfToken）：轮换全新 Chrome 实例；同一章轮换 3 次仍被拦则标记失败防死循环
      if (msg.includes('WAF_BLOCKED') || /csrfToken|页面缺少/.test(msg)) {
        // 先查有没有腾讯滑块：有 = IP 级风控，轮换没用 → 暂停等用户人工过滑块
        if (await captchaHold('WAF_BLOCKED')) continue
        item.wafTries = (item.wafTries || 0) + 1
        if (item.wafTries >= 3) {
          item.done = true
          task.failed++
          log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} 轮换 3 次仍被 WAF 拦，标记失败跳过`)
        } else {
          item.done = false
          item.attempts = 0 // 轮换不累计普通失败计数
          log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} 实例拉黑，轮换新 Chrome（第${item.wafTries}/3次）…`)
          await rotateChrome()
        }
        continue
      }
      // ★WAF 刷新重试：页面 reload 后上下文被销毁 / 指纹失效抛的错——不计数，等刷新完自动重试
      if (/navigated or closed|context destroyed|Cannot find context|WAF/.test(msg)) {
        await sleep(1500)
        if (task.running) { item.done = false; log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} WAF刷新，稍后重试…`) }
        continue
      }
      // ★CDP 断连/调用超时（轮换/浏览器崩溃/半开连接导致）：不计数，等连接重建后重试
      if (/CDP 连接断开|CDP 调用超时|ws:|fetch failed|CDP 未连接/.test(msg)) {
        await sleep(2000)
        if (task.running) { item.done = false; log(`[w${wid}] #${ch.chapter_index} CDP 断连，重建后重试…`) }
        continue
      }
      // ★业务限流（reviewList code=1）：等待后重试，不累计普通失败（限流是暂时的，跳过会丢数据）
      if (/reviewList code=1|reviewSummary code=1/.test(msg)) {
        item.limitTries = (item.limitTries || 0) + 1
        if (item.limitTries >= 20) {
          item.done = true
          task.failed++
          log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} 限流重试 20 次仍失败，标记跳过`)
        } else {
          item.done = false
          log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} 业务限流(code=1)，等待 10s 重试（第${item.limitTries}/20次）…`)
          await sleep(10000)
        }
        continue
      }
      // ★attempts 上限：连续失败 3 次标记失败跳过（防 WAF 验证不过时任务死循环永不结束）
      if (item) {
        item.attempts = (item.attempts || 0) + 1
        if (item.attempts >= 3) {
          item.done = true
          task.failed++
          log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} 连续失败 ${item.attempts} 次，标记失败跳过: ${msg.slice(0, 140)}`)
        } else {
          item.done = false
          log(`[w${wid}] #${ch.chapter_index} ${ch.chapter_title} FAIL(第${item.attempts}/3次): ${msg.slice(0, 140)}`)
        }
      }
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
  let url
  try { url = new URL(req.url, 'http://x') } catch { return json(res, 400, { error: 'bad request' }) }
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
      // ★路径穿越防护：book_id 必须是纯数字
      if (!/^\d+$/.test(String(book_id))) return json(res, 400, { error: 'book_id 必须是纯数字' })
      // ★stop 后立即 start：等旧 worker 全部退出再建新任务（防旧 worker 污染新任务）
      if (task && task.activeWorkers > 0) {
        let waited = 0
        while (task.activeWorkers > 0 && waited < 5000) { await sleep(100); waited += 100 }
      }
      const cdpSt = await ensureCdp()
      if (!cdpSt.ok) return json(res, 400, { error: cdpSt.error })
      const outDir = path.join(DATA_ROOT, String(book_id), 'tsukkomi')
      fs.mkdirSync(outDir, { recursive: true })
      const cacheFile = path.join(DATA_ROOT, String(book_id), '_chapters.json')
      let chapters = []
      // ★缓存 TTL 1 天（书更新后不永远用旧目录）
      let cacheAge = Infinity
      try { cacheAge = Date.now() - fs.statSync(cacheFile).mtimeMs } catch { /* 不存在 */ }
      if (fs.existsSync(cacheFile) && cacheAge < 24 * 3600 * 1000) chapters = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (!chapters.length) {
        const cat = await getCatalogByNav(String(book_id))
        chapters = cat.chapters
        fs.writeFileSync(cacheFile, JSON.stringify(chapters))
      }
      let list = chapters
      const cs = Number(chapter_start || 1), ce = Number(chapter_end || Infinity)
      if (cs > 1 || isFinite(ce)) list = list.filter(c => c.chapter_index >= cs && c.chapter_index <= ce)
      // 断点续传：★核对文件真的存在（手删某章后必须补抓）
      let doneSet = new Set()
      const stFile = path.join(outDir, '_state.json')
      if (fs.existsSync(stFile)) doneSet = new Set(JSON.parse(fs.readFileSync(stFile, 'utf8')).done || [])
      for (const idx of [...doneSet]) {
        const f = path.join(outDir, `${String(idx).padStart(4, '0')}.json`)
        if (!fs.existsSync(f)) doneSet.delete(idx)
      }
      const queue = list.map(ch => ({ ch, done: doneSet.has(ch.chapter_index), attempts: 0 }))
      const todoCount = queue.filter(q => !q.done).length
      if (!todoCount) return json(res, 200, { note: '无新章节（全部已抓）', total: list.length })
      task = {
        running: true, paused: false,
        bookId: String(book_id), bookName: book_name || '',
        outDir, chapters: list, queue,
        doneSet, doneOrder: [...doneSet], completed: doneSet.size,
        failed: 0, todoCount,
        concurrency: Math.max(1, Math.min(8, Number(concurrency) || 3)),
        // ★delay=0 合法（不等待），不能被 `0 || 300` 吞
        delay: Number.isFinite(Number(delay)) ? Math.max(0, Number(delay)) : 300,
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
    if (req.method === 'POST' && p === '/api/rotate') {
      // 手动触发 WAF 实例轮换（页面被挑战页顶掉/无 _csrfToken 时用）
      const ok = await rotateChrome()
      return json(res, 200, { ok })
    }
    // ★手动恢复：用户验证完滑块/确认没滑块后一键继续（不依赖自动检测）。清 resumeTimer 防自动定时器干扰
    if (req.method === 'POST' && p === '/api/resume') {
      if (task && task.paused && task.running) {
        if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null }
        task.paused = false
        log('✅ 手动恢复抓取（用户确认滑块已处理）')
      }
      return json(res, 200, { paused: task?.paused || false }) 
    }
    // ★一键打开浏览器：CDP 未连接时自动杀占端口的残留 Chrome + 起全新实例连上；已连接则直接返回
    if (req.method === 'POST' && p === '/api/launch-browser') {
      const cdpSt = await ensureCdp()
      if (cdpSt.ok) return json(res, 200, { ok: true, message: '浏览器已连接', url: cdpSt.url })
      try {
        const cdpPort = new URL(CDP_URL).port || '9222'
        let portBusy = false
        try { await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) }); portBusy = true } catch { portBusy = false }
        if (portBusy) {
          // 端口被"死"Chrome 占着（监听但 CDP 不响应）：用 taskkill 强杀占端口进程
          log('⚠️ CDP 端口被残留浏览器占用，尝试清理…')
          const ps = spawn('powershell', ['-NoProfile', '-Command',
            `$c=Get-NetTCPConnection -LocalPort ${cdpPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){taskkill /PID $c.OwningProcess /T /F}`],
            { stdio: 'ignore', detached: true })
          ps.unref()
          await sleep(2500)
        }
        const chromePath = await findChrome()
        const profile = path.join(_here, '_qidian_auto_' + Math.random().toString(36).slice(2, 10))
        const bookUrl = task && task.bookId ? `https://www.qidian.com/book/${task.bookId}/` : 'https://www.qidian.com/'
        const args = [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-fre', '--no-sandbox', bookUrl]
        log('🚀 打开浏览器: ' + chromePath + ' (端口 ' + cdpPort + ')')
        const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' })
        child.unref()
        let ready = false
        for (let i = 0; i < 40; i++) { try { const l = await (await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(2000) }).catch(() => null)); if (l && l.webSocketDebuggerUrl) { ready = true; break } } catch {} await sleep(500) }
        if (!ready) return json(res, 500, { error: 'Chrome 启动失败：请检查环境变量 CHROME_PATH 或手动启动浏览器' })
        // 重建 CDP 连接 + 等书页指纹
        let tabFound = false
        for (let i = 0; i < 30; i++) { try { const page = await findPageTab(); if (page) { cdpPageUrl = page.url; if (!cdp) cdp = await connect(page.webSocketDebuggerUrl); tabFound = true; break } } catch {} await sleep(1000) }
        if (!tabFound) return json(res, 500, { error: '浏览器已开但找不到起点页面标签，请手动打开 www.qidian.com' })
        await sleep(3000)
        log('✅ 浏览器已打开并连接')
        return json(res, 200, { ok: true, message: '浏览器已启动并连接' })
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) })
      }
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

// ★只绑定 127.0.0.1：面板无鉴权且控制浏览器标签页，绝不能暴露到局域网
server.listen(PORT, '127.0.0.1', () => {
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
    ① 点下方「🚀 打开浏览器」——面板自动拉起一个专用 Chrome 并连上（不用手动敲命令）<br>
    ② 或手动：<code>chrome.exe --remote-debugging-port=9222 --user-data-dir=某个独立目录</code> 再访问 <code>https://www.qidian.com/</code>（任意书页，无需登录）<br>
    ③ 爬虫借用该浏览器抓取，期间别关标签页。遇到 WAF 实例级拉黑会自动轮换全新实例继续。<br>
    <span style="color:var(--acc)">🛡 滑块验证后若不自动继续，点下方「✅ 继续抓取」手动恢复（不用等自动检测）</span>
  </div>
  <div class="row">
    <button id="btnLaunch">🚀 打开浏览器</button>
    <button id="btnCdp" class="ghost">🔄 重新检测</button>
    <button id="btnResume" class="ghost" disabled>✅ 继续抓取</button>
  </div>
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
      // 始终显示「继续抓取」，仅在运行中被暂停时点亮可点（平时灰置）
      $('btnResume').disabled = !(t.running && t.paused)
    } else {
      $('sDone').textContent = '0'; $('sTodo').textContent = '0'; $('sPct').textContent = '0%'
      $('sTime').textContent = '0s'; $('sState').textContent = '空闲'; $('sCur').textContent = '—'
      $('barFill').style.width = '0%'
      $('btnStart').disabled = false; $('btnPause').disabled = true; $('btnStop').disabled = true
      $('btnResume').disabled = true
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

// ★打开浏览器：CDP 断了或没连上时一键拉起全新 Chrome（自动解决「浏览器链接连接不了」）
$('btnLaunch').onclick = async () => {
  setMsg('bookMsg', '正在打开浏览器…', true)
  const r = await api('/api/launch-browser', {})
  if (r.ok) setMsg('bookMsg', '浏览器已就绪 ✓ URL=' + r.url, true)
  else setMsg('bookMsg', '打开失败：' + r.error, false)
  refresh()
}

// ★手动恢复：滑块验证完/被暂停时点一下就继续抓（不依赖自动检测）
$('btnResume').onclick = async () => {
  const r = await api('/api/resume', {})
  setMsg('bookMsg', r.error ? '恢复失败：' + r.error : '已恢复抓取 ✓', !r.error)
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
