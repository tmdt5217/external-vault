# External Vault

在 Obsidian 中直接编辑**仓库外**的 Markdown 笔记：粘贴或拖入图片时自动保存到库外附件目录，并写入正确的相对路径；同时提供库内与库外之间的一键搬运，笔记和附件一起走、链接自动重写。

An Obsidian plugin for editing Markdown notes **outside your vault**: paste or drop images and get correct relative paths, create external notes from a template, and move notes together with their attachments in or out of the vault.

## 演示

![External Vault 演示](docs/demo.gif)

> 10 秒看懂：在库外笔记里粘贴截图 → 自动存到 `External Vault/attachments` 并写入相对路径 → 右键标签页「移入 Vault」，笔记和附件一起搬回库内，链接自动重写。
>
> 录制方法见 [docs/演示录制.md](docs/演示录制.md)。把导出的 GIF 命名为 `docs/demo.gif`，GitHub 与插件商店会自动显示。

## 功能

- **库外笔记插图**：在库外 Markdown 里粘贴截图、拖入图片或其他附件，自动存到库外附件目录，并插入两个目录之间的相对路径。库内笔记的行为完全不变。
- **新建库外 Markdown**：一键在库外 MD 目录新建笔记，默认套用内置的 YAML frontmatter 模板；也可改用库内模板文件或直接写自定义文本。支持 `{{title}}`、`{{filename}}`、`{{date}}`、`{{date:YYYY-MM-DD}}`、`{{time}}`。
- **Ribbon 按钮**：打开 External Vault、打开附件目录、新建库外 MD、复制目录路径，并按修改时间列出最近的库外笔记直接打开。
- **右键菜单**：库内笔记（支持多选）→「移出 Vault」；库外文件的标签页 →「移入 Vault」。两者都会把笔记链接的本地附件一起搬走，并重写成新位置的相对路径；`[[双链]]` 和网络图片不会被搬动。
- **删除库外笔记**：库外标签页右键 →「删除库外 MD（含附件）」。删除前扫描该笔记链接的附件，只删**未被其他笔记引用**的库外附件；仍被引用的附件和库内附件一律保留。
- **库外文件管理器**：Ribbon 菜单 →「管理库外文件…」，一次列出 External Vault 下所有 Markdown（含子目录）及其附件数、修改时间；顶部搜索框可按文件名或路径实时过滤，支持全选或多选批量删除。批量删除时，只要附件仍被**未选中**的任意笔记引用，就保留不删。
- **库内链接库外**：库内笔记里写一个相对链接（如 `[标题](../External%20Vault/笔记.md)`），点击即可在 Obsidian 里打开库外文件，不会误建空笔记。编辑器右键 →「插入库外文件链接」会打开带搜索框的列表，勾选一篇或多篇后点「插入」，按当前笔记所在目录生成链接（多选时每行一个）；换电脑后只要目录结构一致就能继续用。命令面板里也有同一入口。库外链接显示为红色、无下划线，与库内链接区分；悬停时 Hover Editor 或原生页面预览会直接显示库外文件的真实内容，不再提示「未创建」。
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
  `<vault>/.obsidian/plugins/external-vault/`，然后在 Obsidian 中启用。

## 使用

1. 用「打开仓库外的文件…」打开一个库外 Markdown，或点击 Ribbon 的文件夹按钮新建/打开库外笔记。
2. 在库外笔记里直接粘贴截图或拖入文件，插件会把附件写入库外附件目录并插入相对路径。
3. 在库内文件列表右键笔记（可多选）选择「移出 Vault」；在库外笔记标签页右键选择「移入 Vault」或「删除库外 MD（含附件）」。
4. 要集中清理库外笔记，点左侧 Ribbon 的文件夹按钮 →「管理库外文件…」，勾选后批量删除。
5. 从库内笔记链接到库外文件：在编辑器里右键 →「插入库外文件链接」（或命令面板同一命令），在列表里搜索、勾选（可多选），点「插入」。

默认目标：移出时 MD 落到 `External Vault/`、附件落到 `External Vault/attachments/`；移入时 MD 落到库根目录、附件落到库内默认附件文件夹。

## 移动行为说明

### 链接自动改写

笔记移入 / 移出后，插件会扫描**库内和库外的所有 Markdown**，把引用它的链接改写掉：

| 方向 | 原链接 | 改写后 |
|---|---|---|
| 库内 → 库外 | `[[笔记]]` | `[笔记](../External Vault/笔记.md)` |
| 库外 → 库内 | `[笔记](../External Vault/笔记.md)` | `[[笔记]]` |

- 带 `#标题`、`|别名` 的 wiki 链接也能识别
- 文件名含括号、空格、中文都能处理
- 引用笔记正开在编辑器里时，直接更新编辑器内容并保存，避免旧内容覆盖
- 库内笔记用 `vault.process` 修改，可撤销

