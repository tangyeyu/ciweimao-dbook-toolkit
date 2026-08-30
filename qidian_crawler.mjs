// qidian_crawler.mjs — 起点本章说(段评)爬虫，CDP 驱动（走真实浏览器页面上下文，自动过 WAF）
// 用法: node qidian_crawler.mjs <bookId|bookUrl> [--chapters 1-5] [--concurrency 4] [--delay 200]
// 数据输出: qidian_data/<bookId>/tsukkomi/<index>.json + _chapters.json + _state.json
// 依赖: Chrome CDP 9222 正在打开起点页面（启动见 README）
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _here = dirname(fileURLToPath(import.meta.url));
const CDP_URL = process.env.QIDIAN_CDP || 'http://127.0.0.1:9222';
const DATA_ROOT = process.env.QIDIAN_DATA || join(_here, 'qidian_data');

// ---------- CDP helpers ----------
async function findPageTab() {
  const list = await (await fetch(CDP_URL + '/json/list')).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('qidian.com'));
  if (!page) throw new Error('未找到起点页面标签：请先打开 Chrome 并访问 https://www.qidian.com/ 任意书页');
  return page;
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      call(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close() { ws.close(); }
    });
    ws.onerror = e => reject(new Error('ws: ' + e.message));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      }
    };
  });
}
async function evaluate(cdp, expr) {
  const r = await cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || '';
    // WAF probe 页或跨域错误都归为页面异常
    throw new Error('页面执行异常: ' + d.slice(0, 300));
  }
  return r.result?.value;
}

// 在页面上下文内 fetch（同源自动带 cookie，规避 WAF）
const PAGE_FETCH = (url, opt) => `(async () => {
  try {
    const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(opt || {})});
    const t = await r.text();
    return JSON.stringify({ status: r.status, text: t });
  } catch (e) {
    return JSON.stringify({ status: 0, error: String(e) });
  }
})()`;

