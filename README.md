<div align="center">

# 📚 段评书架 · 网文段评工具箱

**在安卓上看网络小说，每段话都能点开读者评论（段评/吐槽/本章说）**

抓取 → 打包 → 阅读，全流程开源。纯 Node 零依赖，无 Python，无需服务器。

> 🚧 **多平台规划**：当前已支持 **刺猬猫（欢乐书客）**，起点、番茄等平台适配陆续开发中。

</div>

---

## ✨ 项目简介

网络小说的段评（本章说）是阅读的灵魂——读者在每段话下面插科打诨、预测剧情、玩梗接龙。但多数平台 Web 端段评早已下线，App 端也不支持导出。

这个工具箱帮你：

1. **抓取** 平台小说全部段评（免登录只读也能抓）
2. **打包** 成自研 `.dbook` 单文件格式（正文 + 段评一体化）
3. **阅读** 在安卓「段评书架」App 里像原版一样点段看评论，还支持 **音量键翻页**

```
平台 App 接口 ──爬虫面板──▶ 数据目录/ ──打包面板──▶ .dbook ──导入──▶ 段评书架 App
  (浏览器操作)    (断点续传)     (一键打包)          (USB/网盘)     (安卓阅读)
```

### 支持的平台

| 平台 | 段评抓取 | 状态 |
|---|---|---|
| 刺猬猫（欢乐书客） | ✅ 完整支持（含付费章段评） | 已可用 |
| 起点 / 番茄 / 其他 | ⏳ 规划中 | 敬请期待 |

---

## 🛠️ 工具组成

| 工具 | 作用 | 入口 |
|---|---|---|
| `ciweimao_vis_crawler.mjs` | 刺猬猫段评可视化爬虫面板 | `http://127.0.0.1:8788` |
| `dbook_pack_panel.mjs` | `.dbook` 可视化打包面板 | `http://127.0.0.1:8789` |
| `build_dbook.mjs` | `.dbook` 打包 CLI | 命令行 |
| `build_dbook_from_crawler.mjs` | 爬虫数据 → `.dbook` CLI | 命令行 |
| `epub2txt.mjs` | EPUB → 分章 TXT | 命令行 |
| `gen_reader_html.mjs` / `build_index.mjs` | 生成网页版阅读器 | 命令行 |
| `duoluoxi_app/` | 安卓「段评书架」App 源码 | Gradle 构建 |

> 各平台爬虫独立，`.dbook` 格式与 App 平台无关——以后起点/番茄的爬虫接入后，打包与阅读流程完全复用。

---

## 📖 快速开始

### 环境要求

- **Node.js ≥ 22**（自带 `fetch`，无需任何 npm 依赖）
- 一个刺猬猫账号（手机号 + 短信验证码登录，仅刺猬猫平台需要）
- 安卓 8.0+ 手机（装 App 用）

### 第 1 步：启动爬虫面板

```bash
node ciweimao_vis_crawler.mjs
# 浏览器打开 http://127.0.0.1:8788
```

面板上：

1. **登录**：输入手机号 → 点发送验证码 → 填短信验证码 → 登录（登录态存到 `_ciweimao_app_token.json`，下次自动生效）
2. **查书**：输入书 ID（书籍链接 URL 末尾的数字）→ 自动带出书名和卷列表
3. **配置**：选卷 → 起止章节 → 并发数（默认 4）→ 间隔毫秒（默认 200）
4. **开爬**：实时进度条 + 日志，随时可暂停/继续/停止；中断后重开自动**断点续传**

数据落在 `ciweimao_data/<book_id>/<division_id>/tsukkomi/*.json`。

> 💡 **段评是免费的**：即便章节是付费章节，段评内容也可以不购买直接抓取。

### 第 2 步：打包 .dbook

```bash
node dbook_pack_panel.mjs
# 浏览器打开 http://127.0.0.1:8789
```

- 面板自动扫描已抓取的书 → 每本两个按钮：
  - **📦 打段评包**：只有段评（小，适合已导入过正文的书更新段评）
  - **📚 打完整书**：正文 + 段评（需要提供正文目录，见下文）
- 产物输出到 `dbook_out/` 目录

> 📖 **正文从哪来？** 用 `epub2txt.mjs` 把 EPUB 转成书目录结构即可：
> ```bash
> node epub2txt.mjs "book.epub" ./book-output "书名" "作者" "来源URL"
> # 生成 book-output/book-chapters/NNNN.txt + chapters.json
> ```

### 第 3 步：导入手机阅读

1. 把 `.dbook` 文件传到手机（网盘 / USB / 微信文件传输均可）
2. 安装「段评书架」APK（见下方构建，或取 Release 附件）
3. 打开 App → **＋ 导入书** → 选 `.dbook`
4. 点开书 → 阅读 → **点击段落末尾的 💬 徽章** 弹出该段全部评论

