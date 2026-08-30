// EPUB -> TXT + 章节 JSON（通用转换器）
// 零依赖：node epub2txt.mjs "<epub路径>" [输出目录] [书名] [作者] [来源URL]
// 输出：<书名>.txt（全书纯文本）、chapters.json（章节列表）、book-chapters/*.txt（分章文本）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const epubPath = process.argv[2] || 'book.epub';
const outDir = process.argv[3] || path.join(process.cwd(), 'book-output');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, 'book-chapters'), { recursive: true });

// 用 PowerShell 解压（Node 无内置 zip 读取）
function extractAll(epub, destDir) {
  const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${epub.replace(/'/g, "''")}')
foreach ($entry in $zip.Entries) {
  $outPath = Join-Path '${destDir.replace(/'/g, "''")}' ($entry.FullName -replace '[/\\\\]', '__')
  $sr = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
  $content = $sr.ReadToEnd()
  $sr.Close()
  [System.IO.File]::WriteAllText($outPath, $content, (New-Object System.Text.UTF8Encoding $false))
}
$zip.Dispose()
`;
  const tmp = path.join(outDir, '_extract.ps1');
  fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8'); // BOM：PowerShell 5.1 按 UTF-8 解析
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { stdio: 'inherit' });
  fs.rmSync(tmp, { force: true });
}

// 解压
const extractDir = path.join(outDir, '_extract');
fs.rmSync(extractDir, { recursive: true, force: true });
fs.mkdirSync(extractDir, { recursive: true });
console.log('解压 EPUB...');
extractAll(epubPath, extractDir);

// 读 toc.ncx（★标准 EPUB 由 META-INF/container.xml 指定 OPF，toc.ncx 常在 OEBPS/ 子目录，
//   不能假设在解压根目录；解压时路径已拍平为 __ 连接）
function findNcx() {
  // 1. container.xml → OPF 路径
  const containerFile = path.join(extractDir, 'META-INF__container.xml');
  let opfRel = null
  if (fs.existsSync(containerFile)) {
    const c = fs.readFileSync(containerFile, 'utf8')
    const m = c.match(/full-path="([^"]+)"/i)
    if (m) opfRel = m[1]
  }
  // 2. OPF → manifest 里的 ncx（或 spine toc 属性）
  if (opfRel) {
    const opfFile = path.join(extractDir, opfRel.replace(/[/\\]/g, '__'))
    if (fs.existsSync(opfFile)) {
      const o = fs.readFileSync(opfFile, 'utf8')
      const m = o.match(/<item[^>]*media-type="application\/x-dtbncx\+xml"[^>]*href="([^"]+)"/i)
      if (m) return decodeURIComponent(m[1])
      const s = o.match(/<spine[^>]*toc="([^"]+)"/i)
      if (s) {
        const item = o.match(new RegExp(`<item[^>]*id="[^"]*${s[1]}[^"]*"[^>]*href="([^"]+)"`))
        if (item) return decodeURIComponent(item[1])
      }
    }
  }
  // 3. 兜底：拍平目录里找名字含 toc.ncx 的文件
  const hit = fs.readdirSync(extractDir).find(f => f.toLowerCase().includes('toc.ncx'))
  if (hit) return hit.replace(/__/g, '/')
  return 'toc.ncx'
}
const ncxRel = findNcx()
const ncxFile = path.join(extractDir, ncxRel.replace(/[/\\]/g, '__'))
const ncx = fs.readFileSync(ncxFile, 'utf8')
const navPoints = [...ncx.matchAll(/<navPoint[^>]*>[\s\S]*?<text>\s*([\s\S]*?)\s*<\/text>[\s\S]*?<content[^>]*src="([^"]*)"/g)]
  .map(m => ({ title: m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(), src: m[2] }));

// 过滤：跳过封面/简介/无意义标题；正文从「第一章」开始
const skipTitles = new Set(['封面', '目录', '前言', '后记', '封底', '正文', '简介', '楔子', '序章']);
const allNav = navPoints.filter(n => !skipTitles.has(n.title) && n.title.length > 0);
// ★兼容阿拉伯数字章号（第1章/第100章）
let startIdx = allNav.findIndex(n => /第[\d一二三四五六七八九十百千]+章/.test(n.title));
if (startIdx === -1) startIdx = 0;
const chapters = allNav.slice(startIdx);