### 标签页行为

- 移入 / 移出后**不会切换当前笔记**，也不会抢占焦点
- 被移动笔记的标签会原地指向新位置（库内 ↔ 库外）
- 如果库内新文件还没被 Obsidian 索引，插件会**保留源文件不剪切**，避免标签变成「未打开文件（外）」

### 双向拖拽

| 拖动 | 放到 | 结果 |
|---|---|---|
| 库内文件列表 | 右侧面板 | 移出 Vault |
| 右侧面板 | 库内文件列表 | 移入 Vault |
| 右侧面板 | 编辑器正文 | 插入相对链接（图片为 `![]()`） |

移动完成后右侧面板会立即刷新。

### 已知限制

- 库内已有同名笔记时，移入会自动加后缀（`笔记 1.md`），引用链接仍按原名改写，需要手动确认
- 名含不配对 `)` 的文件名，手写链接时需写成 `%29`
- 大库索引较慢时可能提示「已保留源文件」，手动删除库外副本即可，标签不会损坏

## 命令面板

所有功能都有命令入口，统一以「库外文件：」开头。在命令面板输入「库外文件」即可一次看到全部，也可以给任意一条设置快捷键：

| 命令 | 作用 |
|---|---|
| 新建 Markdown | 在库外 MD 目录新建并打开 |
| 打开 External Vault 菜单 | 等同 Ribbon 文件夹按钮的完整菜单 |
| 打开最近编辑的笔记 | 打开最近修改的库外 MD |
| 查看全部 / 批量删除 | 带搜索的文件管理器 |
| 插入相对链接（可多选） | 在当前库内笔记插入库外链接 |
| 删除当前库外 MD（含附件） | 删除当前打开的库外笔记 |
| 移入 Vault（当前文件） | 当前库外 MD + 附件搬进库 |
| 移出 Vault（当前笔记） | 当前库内笔记 + 附件搬到库外 |
| 移入 Vault（整个库外目录） | 批量搬入库 |
| 移出 Vault（当前笔记所在文件夹） | 批量搬出库 |
| 移出 / 移入 Vault（右键动作） | 与右键菜单等价 |
| 在文件管理器中打开 MD 目录 | 系统访达 / 资源管理器 |
| 在文件管理器中打开附件目录 | 同上 |
| 复制 External Vault 路径 | 复制库外 MD 目录绝对路径 |
| 复制附件目录路径 | 复制库外附件目录绝对路径 |
| 修复当前笔记的图片链接 | 修复坏链 |
| 诊断当前库外文件 | 复制诊断信息 |

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

发布新版本：

```bash
./release.sh 1.10.8
```

脚本会自动改 `manifest.json`、`versions.json` 和代码里的版本号，跑语法校验，然后 commit、打 tag、push；装了 `gh` 会直接创建 Release，没装会打印网页链接，手动上传 `main.js`、`manifest.json`、`styles.css` 即可。

## English

**External Vault** lets you edit Markdown notes that live outside your vault:

- Paste or drop images into an external note and get a correct relative path; attachments are stored in your external attachment folder.
- Create external notes from a template (file or inline text) with `{{title}}`, `{{filename}}`, `{{date}}`, `{{date:FORMAT}}`, and `{{time}}`.
- Move notes with their attachments in or out of the vault from the file context menu (multi-select supported) or the external note's tab. Links are rewritten automatically; wiki links and remote images are left untouched.
- Delete an external note from its tab menu: linked attachments that no other external note references are removed with it; shared attachments and anything inside the vault are kept.
- Manage external notes from the ribbon menu: list every Markdown file in External Vault, show its attachment count and modified time, select several, and delete them together with their attachments. An attachment is kept whenever any unselected note still references it.
- Link to external notes from inside the vault: a relative Markdown link such as `[Title](../External%20Vault/note.md)` opens the external file in Obsidian instead of creating an empty note. Use the editor context menu → "Insert link to external file" (or the same command), search the list, select one or more notes, and click Insert; links are generated from the current note's folder, one per line when multiple files are selected. External links are shown in red without an underline; hovering one opens a real preview of the external file in Hover Editor or the native page preview instead of reporting it as missing.
- Zero-config default: a sibling `External Vault/` folder for notes and `External Vault/attachments/` for attachments, or two custom relative directories.

**External file access:** this plugin reads and writes files outside the vault, limited to the two directories you configure. It is required because Obsidian's native paste/drop writes attachments into the vault, and because moving notes in or out of the vault must touch both locations. The plugin makes no network requests, collects no telemetry, and uploads nothing. Source files are removed only after every target file is verified on disk; attachments shared with other notes are copied, not deleted.

Desktop only (Obsidian 1.14+).

## License

[MIT](LICENSE)
