# .dbook 格式标准 v1（段评书架）

> 「段评书架」App 的书籍/段评数据交换格式。零依赖，任何语言可读写。
> 本文件同时是格式规范与实现参考（Node 打包 / Android 解析）。

---

## 1. 二进制容器

`.dbook` 是单文件二进制容器，内部为「元信息 + 文件表」，每个文件 gzip 压缩。

```
┌────────────────────────────────────────────┐
│ MAGIC   : 8 字节 ASCII "DLCBOOK1"          │
│ metaLen : u32 LE，meta JSON 的 UTF-8 字节长 │
│ meta    : metaLen 字节 JSON（见 §2）        │
│ fileCount: u32 LE，文件条目数               │
│ 文件条目 × fileCount:                       │
│   nameLen : u32 LE                         │
│   name    : nameLen 字节 UTF-8（相对路径）  │
│   gzLen   : u32 LE                         │
│   data    : gzLen 字节 gzip(data)           │
└────────────────────────────────────────────┘
```

- 所有整数：**u32 小端（LE）**
- 路径分隔符：`/`（App 端解析时防 `..` 路径穿越）
- 文件名建议按章节 padStart(4,'0')：`chapters/0001.txt`

## 2. meta JSON（必带）

文件表内第一个条目固定为 `meta.json`（不压缩约定：仍按同一 gzip 规则打包，名字固定 `meta.json`）。

```jsonc
{
  "book_id": "100000001",          // 书唯一 ID（导入时作为目录名）
  "book_name": "示例书名",
  "author": "作者名",
  "chapter_count": 831,
  "has_tsukkomi": true,
  "tsukkomi_count": 133917,        // 全书段评总数
  "chapter_tsukkomi": {            // 每章段评数：章节序号(去前导0字符串) -> 数量
    "1": 1262,
    "2": 341
  },
  "titles": {                      // 章节标题表：序号 -> 标题（App 目录用）
    "1": "第一章 知识",
    "2": "第二章 ……"
  },
  "built_at": "2026-08-30T09:00:00.000Z"
}
```

> App 读取 `book_id` 决定存书目录；`chapter_count` 决定章节总数；
> `titles` 供目录渲染；`chapter_tsukkomi`/`tsukkomi_count` 供书架卡片显示 💬 数。

## 3. 文件表内容

| 路径 | 必带 | 说明 |
|---|---|---|
| `meta.json` | ✅ | 见 §2 |
| `chapters/<NNNN>.txt` | 完整书带 / 段评包不带 | 正文，每行一段，首行为章节标题 |
| `tsukkomi/<NNNN>.json` | 有段评则带 | 该章段评数据，见 §4 |

**两种包模式：**
- **完整书包**：`meta.json` + `chapters/*` + `tsukkomi/*`（App「导入书」用，覆盖导入）
- **段评包**：`meta.json` + `tsukkomi/*`（App「导入段评」用，只更新指定书的段评，不动正文）

## 4. 段评 JSON 格式（每章一个文件）

```jsonc
{
  "paragraphs": [
    {
      "paragraph_index": 0,        // 段落序号：0 = 章节标题段，1 = 正文第一段（与 chapters/NNNN.txt 行号对齐）
      "tsukkomi": [
        {
          "id": 192841310,         // 段评 ID（来源平台原始 ID）
          "para": 0,               // 所在段落（冗余，与 paragraph_index 一致）
          "user": "废物的练成方法",  // 用户昵称
          "uid": 12313353,         // 用户 ID
          "ip": "黑龙江",           // IP 归属地（已脱敏为省市）
          "content": "三刷",        // 段评正文（纯文本，表情码见 §5）
          "like": 0,               // 点赞数
          "unlike": 0,             // 点踩数（未启用可为 0）
          "lou": 326,              // 楼层号（该段内从 1 起）
          "reply": 0,              // 回复数
          "hot_reply": [           // 热评回复（可空数组或省略）
            { "user": "xx", "content": "yyy" }
          ],
          "time": "2026-08-29 08:02:50"  // 时间，格式 YYYY-MM-DD HH:MM:SS（可带时区）
        }
      ]
    }
  ]
}
```

字段约束：
- `paragraph_index` 从 **0** 开始（0 是标题段），与 `chapters/NNNN.txt` 的**行号一一对应**（第 1 行=标题=0，第 2 行=正文首段=1……）
- `tsukkomi` 数组**可空**（`[]`）表示该段无段评
- `hot_reply` 可省略；其元素仅需 `user`/`content` 两字段

## 5. 表情码（可选约定）

段评正文里的 `#(xxx)` 为表情码，App 端映射为 emoji：

| 码 | emoji |
|---|---|
| `#(可爱)` | 😊 |
| `#(笑)` | 😄 |
| `#(泪)` | 😭 |
| `#(怒)` | 😠 |
| `#(汗)` | 😅 |
| `#(囧)` | 😳 |
| `#(无语)` | 😑 |
| `#(滑稽)` | 😏 |
| `#(惊喜)` | 😮 |
| `#(心)` | ❤️ |

未知码保留原文。

## 6. 实现参考

### Node 打包（build_dbook.mjs）

```bash
node build_dbook.mjs <书目录> <输出.dbook>            # 完整书包
node build_dbook.mjs <书目录> <输出.dbook> --tsukkomi-only  # 段评包
```

书目录结构：

```
书目录/
├── chapters.json          # 见 §7
├── book-chapters/
│   ├── 0001.txt           # 每行一段，首行标题
│   └── ...
└── tsukkomi/
    ├── 0001.json          # §4 格式
    └── ...
```

### Android 解析（MainActivity.parseDbook）

- `MAGIC` 校验 → 读 `metaLen` → 读 meta JSON → 读文件表，逐条解 gzip
- 防路径穿越：`name.contains("..")` 拒绝
- mode=book：整包写入 `filesDir/books/<book_id>/`；mode=tsukkomi：只写 `tsukkomi/` 到目标书，并更新其 `meta.json` 的 `chapter_tsukkomi`/`tsukkomi_count`

## 7. chapters.json（源目录元信息，不打进 dbook 的正文条目）

```jsonc
{
  "book": "示例书名",
  "bookId": "100000001",
  "author": "作者名",
  "chapters": [
    { "index": 1, "title": "第一章 知识" }
  ]
}
```

## 8. 兼容性说明

- 格式版本由 MAGIC 区分：`DLCBOOK1` = v1。后续若改格式，换新 MAGIC 或加版本字段。
- App 端 `versionCode 2 / versionName 2.0`。
- 段评数据来源为刺猬猫 App 接口（`chapter/get_paragraph_tsukkomi_list_new`），simplify 后落盘，与上表一致。