以后更新段评：书卡片 **⚙ 齿轮 → 导入段评** → 选新的段评包即可，正文不动。

---

## 📱 段评书架 App

WebView + 原生 JS 桥，无第三方依赖，**minSdk 26 / targetSdk 34**。

### 阅读体验

- 📖 **行级分页**：像番茄小说一样按行排版，段落不跨页，翻页干净
- 🔊 **音量键翻页**：短按音量键翻页（不改变系统音量）
- 👆 **触摸翻页**：左右 1/3 区域点击、左右滑动均翻页
- 🔤 **字号调节**：三档字号切换
- 🌙 **主题切换**：暗色 / 米纸浅色
- 💬 **段评弹层**：点段尾徽章弹出 bottom sheet，展示用户 / IP属地 / 楼层 / 内容 / 点赞 / 热评回复 / 时间
- 📑 **目录**：章节列表 + 搜索 + 每章评论数
- 📥 **导入**：`.dbook` 完整书导入 / 段评单独更新，本地存储（`filesDir`）

### 构建 APK

```bash
# 需要 JDK 17 + Android SDK（platform-34 + build-tools;34.0.0）
gradle assembleDebug
# 产物: app/build/outputs/apk/debug/app-debug.apk
```

> 仓库不内置书数据（版权与隐私考虑）。装好 App 后用第 3 步导入自己的书。

---

## 🧩 CLI 工具详情

### build_dbook.mjs —— 通用 .dbook 打包

```bash
node build_dbook.mjs <书目录> <输出.dbook> [--tsukkomi-only]
```

书目录结构：

```
book/
├── chapters.json            # {book, bookId, author, chapters:[{index,title}]}
├── book-chapters/0001.txt   # 正文，每行一段，首行为标题
└── tsukkomi/0001.json       # 段评（可选）
```

### build_dbook_from_crawler.mjs —— 爬虫数据直接打包

```bash
node build_dbook_from_crawler.mjs <book_id> [--with-text <正文目录>] [--list]
```

自动扫描 `ciweimao_data/<book_id>/` 下所有卷合并打包，多卷自动重排全局章节序号。

### epub2txt.mjs —— EPUB 转书目录

```bash
node epub2txt.mjs "<epub路径>" [输出目录] [书名] [作者] [来源URL]
```

### gen_reader_html.mjs / build_index.mjs —— 网页版阅读器

不需要安卓 App 时，可以直接生成静态 HTML 阅读站（正文 + 段评弹层 + 目录搜索页）：

```bash
BOOK_DIR=./book node gen_reader_html.mjs   # 生成 reader/chapter/NNNN.html
BOOK_DIR=./book node build_index.mjs       # 生成 reader/index.html
```

---

## 🔧 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `CIWEMAO_DATA` | 爬虫数据目录 | `./ciweimao_data` |
| `CIWEMAO_TOKEN` | 登录态文件路径 | `./_ciweimao_app_token.json` |
| `DBOOK_OUT` | 打包输出目录 | `./dbook_out` |
| `BOOK_DIR` | 书目录（HTML 阅读器用） | `./book` |

---

## 📦 .dbook 格式

自研二进制容器：`MAGIC(DLCBOOK1) + meta JSON + gzip 文件表`。任意语言可读写。

完整规范（含段评 JSON 字段、表情码表、Android 解析参考）见 **[duoluoxi_app/DBOOK_FORMAT.md](duoluoxi_app/DBOOK_FORMAT.md)**。

---

## ❓ FAQ

**Q：需要会员/VIP 才能抓段评吗？**
A：不需要。段评内容与购买状态无关，免费章节付费章节都能抓（以刺猬猫为例）。

**Q：抓取会不会封号？**
A：默认并发 4、间隔 200ms 已很保守。别开太高并发刷，单本书全量抓一般没问题。

**Q：App 里显示「导入段评」和「导入书」有什么区别？**
A：导入书 = 完整书（正文+段评，覆盖旧版）；导入段评 = 只更新评论数据，正文不动。已导入的书想刷新评论用后者。

**Q：段评里的 IP 是什么？**
A：段评接口返回的评论者 IP 属地（如「浙江」），App 里展示在评论者旁边。

**Q：内置示例书为什么没有了？**
A：仓库出于版权和隐私考虑不内置书数据。用爬虫 + 打包工具自己生成即可（5 分钟搞定）。

---

## ⚠️ 免责声明

- 本工具仅用于**个人学习与备份自己购买/有权限访问的内容**，请勿用于商业用途或大规模抓取。
- 爬取请保持克制，滥用可能导致账号风控。
- 段评及正文版权归原作者/平台所有；本项目与各小说平台官方无任何关联。

---

<div align="center">

**如果这个工具帮到了你，给个 ⭐ 吧！** 🐟

</div>
