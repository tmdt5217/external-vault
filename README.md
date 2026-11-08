# External File Image_PXM

在 Obsidian 中直接编辑**仓库外**的 Markdown 笔记：粘贴或拖入图片时自动保存到库外附件目录，并写入正确的相对路径；同时提供库内与库外之间的一键搬运，笔记和附件一起走、链接自动重写。

An Obsidian plugin for editing Markdown notes **outside your vault**: paste or drop images and get correct relative paths, create external notes from a template, and move notes together with their attachments in or out of the vault.

## 功能

- **库外笔记插图**：在库外 Markdown 里粘贴截图、拖入图片或其他附件，自动存到库外附件目录，并插入两个目录之间的相对路径。库内笔记的行为完全不变。
- **新建库外 Markdown**：一键在库外 MD 目录新建笔记，默认套用内置的 YAML frontmatter 模板；也可改用库内模板文件或直接写自定义文本。支持 `{{title}}`、`{{filename}}`、`{{date}}`、`{{date:YYYY-MM-DD}}`、`{{time}}`。
- **Ribbon 按钮**：打开 External Vault、打开附件目录、新建库外 MD、复制目录路径，并按修改时间列出最近的库外笔记直接打开。
- **右键菜单**：库内笔记（支持多选）→「移出 Vault」；库外文件的标签页 →「移入 Vault」。两者都会把笔记链接的本地附件一起搬走，并重写成新位置的相对路径；`[[双链]]` 和网络图片不会被搬动。
- **真剪切**：源文件直接移除，不生成额外的备份目录；删前会校验所有目标文件已写盘，被其他笔记共用的附件只复制、保留原件。可选移入系统废纸篓。
- **零配置默认**：与库同级的 `External Vault/` 放 MD，`External Vault/attachments/` 放附件。也可以只设置两个相对目录，改用自定义模式。

## 默认目录结构

```text
父目录/
├── 你的库/                  ← Obsidian vault（含 .obsidian）
└── External Vault/          ← 库外 MD
    ├── 笔记.md
    └── attachments/         ← 库外附件
```

## 安装

- **社区插件商店**：上架后可在 Obsidian 的「第三方插件 → 浏览」中搜索安装。
- **手动安装**：从 Releases 下载 `main.js`、`manifest.json`、`styles.css`，放入
  `<vault>/.obsidian/plugins/external-file-image-pxm/`，然后在 Obsidian 中启用。

## 使用

1. 用「打开仓库外的文件…」打开一个库外 Markdown，或点击 Ribbon 的文件夹按钮新建/打开库外笔记。
2. 在库外笔记里直接粘贴截图或拖入文件，插件会把附件写入库外附件目录并插入相对路径。
3. 在库内文件列表右键笔记（可多选）选择「移出 Vault」；在库外笔记标签页右键选择「移入 Vault」。

默认目标：移出时 MD 落到 `External Vault/`、附件落到 `External Vault/attachments/`；移入时 MD 落到库根目录、附件落到库内默认附件文件夹。

## 库外文件访问说明（重要）

本插件会读写 Obsidian vault **之外**的文件，这是它的核心功能，原因如下：

- Obsidian 1.14+ 可以直接打开库外 Markdown，但原生的粘贴/拖放仍会把附件写进库内，导致相对路径失效；本插件需要把附件写到库外笔记旁边的附件目录。
- 「移出 / 移入 Vault」需要在库目录与库外目录之间复制、校验并删除源文件。

访问范围仅限你在设置中指定的两个目录（默认是 vault 同级的 `External Vault/` 与其 `attachments/`）。插件**不联网、不上传任何内容、不包含遥测**，也不会访问你未指定的其他路径。删除源文件前会先确认目标文件全部写盘成功；被其他笔记共用的附件只复制、不删除。

## 隐私

- 无网络请求，无分析/遥测，无需账号。
- 所有操作都在本机文件系统内完成。
- 不收集文件名、路径或笔记内容。

## 兼容性

- 桌面版 Obsidian **1.14.0** 及以上。
- 仅桌面端：库外文件与 Node.js 文件系统 API 都是桌面功能，移动端不支持。

## 模板变量

| 变量 | 输出 |
|---|---|
| `{{title}}` | 笔记标题（不含 `.md`） |
| `{{filename}}` | 笔记文件名（含 `.md`） |
| `{{date}}` | 当前日期，默认 `YYYY-MM-DD` |
| `{{date:YYYY/MM/DD}}` | 自定义格式的日期 |
| `{{time}}` | 当前时间 `HH:mm` |

## 开发

`main.js` 是构建产物，本仓库直接以它作为源码维护；修改后用 `node --check main.js` 做语法校验，再重载 Obsidian 验证。

## English

**External File Image_PXM** lets you edit Markdown notes that live outside your vault:

- Paste or drop images into an external note and get a correct relative path; attachments are stored in your external attachment folder.
- Create external notes from a template (file or inline text) with `{{title}}`, `{{filename}}`, `{{date}}`, `{{date:FORMAT}}`, and `{{time}}`.
- Move notes with their attachments in or out of the vault from the file context menu (multi-select supported) or the external note's tab. Links are rewritten automatically; wiki links and remote images are left untouched.
- Zero-config default: a sibling `External Vault/` folder for notes and `External Vault/attachments/` for attachments, or two custom relative directories.

**External file access:** this plugin reads and writes files outside the vault, limited to the two directories you configure. It is required because Obsidian's native paste/drop writes attachments into the vault, and because moving notes in or out of the vault must touch both locations. The plugin makes no network requests, collects no telemetry, and uploads nothing. Source files are removed only after every target file is verified on disk; attachments shared with other notes are copied, not deleted.

Desktop only (Obsidian 1.14+).

## License

[MIT](LICENSE)
