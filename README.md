# 刺猬猫段评工具箱（Ciweimao Tsukkomi Toolkit）

从刺猬猫（ciweimao）抓取章节段评（吐槽），打包成 `.dbook`，在安卓「段评书架」App 里看书时点开每段话的评论。纯 Node 零依赖，无需 Python。

```
publish/
├── duoluoxi_app/                 # 安卓「段评书架」App 源码（WebView 阅读器）
│   └── DBOOK_FORMAT.md           # .dbook 格式规范
├── ciweimao_vis_crawler.mjs      # 段评可视化爬虫面板（浏览器操作）
├── dbook_pack_panel.mjs          # .dbook 可视化打包面板
├── build_dbook.mjs               # .dbook 打包 CLI
├── build_dbook_from_crawler.mjs  # 爬虫数据 → .dbook CLI
├── epub2txt.mjs                  # EPUB → 分章 TXT 转换器
├── gen_reader_html.mjs           # 生成单章 HTML 阅读页（含段评弹层）
└── build_index.mjs               # 生成目录页 index.html
```

## 快速开始

```bash
# 1. 启动爬虫面板
node ciweimao_vis_crawler.mjs        # http://127.0.0.1:8788

# 2. 启动打包面板
node dbook_pack_panel.mjs            # http://127.0.0.1:8789
```

### 流程

1. **登录**：爬虫面板里输入刺猬猫账号（手机号）+ 验证码（短信），登录态存到 `_ciweimao_app_token.json`。
2. **抓取**：输入书 ID（URL 末尾数字）→ 选卷 → 配并发/间隔 → 开爬。数据落到 `ciweimao_data/<book_id>/<division_id>/tsukkomi/*.json`，支持断点续传。
3. **打包**：打包面板扫描已抓取的书 → 「📦打段评包」或「📚打完整书（需正文目录）」→ 输出 `.dbook`。
4. **导入**：手机装「段评书架」APK → ＋ 导入书 → 选 `.dbook`。已导入的书可随时 ⚙ → 导入段评更新。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `CIWEMAO_DATA` | 爬虫数据目录 | `./ciweimao_data` |
| `CIWEMAO_TOKEN` | 登录态文件路径 | `./_ciweimao_app_token.json` |
| `DBOOK_OUT` | 打包输出目录 | `./dbook_out` |
| `BOOK_DIR` | 书目录（gen_reader_html/build_index 用） | `./book` |

## 安卓 App

- 技术栈：WebView + 原生 JS 桥，无第三方依赖，minSdk 26 / targetSdk 34。
- 内置书架（shelf/index.html）、阅读器（shelf/reader.html）：行级分页、音量键翻页、左右滑动翻页、字号/主题切换、段评 bottom sheet。
- 书籍数据通过 `.dbook` 导入（内置示例数据不含在源码仓库，用爬虫+打包工具自己生成）。

### 构建

```bash
# 需要 JDK 17 + Android SDK（platform 34 + build-tools 34）
gradle assembleDebug
# 产物: app/build/outputs/apk/debug/app-debug.apk
```

## 格式

`.dbook` 容器与段评 JSON 字段见 [duoluoxi_app/DBOOK_FORMAT.md](duoluoxi_app/DBOOK_FORMAT.md)。

## 免责声明

- 本工具仅用于个人学习与备份自己购买/有权限访问的内容，请勿用于商业用途或大规模抓取。
- 爬取频率请保持克制（默认并发 4、间隔 200ms 已偏保守）；滥用可能导致账号风控。
- 段评数据版权归原作者/平台所有。