async function pageFetch(cdp, url, headers = {}) {
  const opt = { method: 'GET', headers: Object.assign({ 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://www.qidian.com/' }, headers) };
  const raw = await evaluate(cdp, PAGE_FETCH(url, opt));
  const j = JSON.parse(raw);
  if (j.error) throw new Error('页面fetch失败: ' + j.error);
  if (j.status === 202) throw new Error('WAF 挑战页: 页面可能跳到了验证页，请在浏览器中完成验证后重试');
  return j;
}

// ---------- 目录 ----------
// 从目录页 DOM 提取全部章节（chapter 链接 + 标题 + 卷/付费信息）
async function getCatalog(cdp, bookId) {
  // 先确保当前 tab 在目录页
  await evaluate(cdp, `location.href = 'https://www.qidian.com/book/${bookId}/'; 'ok'`);
  await new Promise(r => setTimeout(r, 3500)); // 等页面渲染
  const data = await evaluate(cdp, `(() => {
    const out = [];
    const seen = new Set();
    // 卷容器：起点目录页 div.catalog-volume 或 ul.catalog-list
    const vols = document.querySelectorAll('.catalog-volume, .volume-wrap, .catalog-list > li, .chapter-item');
    const scope = document;
    const links = scope.querySelectorAll('a[href*="/chapter/"]');
    for (const a of links) {
      const m = (a.getAttribute('href') || '').match(/\\/chapter\\/(\\d+)\\/(\\d+)\\//);
      if (!m) continue;
      const key = m[1] + '/' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      const li = a.closest('li') || a.parentElement;
      const txt = (a.textContent || '').trim();
      // ★统一 schema：与 vis 面板一致（{book_id, chapter_id, chapter_index, chapter_title, is_vip}），
      //   避免两工具写同一 _chapters.json 互相覆盖导致 undefined.json
      out.push({
        book_id: m[1],
        chapter_id: m[2],
        chapter_index: out.length + 1,
        chapter_title: txt.slice(0, 80),
        // 付费标记：li 里 span.vip / i.vip / span 含 "VIP"
        is_vip: li ? /vip/i.test(li.className || '') || /vip/i.test(li.innerHTML || '').toString() : false
      });
    }
    // 书名
    const h1 = document.querySelector('#bookName, .book-info h1, h1');
    const title = h1 ? h1.textContent.trim() : '';
    return { title, chapters: out };
  })()`);
  if (!data.chapters || !data.chapters.length) throw new Error('目录提取为空：页面可能没渲染完，请人工检查浏览器');
  return data;
}

// ---------- 段评 ----------
async function getSegmentSummary(cdp, bookId, chapterId) {
  const csrf = await evaluate(cdp, `(document.cookie.match(/_csrfToken=([^;]+)/)||[])[1]||''`);
  const url = `https://www.qidian.com/ajax/chapterReview/reviewSummary?` + new URLSearchParams({
    bookId, chapterId, _csrfToken: csrf
  });
  const j = await pageFetch(cdp, url);
  const obj = JSON.parse(j.text);
  if (obj.code !== 0) throw new Error('reviewSummary code=' + obj.code + ' ' + (obj.msg || ''));
  return obj.data; // {list:[{segmentId,reviewNum,isHotSegment}], total}
}

async function getReviews(cdp, bookId, chapterId, segmentId) {
  const csrf = await evaluate(cdp, `(document.cookie.match(/_csrfToken=([^;]+)/)||[])[1]||''`);
  const all = [];
  let page = 1;
  for (;;) {
    const url = 'https://www.qidian.com/ajax/chapterReview/reviewList?' + new URLSearchParams({
      bookId, chapterId, page: String(page), pageSize: '10', segmentId: String(segmentId), type: '2', _csrfToken: csrf
    });
    const j = await pageFetch(cdp, url);
    const obj = JSON.parse(j.text);
    if (obj.code !== 0) throw new Error('reviewList code=' + obj.code + ' ' + (obj.msg || ''));
    const list = obj.data?.list || [];
    if (!list.length) break;
    all.push(...list);
    if (list.length < 10) break;
    page++;
    // ★分页上限：服务端忽略 page 恒返回 10 条时防死循环
    if (page > 100) break;
    await new Promise(r => setTimeout(r, 150));
  }
  return all;
}

// 简化字段（对齐刺猬猫 tsukkomi 结构：id/para/user/uid/ip/content/like/unlike/lou/reply/hot_reply/time）
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
    quoteReview: r.quoteReviewId || ''
  };
}

// ---------- 主流程 ----------
async function main() {
  const args = process.argv.slice(2);
  const bookArg = args.find(a => /^\d+$/.test(a)) || args.find(a => a.startsWith('http'));
  if (!bookArg) { console.error('用法: node qidian_crawler.mjs <bookId|bookUrl> [--chapters 1-5]'); process.exit(1); }
  const bookId = bookArg.replace(/https?:\/\/[^/]+\/(book|chapter)\//, '').split('/')[0];
  const argVal = name => {
    const i = args.indexOf(name);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    const eq = args.find(a => a.startsWith(name + '='));
    return eq ? eq.split('=')[1] : null;
  };
  const chaptersArg = argVal('--chapters');
  let chRange = null;
  if (chaptersArg && chaptersArg !== 'all') {
    const [a, b] = chaptersArg.split('-').map(Number);
    chRange = [a, b || a];
  }
  const concurrency = Number(argVal('--concurrency') || '2') || 2;
  const delay = Number(argVal('--delay') || '200') || 200;

  console.log(`[起点段评爬虫] bookId=${bookId}`);
  const page = await findPageTab();
  const cdp = await connect(page.webSocketDebuggerUrl);

  // 目录
  const cat = await getCatalog(cdp, bookId);
  const chapters = cat.chapters;
  console.log(`书名: ${cat.title || '(未知)'}  章节数: ${chapters.length}`);
  const outDir = join(DATA_ROOT, bookId);
  mkdirSync(join(outDir, 'tsukkomi'), { recursive: true });
  writeFileSync(join(outDir, '_chapters.json'), JSON.stringify(chapters, null, 1));
  console.log('目录已存:', join(outDir, '_chapters.json'));

  // 范围过滤
  const idxList = chapters.map((c, i) => i);
  const target = chRange ? idxList.filter(i => i + 1 >= chRange[0] && i + 1 <= chRange[1]) : idxList;
  console.log(`待抓 ${target.length} 章 (${chapters[target[0]]?.chapter_id} ~ ${chapters[target[target.length-1]]?.chapter_id})`);

  // 断点续传
  const stateFile = join(outDir, '_state.json');
  const done = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : [];
  const todo = target.filter(i => !done.includes(i));
  console.log(`已完成 ${done.length}/${target.length}，待抓 ${todo.length}`);

  // 并发 worker
  const queue = [...todo];
  let active = 0;
  let failCount = 0;
  const log = m => console.log(new Date().toTimeString().slice(0, 8), m);

  async function worker() {
    while (queue.length) {
      const i = queue.shift();
      const ch = chapters[i];
      log(`[${i + 1}/${chapters.length}] ${ch.chapter_title || ch.chapter_id} 开始`);
      try {
        const sum = await getSegmentSummary(cdp, bookId, ch.chapter_id);
        const segments = sum.list || [];
        const out = { bookId, chapterId: ch.chapter_id, title: ch.chapter_title, segments: [] };
        for (const seg of segments) {
          const reviews = await getReviews(cdp, bookId, ch.chapter_id, seg.segmentId);
          out.segments.push({
            segmentId: seg.segmentId,
            reviewNum: seg.reviewNum,
            isHot: !!seg.isHotSegment,
            tsukkomi: reviews.map(simplify)
          });
          await new Promise(r => setTimeout(r, delay));
        }
        // ★文件名与 vis 面板一致：chapter_index 补零（CLI 与面板可混用同一书的数据）
        writeFileSync(join(outDir, 'tsukkomi', String(ch.chapter_index).padStart(4, '0') + '.json'), JSON.stringify(out));
        done.push(i);
        writeFileSync(stateFile, JSON.stringify(done));
        const total = out.segments.reduce((a, s) => a + s.tsukkomi.length, 0);
        log(`[${i + 1}/${chapters.length}] ✓ ${total} 条段评 / ${segments.length} 段`);
      } catch (e) {
        failCount++;
        log(`[${i + 1}/${chapters.length}] ✗ ${e.message.slice(0, 120)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, () => worker()));
  cdp.close();
  console.log(`\n完成。成功 ${done.length}/${target.length}，失败 ${failCount}。数据目录: ${outDir}`);
  if (failCount) console.log('失败章节可重跑同一命令续抓');
}

main().catch(e => { console.error('致命错误:', e.message); process.exit(1); });