console.log(`共 ${chapters.length} 个章节条目`);

// HTML -> 纯文本
function htmlToText(html) {
  let t = html;
  // 去 head/style/script
  t = t.replace(/<head[\s\S]*?<\/head>/gi, '');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
  // 段落/标题/块级换行
  t = t.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/td>/gi, '\t');
  // 图片占位
  t = t.replace(/<img[^>]*>/gi, '[图]');
  // 去剩余标签
  t = t.replace(/<[^>]+>/g, '');
  // 实体（★数字实体须在 &amp; 之前处理，否则 &#8212; 被先替换成 &#8212; 的字面 & 序列）
  t = t.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
     .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
     .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&ldquo;/gi, '“').replace(/&rdquo;/gi, '”').replace(/&hellip;/gi, '…');
  // 清理空行
  t = t.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n');
  return t.trim();
}

// 逐个章节提取
const fileCache = new Map();
function getFile(src) {
  // ★src 可能带百分号编码（中文/空格文件名），先解码；去掉 #锚点
  const base = decodeURIComponent(src.split('#')[0]);
  if (fileCache.has(base)) return fileCache.get(base);
  let f = path.join(extractDir, base.replace(/[/\\]/g, '__'));
  if (!fs.existsSync(f)) {
    // 相对 OPF 目录的路径（如 OPF 在 OEBPS/ 时 src="ch1.html" 实际是 OEBPS/ch1.html）：
    // 兜底找拍平后 basename 匹配的文件
    const bname = base.replace(/[/\\]/g, '__').split('__').pop();
    const hit = fs.readdirSync(extractDir).find(x => x.split('__').pop() === bname);
    if (hit) f = path.join(extractDir, hit);
  }
  let content = '';
  if (fs.existsSync(f)) content = fs.readFileSync(f, 'utf8');
  fileCache.set(base, content);
  return content;
}

const seen = new Set();
const chaptersOut = [];
const fullTexts = [];
for (const ch of chapters) {
  const base = ch.src.split('#')[0];
  // 同一文件多个锚点（如 index_split_001.html 里「正文」+「第一章」）只保留首个章节标题下的内容
  if (seen.has(base)) continue;
  seen.add(base);
  const html = getFile(base);
  const text = htmlToText(html);
  if (!text) continue;
  chaptersOut.push({ title: ch.title, file: base, text });
  fullTexts.push(`【${ch.title}】\n${text}`);
}

// 写分章文件 + 汇总
chaptersOut.forEach((c, i) => {
  fs.writeFileSync(path.join(outDir, 'book-chapters', `${String(i + 1).padStart(4, '0')}.txt`), `${c.text}\n`, 'utf8');
});

// 全书 TXT：带目录（书名/作者/来源可传参，默认通用占位）
const bookName = process.argv[4] || 'book';
const bookAuthor = process.argv[5] || 'unknown';
const bookSource = process.argv[6] || '';
let bookTxt = `《${bookName}》\n作者：${bookAuthor}\n${bookSource ? `来源：${bookSource}\n` : ''}==== 目录 ====\n`;
chaptersOut.forEach((c, i) => { bookTxt += `${i + 1}. ${c.title}\n`; });
bookTxt += '\n' + fullTexts.join('\n\n');
fs.writeFileSync(path.join(outDir, `${bookName}.txt`), bookTxt, 'utf8');

// 章节 JSON（供阅读器/评论匹配）
const meta = {
  book: bookName,
  author: bookAuthor,
  source: bookSource,
  bookId: '',
  total: chaptersOut.length,
  chapters: chaptersOut.map((c, i) => ({ index: i + 1, title: c.title, file: c.file, chars: c.text.length })),
};
fs.writeFileSync(path.join(outDir, 'chapters.json'), JSON.stringify(meta, null, 2), 'utf8');

// 清理
fs.rmSync(extractDir, { recursive: true, force: true });

const totalChars = chaptersOut.reduce((s, c) => s + c.text.length, 0);
console.log(`\n完成！${chaptersOut.length} 章，共 ${totalChars.toLocaleString()} 字`);
console.log(`输出: ${path.join(outDir, `${bookName}.txt`)}`);
console.log(`章节列表: ${path.join(outDir, 'chapters.json')}`);
console.log(`分章目录: ${path.join(outDir, 'book-chapters')}\\`);
