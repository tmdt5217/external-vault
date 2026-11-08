'use strict';

/*
 * external-vault  v1.11.1
 *
 * 用途：Obsidian 1.14+ 编辑「仓库外的 Markdown 文件」时：
 *   1) 命令「新建库外 Markdown 文件」→ 在「库外 MD 目录」里创建 .md 并尝试打开
 *   2) 粘贴 / 拖入图片或其他附件 → 存到「库外附件目录」，插入两目录之间的相对路径
 *   3) 绕开 1.14.4 自带逻辑（会把图片塞进 vault 附件夹，或静默失败）
 *   4) 一键「转入库」：库外暂存区里的 MD 连同附件搬进 vault，链接自动重写
 *   5) 一键「移出库」：库内笔记连同附件搬进库外暂存区，链接自动重写
 *   6) 右键菜单：库内笔记（文件列表，单选或多选）→「移出 Vault」；
 *               库外文件（标签页）→「移入 Vault」
 *   7) Ribbon 按钮「打开 External Vault」：菜单里可直接在 Obsidian 中打开
 *      库外 MD、在访达中打开 MD/附件目录、新建库外 MD、复制目录路径
 *
 * 目录模型：所有目录都是「相对 vault 根目录」的字符串，不存绝对路径。
 *   simple（默认，免配置）：
 *     ../External Vault/            ← 与库同级，新建 MD 放这里
 *       ├─ *.md
 *       └─ attachments/            ← 图片与其他附件
 *   custom：手填两个相对目录 customMdDir / customAssetDir，允许 ../ 出库。
 *   <vault>/vaultTargetFolder/     ← 「命令面板」转入库的目标（库内相对目录）
 *     └─ vaultAssetFolder/         ← 「命令面板」转入库时附件放这里（默认 assets）
 *   v1.2 及更早的 externalFolder / rootDir 等绝对路径配置会自动迁移成 custom 相对目录。
 *
 * 右键菜单的两个动作有独立规则（不与命令面板的设置混用）：
 *   移出 Vault：MD → 库外 MD 目录；附件 → 库外附件目录
 *   移入 Vault：MD → 库根目录；附件 → 库内「默认附件文件夹」（读 app.json 的
 *               attachmentFolderPath，例如 attachments）
 *   1.15 起库外文件是 obsidian.TExternalFile（继承 TFile），file.path 形如
 *   "file:/Users/me/Desktop/how.md"，getRealPath() 直接给出绝对路径；
 *   同时监听 workspace 的 file-menu / files-menu / leaf-menu 三个事件并去重，兼容 1.14。
 *
 * 多选（v1.4.2）：文件列表多选时 1.15 触发的是 files-menu(menu, files[], source)，
 *   不再触发 file-menu；插件从数组里筛出库内 TFile 的 .md 一并转移，文件夹与非 md 忽略。
 *   若两个事件对同一个 Menu 都触发，条目只加一次，并把目标升级为较多的那组。
 *
 * v1.4.4 Ribbon 按钮：1.15 里 app.vault.getFileByPath("file:/绝对路径") 会经
 *   externalFileManager 返回 TExternalFile，workspace.getLeaf(false).openFile(file)
 *   即可在 Obsidian 内直接打开库外 MD，不必走「打开仓库外的文件…」文件对话框。
 *   打开目录则优先 electron shell.openPath → showItemInFolder → 系统 open 命令。
 *
 * v1.4.3 修复「移入 Vault 后弹 File already exists.」：库内 MD 是 fs 直接写盘的，
 * metadataCache 尚未纳管时 workspace.openLinkText 会误判成「不存在的双链」去创建
 * 同名文件，vault.create 撞上磁盘上的文件后抛该错误并弹黑色提示。改为等索引就绪
 * 后 leaf.openFile(TFile)，彻底不走创建逻辑。
 *
 * 剪切语义（v1.4.1）：开启「转移后剪切源文件」时，源文件从原位置直接删除，
 * 不再生成额外备份目录；删除前会校验所有目标文件已写盘，
 * 校验不通过就保留源文件。设置里可选「剪切时移入系统废纸篓」（默认关）。
 * 命令面板默认只复制；右键菜单默认真剪切（否则「移出/移入」名不副实）。
 * 被其他笔记共用的附件只复制、保留原件，避免弄断别的笔记。
 * 因不再有备份可回退，转移时会统计「找不到源文件的附件引用」并在摘要里警告；
 * 「修复：当前库外 MD 里的图片链接」同时支持 ![[x.png]] 与 ![](images/x.png) 断链。
 *
 * v1.2.1 修复：Obsidian 1.14 的库外文件路径是 file:/Users/...（单斜杠），
 *   旧版归一化把它当 UNC 丢弃、且强制要求 view.file 存在，导致 paste/drop
 *   完全没被拦截，原生逻辑把图塞进库内附件夹并插入 ![[xxx.webp]]（库外解析不了）。
 *   现支持 file:/ 路径、无 view.file 的视图、items / uri-list 拖拽数据，
 *   并新增命令「修复：当前库外 MD 里的图片链接」用于补救已写坏的链接。
 *
 * 安全边界：只有当前活动视图被确认是「库外文件」时才拦截 paste/drop；
 *           库内笔记、侧边栏输入框、纯文字粘贴一律放行，行为不变。
 *
 * 直接改本文件即可，改完重载 Obsidian 生效。
 */

const obsidian = require('obsidian');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG = '[external-vault]';
const VIEW_TYPE = 'external-vault-panel';

/** 简易模式内置目录，全部相对 vault 根目录（../ = 与库同级） */
const SIMPLE_MD_REL = '../External Vault';
const SIMPLE_ASSET_REL = '../External Vault/attachments';

/** 新建库外 MD 的默认模板路径；留空则直接使用下面的内置 YAML，不依赖任何库内文件 */
const DEFAULT_NOTE_TEMPLATE_PATH = '';
const DEFAULT_NOTE_TEMPLATE_TEXT = '---\ncategory: \ntags: \naliases: \nstars: \n来源:\n---\n\n\n\n\n';

// ---- 界面语言 -------------------------------------------------------------
// 以中文原文为 key 的英文映射；未收录的文案在英文模式下回退中文。
const EN = {
  '库外文件图片 / 新建': 'External files: attachments & new notes',
  '编辑库外 MD 时，粘贴 / 拖入的附件自动存进库外附件目录并插入相对路径；库内笔记行为不变。': 'When editing a Markdown file outside the vault, pasted or dropped attachments are saved to the external attachment folder with relative paths. Notes inside the vault are unaffected.',
  '目录模式': 'Folder mode',
  '选择方式': 'Configuration',
  '简易：无需设置任何文件夹；自定义：自己填两个相对目录': 'Simple: no folders to configure. Custom: set two relative folders yourself.',
  '简易（默认，无需设置）': 'Simple (default, no setup)',
  '自定义两个目录': 'Custom (two folders)',
  '所有目录都相对当前 vault 根目录填写，"../" 表示与库同级。当前库：': 'All folders are relative to the vault root. "../" means a sibling of the vault. Current vault: ',
  '（未知）': '(unknown)',
  '库外 MD 目录：': 'External notes folder: ',
  '        → ': '        -> ',
  '库外附件目录：': 'External attachments folder: ',
  '插入的链接前缀：': 'Link prefix: ',
  '库外放 MD 的目录': 'External notes folder',
  '相对 vault 根，例如 ../External Vault；也可写多层，如 ../PBL/notes': 'Relative to the vault root, e.g. ../External Vault; nesting is allowed, e.g. ../PBL/notes',
  '选择…': 'Choose…',
  '库外放附件的目录': 'External attachments folder',
  '相对 vault 根，例如 ../External Vault/attachments': 'Relative to the vault root, e.g. ../External Vault/attachments',
  '「选择…」会把手选的绝对路径自动换算成相对 vault 根的写法；请选一个「里面至少有一个文件」的文件夹，空文件夹请直接手输。两个目录改动后，插入的链接前缀会自动重算。': '"Choose…" converts the selected absolute path into a vault-relative path. Pick a folder that contains at least one file; type empty folder paths manually. Link prefixes are recalculated when either folder changes.',
  '简易模式固定使用与库同级的 External Vault/ 放 MD、External Vault/attachments/ 放附件；插件加载时自动创建，不需要选任何文件夹。': 'Simple mode always uses a sibling "External Vault/" for notes and "External Vault/attachments/" for attachments. They are created automatically when the plugin loads.',
  '接管非图片附件': 'Handle non-image attachments',
  '开启后拖入 PDF、docx、zip 等文件也存进附件目录并插入 [文件名](相对路径)；.md/.txt 等笔记类不接管': 'Also store dropped PDFs, docx, zip, etc. in the attachment folder and insert [name](relative path). Notes such as .md/.txt are not handled.',
  '右键菜单：移出 / 移入 Vault': 'Context menus: move out of / into vault',
  '库内笔记右键 →「移出 Vault」（支持多选）；库外标签页右键 →「移入 Vault」。附件随 MD 一起搬走并重写相对路径，笔记双链、网络图片不动。命令面板的「转入库 / 移出库」旧命令沿用固定默认规则。': 'Right-click an in-vault note to move it out (multi-select supported); right-click an external tab to move it in. Attachments move with the note and relative paths are rewritten. Wiki links and remote images are left untouched.',
  '移出 Vault：MD → ': 'Move out: notes -> ',
  '             附件 → ': '              attachments -> ',
  '移入 Vault：MD → ': 'Move in: notes -> ',
  '库内默认附件夹配置：': 'Vault default attachment folder: ',
  '（未配置，回退 assets）': '(not set, falling back to assets)',
  '\nTExternalFile 类：': '\nTExternalFile class: ',
  '可用': 'available',
  '不可用（走路径兜底）': 'unavailable (path fallback)',
  '显示右键菜单项': 'Show context menu items',
  '关掉后两个右键菜单里都不再出现本插件的条目': 'Hide this plugin from both context menus',
  '移入 Vault：MD 目标文件夹': 'Move in: target note folder',
  '相对 vault 根目录；留空 = 库根目录（默认）': 'Relative to the vault root; empty = vault root (default)',
  '（库根目录）': '(vault root)',
  '移入 Vault：附件放到库内默认附件文件夹': 'Move in: use the vault default attachment folder',
  '读取 设置 → 文件与链接 → 默认附件位置（当前为 ': 'Reads Settings -> Files and links -> Default location for new attachments (currently ',
  '）；关闭则放到目标 MD 目录下的 assets 子目录': '). When off, attachments go to an "assets" subfolder next to the note.',
  '移入 / 移出后剪切源文件（删除原件）': 'Cut source files after moving (delete originals)',
  '默认开 = 真正剪切，源文件从原位置直接删除，不生成额外备份目录；关闭则只复制。想留后路可开启下面的「剪切时移入系统废纸篓」': 'On = true cut: originals are deleted from the original location without extra backup folders. Off = copy only. Enable "Move cut files to system trash" below if you want a safety net.',
  '剪切时移入系统废纸篓': 'Move cut files to system trash',
  '默认开 = 源文件移入系统废纸篓，可找回；关闭则直接从磁盘删除。对右键菜单和命令面板同时生效': 'On = move originals to the system trash so they can be restored. Off = delete from disk. Applies to both context menus and commands.',
  '安全处理：删除源文件前会先确认所有目标文件已写盘；被其他笔记共用的附件只复制、保留原件。注意：移出 Vault 后库内其他笔记指向该笔记的 [[双链]] 会失效，直接删除不可撤销。': 'Safety: source files are deleted only after every target file is verified on disk. Attachments shared with other notes are copied, not deleted. Note: moving a note out of the vault breaks [[wiki links]] pointing to it, and deletion cannot be undone.',
  'Ribbon 按钮：打开 External Vault': 'Ribbon button: open External Vault',
  '左键默认弹出菜单，右键始终弹出完整菜单；目录路径见上方「目录模式」。': 'Left click opens the menu by default; right click always opens the full menu. Folder paths are shown under "Folder mode" above.',
  '显示 Ribbon 按钮': 'Show ribbon button',
  '开关即时生效，不必重载插件': 'Takes effect immediately; no reload needed',
  '左键点击的动作': 'Left-click action',
  '右键不受此项影响，始终弹出完整菜单': 'Right click is unaffected and always opens the full menu',
  '弹出 External Vault 菜单（默认）': 'Open the External Vault menu (default)',
  '直接在文件管理器中打开 External Vault': 'Reveal External Vault in the file manager',
  '直接打开最近编辑的一篇库外 MD': 'Open the most recently edited external note',
  '菜单里最多列几篇库外 MD': 'Maximum external notes in the menu',
  '按修改时间倒序，只列库外 MD 目录当前层的文件': 'Newest first, only files in the top level of the external notes folder',
  '10 篇': '10 notes',
  '20 篇（默认）': '20 notes (default)',
  '50 篇': '50 notes',
  '200 篇': '200 notes',
  '插入与新建': 'Linking & new notes',
  '相对路径写法': 'Relative link style',
  '默认尖括号：文件名含空格或中文时最稳妥，Obsidian / Typora / VS Code 都认': 'Angle brackets by default: safest for names with spaces or non-ASCII characters, understood by Obsidian, Typora and VS Code',
  '尖括号 <...>（推荐）': 'Angle brackets <...> (recommended)',
  '百分号编码（%20 等）': 'Percent-encoding (%20 etc.)',
  '原样（文件名须无空格）': 'Plain (file names must not contain spaces)',
  '拖入时保留原文件名': 'Keep original file names when dropping',
  '关闭后所有图片统一命名为「Pasted image 时间戳」；重名自动加 -1、-2': 'When off, images are named "Pasted image <timestamp>"; duplicates get -1, -2',
  '新建库外 MD 模板': 'Template for new external notes',
  '模板来源': 'Template source',
  '默认套用内置 YAML frontmatter 模板；可换成库内模板文件，或直接写自定义内容': 'Use the built-in YAML frontmatter by default; switch to a vault template file or inline text',
  '模板文件（默认）': 'Template file (default)',
  '自定义内容': 'Inline text',
  '不用模板': 'No template',
  '模板文件路径': 'Template file path',
  '相对 vault 根目录，也可填绝对路径；留空或读不到时用内置默认 YAML。模板里可用 {{title}}、{{filename}}、{{date}}、{{date:YYYY-MM-DD}}、{{time}}': 'Relative to the vault root, or an absolute path. Empty or unreadable falls back to the built-in YAML. Supports {{title}}, {{filename}}, {{date}}, {{date:YYYY-MM-DD}}, {{time}}',
  '（留空使用内置 YAML）': '(empty = built-in YAML)',
  '自定义模板内容': 'Inline template text',
  '新建库外 MD 的正文原样写入这里的内容；支持 {{title}}、{{filename}}、{{date}}、{{date:YYYY-MM-DD}}、{{time}}；留空 = 内置默认 YAML': 'Body text for new external notes. Supports {{title}}, {{filename}}, {{date}}, {{date:YYYY-MM-DD}}, {{time}}. Empty = built-in YAML.',
  '不用模板时写入标题': 'Write a heading when no template is used',
  '仅当「模板来源」选「不用模板」时生效：文件内容自动写一行「# 文件名」；模板模式不会追加标题': 'Only applies when Template source is "No template": adds a "# file name" line. Template modes do not add a heading.',
  '显示成功提示': 'Show success notices',
  '调试日志': 'Debug logging',
  '在开发者控制台打印路径探测、保存位置等信息': 'Print path resolution and save locations to the developer console',
  '故障排查': 'Troubleshooting',
  '插图或右键菜单没生效时，运行命令「诊断：复制当前库外文件信息」，把剪贴板内容发来即可适配。': 'If attachments or context menus do not work, run "Diagnose current external file" and share the copied diagnostics.',
  '语言': 'Language',
  '界面语言；切换后建议重载插件（Cmd+R）以更新命令名': 'Interface language. Reload the plugin (Cmd+R) after switching to update command names.',
  '跟随 Obsidian': 'Follow Obsidian',
  '打开 Finder': 'Open in Finder',
  '搜索文件名、路径或别名…': 'Search name, path or alias…',
  '搜索文件名、路径、别名或拼音首字母…': 'Search name, path, alias or pinyin initials…',
  '搜索': 'Search',
  '最后修改于': 'Modified ',
  '创建于': 'Created ',
  '新建笔记': 'New note',
  '打开库外文件': 'Open external file',
  '移入 OB Vault（含附件）': 'Move to vault (with attachments)',
  '移入 External Vault（含附件）': 'Move to External Vault (with attachments)',
  '文件名 (A-Z)': 'File name (A-Z)',
  '文件名 (Z-A)': 'File name (Z-A)',
  '编辑时间 (从新到旧)': 'Modified (newest first)',
  '编辑时间 (从旧到新)': 'Modified (oldest first)',
  '创建时间 (从新到旧)': 'Created (newest first)',
  '创建时间 (从旧到新)': 'Created (oldest first)',
  '打开面板': 'Open panel',
  '打开附件目录': 'Open attachments folder',
  '复制路径': 'Copy path',
  '新建文件夹': 'New folder',
  '文件夹名称': 'Folder name',
  '排序': 'Sort',
  '折叠 / 展开': 'Collapse / expand',
  '更多': 'More',
  '确定': 'OK',
  '取消': 'Cancel',
  '拿不到库外目录': 'Cannot resolve external folder',
  '别名：': 'Aliases: ',
  '确认删除库外 MD（含附件）': 'Delete external note (with attachments)?',
  '库外文件：打开侧边栏面板': 'External files: Open sidebar panel',
  '打开库外文件面板': 'Open external files panel',
  '刷新': 'Refresh',
  '打开': 'Open',
  '在 Finder 中显示': 'Show in Finder',
  '没有匹配的文件': 'No matching files',
  '还没有库外 Markdown 文件': 'No external Markdown files yet',
  ' 个附件': ' attachments',
  '无附件': 'No attachments',
  '库外文件：清理孤儿附件': 'External files: Clean up orphan attachments',
  '清理孤儿附件': 'Clean up orphan attachments',
  '下面这些文件在附件目录里，但没有被任何库外笔记引用。删除会移入系统废纸篓。': 'These files are in the attachments folder but are not referenced by any external note. Deleting moves them to the system trash.',
  '目录：': 'Folder: ',
  '全选': 'Select all',
  '删除选中（移入废纸篓）': 'Delete selected (move to trash)',
  '关闭': 'Close',
  '没有发现孤儿附件': 'No orphan attachments found',
  '已选': 'Selected',
  '个': 'items',
  '已删除': 'Deleted',
  '个孤儿附件': 'orphan attachments',
  '个删除失败': 'failed to delete',
  '当前外部库': 'Active external vault',
  '右侧面板、新建笔记、移出 Vault 都作用于这个库': 'The sidebar panel, new notes and "Move out of vault" all use this vault.',
  '其他外部库': 'Other external vaults',
  '名称': 'Name',
  '删除': 'Delete',
  'MD 目录': 'Notes folder',
  '附件目录': 'Attachments folder',
  '每个外部库有独立的 MD 和附件目录；在顶部「当前外部库」切换': 'Each external vault has its own notes and attachments folder. Switch with "Active external vault" above.',
  '添加外部库': 'Add external vault',
  '外部库': 'External vault',
  '无法打开：': 'Cannot open: ',
  '库外文件：撤销上一次移动': 'External files: Undo last move',
  '撤销上一次移动': 'Undo last move',
  '没有可撤销的移动记录': 'No move to undo',
  '已撤销上一次移动': 'Last move undone',
  '已撤销上一次删除': 'Last deletion undone',
  '删除目标文件': 'Target files removed',
  '恢复源文件': 'Source files restored',
  '失败': 'Failed',
  '废纸篓中未找到': 'not found in Trash',
  '当时关闭了废纸篓，源文件可能无法恢复': 'The system trash was disabled then; source files may not be recoverable.',
  // 命令
  '库外文件：新建 Markdown': 'External files: New Markdown',
  '库外文件：打开 External Vault 菜单': 'External files: Open External Vault menu',
  '库外文件：打开最近编辑的笔记': 'External files: Open latest note',
  '库外文件：查看全部 / 批量删除': 'External files: Browse / bulk delete',
  '库外文件：插入相对链接（可多选）': 'External files: Insert relative links (multi-select)',
  '库外文件：删除当前库外 MD（含附件）': 'External files: Delete current external note',
  '库外文件：移入 Vault（当前文件，含附件）': 'External files: Move into vault (current file)',
  '库外文件：移出 Vault（当前笔记，含附件）': 'External files: Move out of vault (current note)',
  '库外文件：移入 Vault（整个库外目录，含附件）': 'External files: Move whole external folder into vault',
  '库外文件：移出 Vault（当前笔记所在文件夹，含附件）': 'External files: Move current note folder out of vault',
  '库外文件：移出 Vault（右键动作，含附件）': 'External files: Move out of vault (context action)',
  '库外文件：移入 Vault（右键动作，含附件）': 'External files: Move into vault (context action)',
  '库外文件：在文件管理器中打开 MD 目录': 'External files: Reveal notes folder',
  '库外文件：在文件管理器中打开附件目录': 'External files: Reveal attachments folder',
  '库外文件：复制 External Vault 路径': 'External files: Copy External Vault path',
  '库外文件：复制附件目录路径': 'External files: Copy attachments folder path',
  '库外文件：修复当前笔记的图片链接': 'External files: Fix image links in current note',
  '库外文件：诊断当前库外文件': 'External files: Diagnose current external note',
  // 菜单
  '移出 Vault（含附件）': 'Move out of vault (with attachments)',
  '移入 Vault（含附件）': 'Move into vault (with attachments)',
  '删除库外 MD（含附件）': 'Delete external note (with attachments)',
  ' 篇': ' notes',
};

let UI_LANG = 'zh';

/** 取界面文案；英文模式未收录的条目回退中文 */
function tr(s) {
  return UI_LANG === 'en' ? (EN[s] || s) : s;
}

/** 决定界面语言：auto 时跟随 Obsidian */
function detectLang(settings) {
  const mode = settings && settings.language;
  if (mode === 'en') return 'en';
  if (mode === 'zh') return 'zh';
  try {
    const l = (obsidian.getLanguage && obsidian.getLanguage()) || '';
    return /^zh/i.test(l) ? 'zh' : 'en';
  } catch (e) { return 'zh'; }
}

const DEFAULT_SETTINGS = {
  mode: 'simple',                       // 'simple' 免配置 | 'custom' 自定义两个相对目录
  customMdDir: SIMPLE_MD_REL,           // 库外放 MD 的目录（相对 vault 根）
  customAssetDir: SIMPLE_ASSET_REL,     // 库外放图片/附件的目录（相对 vault 根）
  vaultTargetFolder: '',                // 命令面板「转入库」时 MD 放哪个库内文件夹（空 = 根）
  vaultAssetFolder: 'assets',           // 命令面板「转入库」时附件放在目标 MD 目录下的哪个子目录
  handleOtherAttachments: true,         // 拖入非图片文件（PDF 等）也存进附件目录
  moveSourceAfterTransfer: false,       // 命令面板：转移后删除源文件（默认关 = 只复制）
  transferRecursive: false,             // 批量转移时是否包含子文件夹
  cutUseTrash: true,                    // 剪切时移入系统废纸篓（默认开，误删可恢复）
  // ---- 右键菜单（v1.4） ----
  contextMenuEnabled: true,             // 是否在右键菜单里显示「移出 / 移入 Vault」
  contextMenuVaultMdFolder: '',         // 移入 Vault 时 MD 放哪（相对库根，空 = 库根目录）
  contextMenuUseDefaultAttachmentFolder: true, // 移入 Vault 时附件放库内默认附件文件夹
  contextMenuMoveSource: true,          // 右键菜单转移后删除源文件（真剪切）
  // ---- Ribbon 按钮（v1.4.4） ----
  ribbonEnabled: true,                  // 是否在左侧 ribbon 显示「打开 External Vault」
  ribbonClickAction: 'menu',            // menu | reveal | latest
  ribbonMaxNotes: 20,                   // 菜单里最多列几篇最近编辑的库外 MD
  linkStyle: 'angle',                   // angle | encode | plain
  keepOriginalName: true,               // 拖入文件时保留原名；粘贴截图仍用时间戳命名
  writeTitle: true,                     // 「不用模板」时写入「# 标题」（模板模式不追加）
  // ---- 新建 MD 模板（v1.4.6） ----
  noteTemplateMode: 'text',             // text 内置/自定义内容 | file 模板文件 | none 不用模板
  noteTemplatePath: DEFAULT_NOTE_TEMPLATE_PATH, // 相对 vault 根，也接受绝对路径；留空用内置 YAML
  noteTemplateText: DEFAULT_NOTE_TEMPLATE_TEXT, // 自定义内容，支持 {{title}} / {{date}} 等变量
  language: 'auto',                     // auto | zh | en
  externalVaults: [],                   // 其他外部库：[{ id, name, mdDir, assetDir }]
  activeVaultId: 'default',             // 当前使用的外部库
  showNotice: true,
  debug: false,
  // ---- 仅用于从 v1.2 及更早配置迁移，不再出现在设置面板 ----
  externalFolder: '',
  rootDir: '',
  notesDir: 'notes',
  imageDir: 'images',
  assetFolder: 'assets',
};

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heic',
  'image/tiff': '.tiff',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
};

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|hei[cf]|tiff?)$/i;

function isImageFile(file) {
  if (!file) return false;
  if (file.type && /^image\//i.test(file.type)) return true;
  // 部分文件从 Finder 拖入时 type 为空，用扩展名兜底
  return IMAGE_EXT_RE.test(file.name || '');
}

/** 笔记类文件不接管，避免改变 Obsidian 原本打开/链接 .md 的行为 */
const NOTE_EXT_RE = /\.(md|markdown|canvas|txt|json|css|js|ts|html?|yml|yaml|xml)$/i;
function isAttachmentFile(file) {
  if (isImageFile(file)) return true;
  const name = String((file && (file.name || file.path)) || '');
  if (NOTE_EXT_RE.test(name)) return false;
  // 有些拖拽只给 MIME 不给文件名（或文件名无后缀），按 MIME 兜底
  if (file && file.type && /^(application|audio|video)\//i.test(file.type)) return true;
  if (!name) return false;
  return /\.[A-Za-z0-9]{1,10}$/.test(name); // PDF / docx / zip / mp4 …
}

function guessExt(type, name) {
  if (type && MIME_EXT[type.toLowerCase()]) return MIME_EXT[type.toLowerCase()];
  const m = IMAGE_EXT_RE.exec(name || '');
  if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg').replace('heif', 'heic');
  return '.png';
}

/**
 * 从 drop 事件里尽可能取出图片：
 *   1) dataTransfer.files（Finder 拖文件）
 *   2) dataTransfer.items（部分截图工具只给 items，不给 files）
 *   3) text/uri-list / text/plain 里的 file:// 路径（PixPin 等工具拖图时常见）
 * 返回 File 对象或 {path, name} 形式，两者都能被 saveAndInsert 消费。
 */
function filesFromDataTransfer(dt) {
  const files = [];
  try {
    if (dt.files) {
      for (let i = 0; i < dt.files.length; i += 1) files.push(dt.files[i]);
    }
  } catch (e) { /* noop */ }
  if (!files.length && dt.items) {
    try {
      for (let i = 0; i < dt.items.length; i += 1) {
        const it = dt.items[i];
        if (it && it.kind === 'file') {
          const f = it.getAsFile && it.getAsFile();
          if (f) files.push(f);
        }
      }
    } catch (e) { /* noop */ }
  }
  if (!files.length) {
    for (const type of ['text/uri-list', 'text/plain']) {
      let raw = '';
      try { raw = dt.getData(type) || ''; } catch (e) { continue; }
      for (const line of String(raw).split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#') || /^https?:/i.test(s)) continue;
        // text/plain 只在明确是 file: URL 时才当附件，避免把正文文字误判
        if (type === 'text/plain' && !/^file:/i.test(s)) continue;
        const p = normalizeFsPath(s);
        if (p && isAttachmentFile({ name: path.basename(p), path: p }) && fs.existsSync(p)) {
          files.push({ path: p, name: path.basename(p) });
        }
      }
      if (files.length) break;
    }
  }
  return files;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** 把各种可能的路径写法归一为本地绝对路径；相对路径一律返回 null（= 库内文件） */
function normalizeFsPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.trim();
  s = s.split('#')[0].split('?')[0];
  if (/^file:/i.test(s)) {
    // Obsidian 1.14 把库外文件路径写成 "file:/Users/me/Desktop/a.md"（只有一个斜杠！），
    // 标准写法则是 file:///Users/me/Desktop/a.md。两者都是本机绝对路径，都要还原。
    // 只有 file://host/share 这种 UNC 路径才拒绝。
    let rest = s.replace(/^file:/i, '').replace(/^\/+/, '');
    rest = rest.replace(/^localhost\//i, '');
    const winDrive = /^[A-Za-z]:[\\/]/.test(rest);
    const localAbs = /^(?:Users|home|Volumes|private|Applications|Library|System|var|usr|tmp|opt|etc|mnt|media|srv|root)\//i.test(rest);
    if (!winDrive && !localAbs) return null;
    s = winDrive ? rest : '/' + rest;
  }
  try { s = decodeURIComponent(s); } catch (e) { /* 保留原样 */ }
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  const win = /^[A-Za-z]:[\\/]/.test(s);
  if (!win && /^\/[A-Za-z]:\//.test(s)) s = s.slice(1); // /C:/Users/... → C:/Users/...
  if (!win && !s.startsWith('/')) return null;          // 关键：排除 vault 内相对路径
  s = s.replace(/\\/g, '/');
  return path.normalize(s);
}

function isMdPath(p) {
  return /\.(md|markdown)$/i.test(p);
}

/** 模板日期格式：只认 YYYY / MM / DD / HH / mm / ss，其余字符原样保留 */
function formatTemplateDate(fmt, d) {
  const pad = (n) => String(n).padStart(2, '0');
  return String(fmt || 'YYYY-MM-DD')
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

/** 模板变量替换；无变量的模板（如默认 YAML）原样返回 */
function renderNoteTemplate(raw, title, now) {
  const d = now || new Date();
  return String(raw == null ? '' : raw)
    .replace(/\{\{date:([^}]+)\}\}/g, (_, f) => formatTemplateDate(f, d))
    .replace(/\{\{date\}\}/gi, formatTemplateDate('YYYY-MM-DD', d))
    .replace(/\{\{time\}\}/gi, formatTemplateDate('HH:mm', d))
    .replace(/\{\{filename\}\}/gi, title + '.md')
    .replace(/\{\{title\}\}/gi, title);
}

function vaultRoot(app) {
  try {
    const a = app.vault && app.vault.adapter;
    return a && (a.basePath || (typeof a.getBasePath === 'function' ? a.getBasePath() : null));
  } catch (e) { return null; }
}

function isInsideVault(p, app) {
  const root = vaultRoot(app);
  if (!root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 相对 vault 根目录的字符串 → 绝对路径（允许 ../ 到库外、与库同级） */
function resolveVaultRelative(app, rel) {
  const root = vaultRoot(app);
  if (!root) return null;
  const s = String(rel == null ? '' : rel).trim();
  if (!s || s === '.') return path.resolve(root);
  // 统一分隔符，保留目录名里的空格（如 "External Vault"）
  return path.resolve(root, s.split(/[\\/]+/).join(path.sep));
}

/** 绝对路径 → 相对 vault 根目录（库外结果为 ../xxx，便于迁移与目录选择器） */
function toVaultRelative(app, abs) {
  const root = vaultRoot(app);
  if (!root || !abs) return abs;
  const rel = path.relative(path.resolve(root), path.resolve(abs))
    .split(path.sep).join('/').replace(/\\/g, '/');
  return rel || '.';
}

/**
 * 1.15 起「打开仓库外的文件…」得到的是 TExternalFile（继承自 TFile），
 * 所以不能用 `instanceof TFile` 判断是不是库内文件。多版本兜底：
 *   TExternalFile 类 → getRealPath() → path 以 "file:" 开头。
 */
function isExternalTFile(file) {
  if (!file) return false;
  try {
    const C = obsidian.TExternalFile;
    if (C && file instanceof C) return true;
  } catch (e) { /* noop */ }
  if (typeof file.getRealPath === 'function') return true;
  return /^file:/i.test(String(file.path || ''));
}

function isMdFileObject(file) {
  if (!file) return false;
  if (file.extension === 'md' || file.extension === 'markdown') return true;
  return /\.(md|markdown)$/i.test(String(file.path || ''));
}

/** 库外文件对象 → 本机绝对路径；拿不到或落在库内都返回 null */
function externalAbsFromFile(file, app) {
  if (!file || !isExternalTFile(file)) return null;
  let p = normalizeFsPath(String(file.path || ''));
  if (!p && typeof file.getRealPath === 'function') {
    try {
      let r = String(file.getRealPath() || '');
      if (r && !path.isAbsolute(r) && !/^[A-Za-z]:[\\/]/.test(r)) r = path.sep + r;
      p = normalizeFsPath(r);
    } catch (e) { /* noop */ }
  }
  if (!p || !isMdPath(p) || isInsideVault(p, app)) return null;
  return p;
}

/**
 * 文件列表菜单传来的对象（单选给单个、多选给数组）→ 可移出的库内 MD 目标。
 * 返回 [{file, abs}]；过滤库外 TExternalFile、文件夹 TFolder、非 Markdown 附件、
 * 路径越出 vault 的项，并按绝对路径去重。
 */
function vaultMdTargets(files, app) {
  const vRoot = vaultRoot(app);
  if (!vRoot) return [];
  const list = Array.isArray(files) ? files : (files ? [files] : []);
  const out = [];
  const seen = new Set();
  for (const f of list) {
    if (!f || !isMdFileObject(f) || isExternalTFile(f)) continue;
    // 文件夹没有 md 扩展名，已被 isMdFileObject 挡住；某些版本再显式排除一次
    try { if (obsidian.TFolder && f instanceof obsidian.TFolder) continue; }
    catch (e) { /* noop */ }
    const rel = String(f.path || '');
    if (!rel) continue;
    const abs = path.resolve(vRoot, rel);
    if (!isInsideVault(abs, app) || seen.has(abs)) continue;
    seen.add(abs);
    out.push({ file: f, abs });
  }
  return out;
}

/** 读 Obsidian「设置 → 文件与链接 → 附件文件夹」的原始配置 */
function attachmentFolderSetting(app) {
  let raw = '';
  try {
    if (app.vault && typeof app.vault.getConfig === 'function') {
      raw = app.vault.getConfig('attachmentFolderPath');
    }
  } catch (e) { /* noop */ }
  try {
    if (!raw && app.vault && app.vault.config) raw = app.vault.config.attachmentFolderPath;
  } catch (e) { /* noop */ }
  return String(raw == null ? '' : raw).trim();
}

/**
 * 「默认附件文件夹」→ 绝对路径。
 *   "/"       = 库根目录
 *   "./"      = 与笔记同目录
 *   "./sub"   = 笔记目录下的 sub/
 *   "attachments" = 库根下的 attachments/
 *   没配置时回退到 <noteDir>/<fallbackSub>。
 */
function resolveDefaultAttachmentFolder(app, noteDir, fallbackSub) {
  const vRoot = vaultRoot(app);
  if (!vRoot) throw new Error('拿不到 vault 根目录');
  const raw = attachmentFolderSetting(app);
  if (raw === '/') return { dir: path.resolve(vRoot), raw };
  if (raw.startsWith('./')) return { dir: path.resolve(noteDir, raw.slice(2) || '.'), raw };
  if (raw) return { dir: path.resolve(vRoot, raw.replace(/^\/+/, '')), raw };
  return {
    dir: path.resolve(noteDir, (String(fallbackSub || 'assets').trim() || 'assets')),
    raw: '',
  };
}

/**
 * 判定当前视图是不是库外文件，并解出该 MD 的绝对路径。
 * 1.14 的公开 API 没有暴露外部文件路径，所以这里做多字段探测：
 *   DOM 标记 .mod-external-file / 独立 vault / 显式 flag / view.getState() / file.path 等。
 * 解不出来就返回 null —— 插件不拦截，避免误伤库内笔记。
 */
function resolveExternal(view, app) {
  if (!view) return null;
  // 库外 MD 不在 vault 索引里，1.14 很可能压根没有 view.file，
  // 路径只存在于 view.getState() / leaf 状态中 —— 不能因 f 为空就放弃。
  const f = view.file || {};

  let flagged = false;
  try {
    if (view.containerEl && view.containerEl.querySelector('.mod-external-file')) flagged = true;
  } catch (e) { /* noop */ }
  if (f.vault && app.vault && f.vault !== app.vault) flagged = true;
  if (f.isExternal || f.external || f.isStandalone || f.standalone) flagged = true;

  let state = null;
  try { state = typeof view.getState === 'function' ? view.getState() : null; } catch (e) { /* noop */ }
  if (state && (state.external || state.isExternal || state.outsideVault)) flagged = true;

  const raws = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) raws.push(v); };
  const pushObject = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of ['absolutePath', 'fullPath', 'realPath', 'filePath', 'filepath',
                     'uri', 'url', 'path', 'file', 'name']) {
      try { push(o[k]); } catch (e) { /* noop */ }
    }
  };
  pushObject(f);
  pushObject(view);                 // 某些版本把路径直接挂在 view 上
  pushObject(view.leaf && view.leaf.viewState);
  try {
    pushObject(view.leaf && typeof view.leaf.getViewState === 'function' ? view.leaf.getViewState() : null);
  } catch (e) { /* noop */ }
  pushObject(state);
  pushObject(state && state.state); // workspace.json 里 state 会再嵌一层
  try {
    const el = view.containerEl && view.containerEl.querySelector('[data-path],[data-file-path]');
    if (el) { push(el.getAttribute('data-path')); push(el.getAttribute('data-file-path')); }
  } catch (e) { /* noop */ }

  for (const raw of raws) {
    const p = normalizeFsPath(raw);
    if (p && isMdPath(p) && !isInsideVault(p, app)) {
      return { file: p, dir: path.dirname(p), flagged: true, source: raw };
    }
  }

  // 外部文件可能挂在独立 vault 上，此时 f.path 是相对该 vault 根的路径
  if (flagged) {
    const adapter = f.vault && f.vault.adapter;
    let base = null;
    try {
      base = adapter && (adapter.basePath || (typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : null));
    } catch (e) { /* noop */ }
    if (base && typeof f.path === 'string') {
      const p = path.resolve(base, f.path);
      if (isMdPath(p) && !isInsideVault(p, app)) {
        return { file: p, dir: path.dirname(p), flagged: true, source: 'vault.adapter.basePath + f.path' };
      }
    }
  }
  return null;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, stem + '-' + i + ext);
    i += 1;
  }
  return candidate;
}

/** 库外 MD 目录当前层的 .md，按修改时间倒序；隐藏文件与子目录跳过 */
function listExternalMdFiles(dir, max) {
  if (!dir || !fs.existsSync(dir)) return [];
  const limit = Math.max(1, Number(max) || 20);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { console.warn(LOG, '读取库外 MD 目录失败', dir, e.message); return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    if (!/\.(md|markdown)$/i.test(e.name)) continue;
    const abs = path.join(dir, e.name);
    try { out.push({ abs, name: e.name, mtime: fs.statSync(abs).mtimeMs }); }
    catch (err) { /* 文件刚被移走，跳过 */ }
  }
  out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

function formatLinkTarget(rel, style) {
  if (style === 'plain') return rel;
  if (style === 'encode') {
    return rel.split('/').map((seg) => seg
      .replace(/ /g, '%20')
      .replace(/\(/g, '%28').replace(/\)/g, '%29')
      .replace(/#/g, '%23').replace(/\?/g, '%3F')).join('/');
  }
  // angle：只在必要时加尖括号，中文/空格都能保留可读性
  return /[\s()<>]/.test(rel) ? '<' + rel + '>' : rel;
}

/** 只用于把 v1.2 的绝对路径配置迁移成 v1.3 的相对目录 */
function normalizeRootDir(raw) {
  return normalizeFsPath(raw);
}

/** 从「MD 所在目录」到「附件目录」的相对路径，统一成 / 分隔 */
function relativeFromMd(mdDir, imageDir) {
  const rel = path.relative(mdDir, imageDir);
  return rel.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * 目录选择器：Electron 的 <input webkitdirectory> 拿到的 File.path 是绝对路径。
 * 注意空文件夹取不到 files，所以要求目录里至少有一个文件；也可以直接手输路径。
 */
function pickDirectory(onPicked, defaultPath) {
  // 优先用 Electron 原生目录选择器：可以指定默认位置（当前 vault 根目录）
  try {
    const electron = require('electron');
    const remote = electron && electron.remote;
    const dialog = (electron && electron.dialog) || (remote && remote.dialog);
    if (dialog && typeof dialog.showOpenDialog === 'function') {
      const opts = { properties: ['openDirectory', 'createDirectory'] };
      if (defaultPath) opts.defaultPath = defaultPath;
      const win = (electron.BrowserWindow && electron.BrowserWindow.getFocusedWindow)
        ? electron.BrowserWindow.getFocusedWindow()
        : (remote && remote.BrowserWindow && remote.BrowserWindow.getFocusedWindow
          ? remote.BrowserWindow.getFocusedWindow() : null);
      const p = win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
      Promise.resolve(p).then((res) => {
        if (res && !res.canceled && res.filePaths && res.filePaths[0]) {
          onPicked(String(res.filePaths[0]).replace(/\\/g, '/'));
        }
      }).catch(() => {});
      return;
    }
  } catch (e) { /* 回退到 input 方式 */ }

  let input = null;
  try {
    input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      try {
        const f = input.files && input.files[0];
        if (!f || !f.path) {
          new obsidian.Notice('没取到目录：请选一个含有文件的文件夹，或直接在输入框里手输路径', 7000);
          return;
        }
        const full = String(f.path).replace(/\\/g, '/');
        const rel = String(f.webkitRelativePath || path.basename(full)).replace(/\\/g, '/');
        let dir;
        if (full.endsWith(rel)) {
          const base = full.slice(0, full.length - rel.length);
          dir = path.resolve(base || path.parse(full).root, rel.split('/')[0]);
        } else {
          dir = path.dirname(full);
        }
        onPicked(dir.replace(/\\/g, '/'));
      } finally {
        input.remove();
      }
    }, { once: true });
    input.click();
  } catch (err) {
    if (input) input.remove();
    new obsidian.Notice('无法打开目录选择器：' + err.message + '，请直接手输路径', 7000);
  }
}

/** 批量分配目标文件名：同时避开磁盘已有文件和本批次内重名 */
function allocName(dir, name, used) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (used.has(path.join(dir, candidate).toLowerCase()) || fs.existsSync(path.join(dir, candidate))) {
    candidate = stem + '-' + i + ext;
    i += 1;
  }
  used.add(path.join(dir, candidate).toLowerCase());
  return path.join(dir, candidate);
}

const MD_LINK_RE = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)([^)]*)\)/g;
const WIKI_LINK_RE = /(!?)\[\[([^\]|#]+)([^\]]*)\]\]/g;

/**
 * 扫出 MD 里所有「本地附件」引用，供转移时一起搬运。
 * 支持 ![](path) / [](path) / ![[wiki]]。
 * 不动笔记双链（[[笔记]] / other.md）、网络 URL、file:// 外部链接、不存在的文件。
 */
function collectLocalAssets(text, srcMdPath, app) {
  const dir = path.dirname(srcMdPath);
  const items = [];

  const resolve = (raw, isWiki) => {
    let t = String(raw || '').trim();
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    if (!t || /^(https?:|data:|mailto:|obsidian:|file:|#)/i.test(t)) return null;
    t = t.split('#')[0].split('?')[0].trim();
    if (!t) return null;
    try { t = decodeURIComponent(t); } catch (e) { /* 保留原样 */ }
    if (/\.(md|markdown)$/i.test(t)) return null; // 笔记链接绝不搬走
    let abs = null;
    if (isWiki && app && app.metadataCache) {
      try {
        const f = app.metadataCache.getFirstLinkpathDest(t, srcMdPath);
        const base = f && vaultRoot(app);
        if (f && f.path && base) abs = path.resolve(base, f.path);
      } catch (e) { /* noop */ }
    }
    if (!abs) abs = path.resolve(dir, t);
    // Obsidian 的「最短链接」可能是相对库根写的（笔记在子文件夹时），
    // 相对笔记目录找不到时再按库根找一次；只对库内源文件启用，避免误搬库外同名文件。
    if (app) {
      try {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          const vRoot = vaultRoot(app);
          const alt = vRoot ? path.resolve(vRoot, t) : null;
          if (alt && fs.existsSync(alt) && fs.statSync(alt).isFile()) abs = alt;
        }
      } catch (e) { /* noop */ }
    }
    // wikilink 可能解析到另一篇 .md 笔记；笔记双链绝不搬走
    if (/\.(md|markdown)$/i.test(abs)) return null;
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    } catch (e) { return null; }
    return abs;
  };

  let m;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    const abs = resolve(m[3], false);
    if (!abs) continue;
    items.push({
      kind: 'md', start: m.index, end: m.index + m[0].length,
      prefix: m[1], alt: m[2], tail: m[4] || '', abs,
    });
  }
  WIKI_LINK_RE.lastIndex = 0;
  while ((m = WIKI_LINK_RE.exec(text)) !== null) {
    const abs = resolve(m[2], true);
    if (!abs) continue;
    const alias = /\|([^\]]*)/.exec(m[3] || '');
    items.push({
      kind: 'wiki', start: m.index, end: m.index + m[0].length,
      prefix: m[1], alt: alias ? alias[1] : path.basename(m[2]), tail: '', abs,
    });
  }
  return items.sort((a, b) => a.start - b.start);
}

/**
 * 统计「本地附件引用里找不到源文件」的个数。
 * collectLocalAssets 会静默跳过找不到的文件，转移后这些链接就是裂图；
 * 真剪切（不备份）时必须在摘要里提示，否则用户没有回退余地。
 */
function countMissingAssetRefs(text, srcMdPath, app) {
  const dir = path.dirname(srcMdPath);
  let vRoot = null;
  if (app) { try { vRoot = vaultRoot(app); } catch (e) { /* noop */ } }
  const raws = [];
  let m;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text)) !== null) raws.push(m[3]);
  WIKI_LINK_RE.lastIndex = 0;
  while ((m = WIKI_LINK_RE.exec(text)) !== null) raws.push(m[2]);
  const exists = (p) => {
    try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (e) { return false; }
  };
  let n = 0;
  for (const raw of raws) {
    let t = String(raw || '').trim();
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    if (!t || /^(https?:|data:|mailto:|obsidian:|file:|#)/i.test(t)) continue;
    t = t.split('#')[0].split('?')[0].trim();
    if (!t || /\.(md|markdown)$/i.test(t)) continue;
    if (!/\.[A-Za-z0-9]{1,8}$/.test(t)) continue; // 双链、纯文字链接不算
    try { t = decodeURIComponent(t); } catch (e) { /* noop */ }
    if (exists(path.resolve(dir, t))) continue;
    if (vRoot && exists(path.resolve(vRoot, t))) continue;
    n += 1;
  }
  return n;
}

/** 把收集到的链接统一改写成「相对目标 MD 目录」的 Markdown 链接 */
function rewriteContent(content, items, assetMap, relAssetDir, style) {
  let out = content;
  for (const it of items.slice().sort((a, b) => b.start - a.start)) {
    const dest = assetMap.get(it.abs);
    if (!dest) continue;
    const rel = (relAssetDir ? relAssetDir + '/' : '') + path.basename(dest);
    const target = formatLinkTarget(rel, style);
    const rep = it.kind === 'wiki'
      ? it.prefix + '[' + (it.alt || path.basename(it.abs)) + '](' + target + ')'
      : it.prefix + '[' + it.alt + '](' + target + (it.tail || '') + ')';
    out = out.slice(0, it.start) + rep + out.slice(it.end);
  }
  return out;
}

/** macOS 废纸篓里找同名文件（冲突时会变成「名字 2.md」）；找不到返回 null */
function findTrashItem(srcPath) {
  if (process.platform !== 'darwin') return null;
  const trashDir = path.join(os.homedir(), '.Trash');
  const base = path.basename(srcPath);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let names = [];
  try { names = fs.readdirSync(trashDir); } catch (e) { return null; }
  const exact = path.join(trashDir, base);
  if (fs.existsSync(exact)) return exact;
  for (const name of names) {
    if (!name.startsWith(stem + ' ') || !name.endsWith(ext)) continue;
    const middle = name.slice(stem.length + 1, name.length - ext.length);
    if (!/^\d+$/.test(middle)) continue;
    const p = path.join(trashDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 时间戳 → YYYY-MM-DD HH:mm */
function fmtDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 文件大小的人类可读写法 */
function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / (1024 * 1024)).toFixed(1) + ' MB';
}

let PY_INITIALS = null;

/** 用 GBK 解码构建「汉字 → 拼音首字母」映射（GB2312 一级汉字，3755 字） */
function buildPinyinInitials() {
  if (PY_INITIALS) return PY_INITIALS;
  const ranges = [
    ['A', 0xB0A1, 0xB0C4], ['B', 0xB0C5, 0xB2C0], ['C', 0xB2C1, 0xB4ED],
    ['D', 0xB4EE, 0xB6E9], ['E', 0xB6EA, 0xB7A1], ['F', 0xB7A2, 0xB8C0],
    ['G', 0xB8C1, 0xB9FD], ['H', 0xB9FE, 0xBBF6], ['J', 0xBBF7, 0xBFA5],
    ['K', 0xBFA6, 0xC0AB], ['L', 0xC0AC, 0xC2E7], ['M', 0xC2E8, 0xC4C2],
    ['N', 0xC4C3, 0xC5B5], ['O', 0xC5B6, 0xC5BD], ['P', 0xC5BE, 0xC6D9],
    ['Q', 0xC6DA, 0xC8BA], ['R', 0xC8BB, 0xC8F5], ['S', 0xC8F6, 0xCBF9],
    ['T', 0xCBFA, 0xCDD9], ['W', 0xCDDA, 0xCEF3], ['X', 0xCEF4, 0xD1B8],
    ['Y', 0xD1B9, 0xD4D0], ['Z', 0xD4D1, 0xD7F9],
  ];
  const map = new Map();
  let dec = null;
  try { dec = new TextDecoder('gbk'); } catch (e) { dec = null; }
  if (dec) {
    for (let hi = 0xB0; hi <= 0xD7; hi += 1) {
      for (let lo = 0xA1; lo <= 0xFE; lo += 1) {
        const code = (hi << 8) | lo;
        const r = ranges.find((x) => code >= x[1] && code <= x[2]);
        if (!r) continue;
        try {
          const ch = dec.decode(new Uint8Array([hi, lo]));
          if (ch && ch.length === 1 && /\p{Script=Han}/u.test(ch)) map.set(ch, r[0]);
        } catch (e) { /* noop */ }
      }
    }
  }
  PY_INITIALS = map;
  return map;
}

function pinyinInitials(text) {
  const map = buildPinyinInitials();
  let out = '';
  for (const ch of String(text || '')) {
    if (/\p{Script=Han}/u.test(ch)) out += map.get(ch) || '';
    else if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

/** 统一搜索：文件名、相对路径、别名、拼音首字母 */
function matchesExternalQuery(f, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const name = path.basename(f.abs);
  const alias = (f.aliases || []).join(' ');
  const hay = (f.rel + ' ' + name + ' ' + alias).toLowerCase();
  if (hay.includes(q)) return true;
  if (/^[a-z0-9]+$/.test(q)) {
    return pinyinInitials(f.rel + ' ' + name + ' ' + alias).includes(q);
  }
  return false;
}

/**
 * 搜索库外文件：标题（文件名）、路径、别名、拼音首字母优先；
 * 都没命中时再看正文，正文命中的排在后面。
 */
function searchExternalEntries(files, query, contents) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return files;
  const scored = [];
  for (const f of files) {
    if (matchesExternalQuery(f, q)) { scored.push({ f, rank: 0 }); continue; }
    const c = contents && contents.get(f.abs);
    if (c && c.text && c.text.toLowerCase().includes(q)) {
      scored.push({ f, rank: 1 });
    }
  }
  scored.sort((a, b) => (a.rank - b.rank) || (b.f.mtime - a.f.mtime));
  return scored.map((x) => x.f);
}

/** 从 YAML frontmatter 提取 aliases / alias（支持行内数组与块状列表） */
function parseFrontmatterAliases(text) {
  const fm = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const body = fm[1];
  const out = [];
  const inline = body.match(/^(?:aliases|alias)\s*:\s*(.+)$/mi);
  if (inline) {
    const raw = inline[1].trim();
    if (raw.startsWith('[')) {
      raw.replace(/^\[|\]$/g, '').split(',').forEach((x) => {
        const v = x.trim().replace(/^['"]|['"]$/g, '');
        if (v) out.push(v);
      });
    } else if (raw) {
      out.push(raw.replace(/^['"]|['"]$/g, ''));
    }
  }
  const block = body.match(/^(?:aliases|alias)\s*:\s*\r?\n((?:[ \t]*-[ \t]*.+\r?\n?)+)/mi);
  if (block) {
    block[1].split(/\r?\n/).forEach((line) => {
      const m = line.match(/^[ \t]*-[ \t]*(.+)$/);
      if (m) {
        const v = m[1].trim().replace(/^['"]|['"]$/g, '');
        if (v) out.push(v);
      }
    });
  }
  return Array.from(new Set(out));
}

async function listMarkdownFiles(dir, recursive, maxDepth) {
  const out = [];
  const limit = typeof maxDepth === 'number' ? maxDepth : 5;
  async function walk(d, depth) {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // 跳过隐藏目录
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive && depth < limit) await walk(p, depth + 1); }
      else if (e.isFile() && isMdPath(e.name)) out.push(p);
    }
  }
  await walk(dir, 0);
  return out.sort();
}

/**
 * 真剪切：把源文件从原位置移除，不再生成额外备份目录。
 * cutUseTrash 开启时优先交给系统废纸篓（可找回），失败再退回直接删除。
 * 返回 { removed, trashed, failed }；删不掉的文件留在原处，由调用方在摘要里报出来。
 */
async function cutSourceFiles(paths, useTrash) {
  let shell = null;
  if (useTrash) {
    try {
      const electron = require('electron');
      shell = electron && (electron.shell || (electron.remote && electron.remote.shell));
    } catch (e) { /* 拿不到 electron 就走直接删除 */ }
  }
  const trash = shell && typeof shell.trashItem === 'function'
    ? shell.trashItem.bind(shell) : null;
  const result = { removed: 0, trashed: 0, failed: [] };
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    let trashErr = null;
    if (trash) {
      try { await trash(p); result.trashed += 1; }
      catch (e) { trashErr = e; }
    }
    if (!trash || trashErr) {
      try {
        await fs.promises.unlink(p);
        if (trashErr) console.warn(LOG, '废纸篓不可用，改为直接删除', p, trashErr.message);
      } catch (e2) {
        result.failed.push({ path: p, message: e2.message });
        console.warn(LOG, '移除源文件失败，原件已保留', p, e2.message);
        continue;
      }
    }
    result.removed += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------

class ExternalFileImagePlugin extends obsidian.Plugin {
  async onload() {
    const raw = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    UI_LANG = detectLang(this.settings);
    this.migrateLegacyDirs(raw);
    this.ensureDirs();

    // document 的 capture 阶段一定早于编辑器（CodeMirror）自己的 handler
    const onPaste = (e) => { this.handlePaste(e).catch((err) => this.reportError(err)); };
    const onDrop = (e) => { this.handleDrop(e).catch((err) => this.reportError(err)); };
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('drop', onDrop, true);
    this.register(() => {
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('drop', onDrop, true);
    });

    this.registerContextMenus();
    this.setupRibbon();
    this.addSettingTab(new ExternalFileImageSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new ExternalVaultView(leaf, this));

    // ---- 命令面板：所有功能统一用「库外文件：」前缀，输入这四个字即可看到全部 ----
    this.addCommand({
      id: 'new-external-note',
      name: tr('库外文件：新建 Markdown'),
      callback: () => { Promise.resolve(this.openNewNoteModal()).catch((err) => this.reportError(err)); },
    });
    this.addCommand({
      id: 'open-external-vault',
      name: tr('库外文件：打开 External Vault 菜单'),
      callback: () => { this.showExternalVaultMenu(null); },
    });
    this.addCommand({
      id: 'open-external-panel',
      name: tr('库外文件：打开侧边栏面板'),
      callback: () => this.guard(() => this.activateExternalPanel()),
    });
    this.addCommand({
      id: 'open-latest-external-note',
      name: tr('库外文件：打开最近编辑的笔记'),
      callback: () => this.guard(() => this.openLatestExternalMd()),
    });
    this.addCommand({
      id: 'manage-external-files',
      name: tr('库外文件：查看全部 / 批量删除'),
      callback: () => this.guard(() => this.openExternalFilesModal()),
    });
    this.addCommand({
      id: 'cleanup-orphan-assets',
      name: tr('库外文件：清理孤儿附件'),
      callback: () => this.guard(() => this.openOrphanAssetsModal()),
    });
    this.addCommand({
      id: 'undo-last-move',
      name: tr('库外文件：撤销上一次移动'),
      callback: () => this.guard(() => this.undoLastMove()),
    });
    this.addCommand({
      id: 'insert-external-link',
      name: tr('库外文件：插入相对链接（可多选）'),
      callback: () => this.guard(() => this.insertExternalLink()),
    });
    this.addCommand({
      id: 'delete-external-note',
      name: tr('库外文件：删除当前库外 MD（含附件）'),
      callback: () => this.guard(() => {
        const ctx = this.activeExternalContext();
        if (!ctx || !ctx.file) throw new Error('当前不是「打开仓库外的文件…」打开的库外 MD');
        const abs = ctx.file;
        return this.promptDeleteExternalNote({
          path: 'file:' + abs, extension: 'md', getRealPath: () => abs,
        });
      }),
    });

    this.addCommand({
      id: 'transfer-in-current',
      name: tr('库外文件：移入 Vault（当前文件，含附件）'),
      callback: () => this.guard(() => this.transferCurrent('in')),
    });
    this.addCommand({
      id: 'transfer-out-current',
      name: tr('库外文件：移出 Vault（当前笔记，含附件）'),
      callback: () => this.guard(() => this.transferCurrent('out')),
    });
    this.addCommand({
      id: 'transfer-in-folder',
      name: tr('库外文件：移入 Vault（整个库外目录，含附件）'),
      callback: () => this.guard(() => this.transferFolder('in')),
    });
    this.addCommand({
      id: 'transfer-out-folder',
      name: tr('库外文件：移出 Vault（当前笔记所在文件夹，含附件）'),
      callback: () => this.guard(() => this.transferFolder('out')),
    });
    this.addCommand({
      id: 'context-move-out-current',
      name: tr('库外文件：移出 Vault（右键动作，含附件）'),
      callback: () => this.guard(() => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !isMdFileObject(f)) throw new Error('请先打开一个库内 Markdown 笔记');
        return this.contextMoveOut(f);
      }),
    });
    this.addCommand({
      id: 'context-move-in-current',
      name: tr('库外文件：移入 Vault（右键动作，含附件）'),
      callback: () => this.guard(() => {
        const ctx = this.activeExternalContext();
        if (!ctx || !ctx.file) throw new Error('当前不是「打开仓库外的文件…」打开的库外 MD');
        const abs = ctx.file;
        return this.contextMoveIn({
          path: 'file:' + abs, extension: 'md', getRealPath: () => abs,
        });
      }),
    });

    this.addCommand({
      id: 'reveal-external-vault',
      name: tr('库外文件：在文件管理器中打开 MD 目录'),
      callback: () => this.guard(() => this.revealExternalVault()),
    });
    this.addCommand({
      id: 'reveal-external-assets',
      name: tr('库外文件：在文件管理器中打开附件目录'),
      callback: () => this.guard(() => this.revealExternalAssets()),
    });
    this.addCommand({
      id: 'copy-external-vault-path',
      name: tr('库外文件：复制 External Vault 路径'),
      callback: () => this.guard(async () => {
        const dir = this.externalMdDir();
        await navigator.clipboard.writeText(dir);
        new obsidian.Notice('已复制：' + dir, 4000);
      }),
    });
    this.addCommand({
      id: 'copy-external-assets-path',
      name: tr('库外文件：复制附件目录路径'),
      callback: () => this.guard(async () => {
        const dir = this.externalAssetDir();
        await navigator.clipboard.writeText(dir);
        new obsidian.Notice('已复制：' + dir, 4000);
      }),
    });

    this.addCommand({
      id: 'fix-wiki-image-links',
      name: tr('库外文件：修复当前笔记的图片链接'),
      callback: () => this.guard(() => this.fixWikiImageLinks()),
    });
    this.addCommand({
      id: 'diagnose-external-file',
      name: tr('库外文件：诊断当前库外文件'),
      callback: () => { this.diagnose().catch((err) => this.reportError(err)); },
    });

    this.patchOpenLinkText();
    this.patchFirstLinkpathDest();
    this.setupExternalLinkRendering();
    this.setupExternalTabBadge();
    // 预热外部文件名缓存，让裸 [[文件名]] 的 hover 预览能解析
    window.setTimeout(() => { this.listExternalEntries().catch(() => {}); }, 1200);

    console.log(LOG, 'loaded v1.11.1', 'md=', this.mdRel(), 'assets=', this.assetRel(),
      'TExternalFile=', !!(obsidian.TExternalFile));
  }

  /** v1.2 及更早的绝对路径配置 → v1.3 的相对目录（只迁移一次） */
  migrateLegacyDirs(raw) {
    if (!raw || raw.mode) return;
    const legacyRoot = normalizeRootDir(raw.externalFolder) || normalizeRootDir(raw.rootDir);
    if (!legacyRoot) return;
    const oldMd = normalizeRootDir(raw.externalFolder) ||
      path.resolve(legacyRoot, String(raw.notesDir || 'notes').trim() || '.');
    const oldAsset = String(raw.imageDir || '').trim()
      ? path.resolve(legacyRoot, raw.imageDir.trim())
      : path.resolve(legacyRoot, String(raw.assetFolder || 'assets').trim() || 'assets');
    this.settings.mode = 'custom';
    this.settings.customMdDir = toVaultRelative(this.app, oldMd);
    this.settings.customAssetDir = toVaultRelative(this.app, oldAsset);
    try {
      Promise.resolve(this.saveData(this.settings)).catch((e) => this.dbg('迁移保存失败', e.message));
    } catch (e) { this.dbg('迁移保存失败', e.message); }
    this.dbg('旧目录已迁移 →', this.settings.customMdDir, this.settings.customAssetDir);
  }

  /** 简易模式无需任何设置：加载时就把库同级的 External Vault/attachments 建好 */
  ensureDirs() {
    try {
      for (const d of [this.externalMdDir(), this.externalAssetDir()]) {
        if (d && !fs.existsSync(d)) {
          fs.mkdirSync(d, { recursive: true });
          this.dbg('已创建目录', d);
        }
      }
    } catch (e) { this.dbg('创建默认目录失败', e.message); }
  }

  dbg(...args) {
    if (this.settings.debug) console.log(LOG, ...args);
  }

  reportError(err) {
    console.error(LOG, err);
    new obsidian.Notice('库外图片插件出错：' + (err && err.message ? err.message : String(err)), 6000);
  }

  stop(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  }

  /**
   * 候选视图：活动 MarkdownView → activeLeaf → 所有打开的 leaves。
   * 1.14 的库外文件可能不是 MarkdownView 子类，甚至没有 view.file，
   * 所以不能只信 getActiveViewOfType。
   */
  candidateViews() {
    const out = [];
    const seen = new Set();
    const add = (v) => { if (v && v.editor && !seen.has(v)) { seen.add(v); out.push(v); } };
    try { add(this.app.workspace.getActiveViewOfType(obsidian.MarkdownView)); } catch (e) { /* noop */ }
    try { add(this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.view); } catch (e) { /* noop */ }
    try {
      if (typeof this.app.workspace.iterateAllLeaves === 'function') {
        this.app.workspace.iterateAllLeaves((leaf) => add(leaf && leaf.view));
      }
    } catch (e) { /* noop */ }
    return out;
  }

  /** 当前活动视图若是库外 MD，返回 {view, dir, file}（供命令使用） */
  activeExternalContext() {
    for (const view of this.candidateViews()) {
      const ext = resolveExternal(view, this.app);
      if (ext) return { view, dir: ext.dir, file: ext.file };
    }
    return null;
  }

  /** 返回 {view, dir, file} 或 null；null = 插件完全不插手 */
  contextFor(e) {
    let t = e && e.target;
    // paste 的 target 常是 body；改用焦点元素判断归属
    if (!t || t === document.body || t === document.documentElement) {
      t = document.activeElement || t;
    }
    const loose = !t || t.nodeType !== 1 || t === document.body || t === document.documentElement;
    const views = this.candidateViews();
    // 目标无法确定时只认活动视图，避免后台库外标签页抢走库内笔记的事件
    const list = loose ? views.slice(0, 1) : views;
    let ctx = null;
    for (const view of list) {
      const ext = resolveExternal(view, this.app);
      if (!ext) continue;
      // 多标签页时按事件目标锁定所属视图，避免串台误伤库内笔记
      if (!loose && view.containerEl && !view.containerEl.contains(t)) continue;
      ctx = { view, dir: ext.dir, file: ext.file };
      break;
    }
    if (!ctx) {
      this.dbg('未拦截：事件目标不属于可识别的库外 MD 视图');
      return null;
    }
    if (!loose) {
      const tag = t.tagName;
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && !(t.closest && t.closest('.cm-editor'))) return null;
    }
    return ctx;
  }

  // ---- 目录解析（一律相对 vault 根，不存绝对路径） -------------------------

  /** 所有外部库：默认库（简单/自定义目录）+ 额外配置 */
  externalVaultsList() {
    const base = {
      id: 'default',
      name: 'External Vault',
      mdDir: this.settings.mode === 'custom'
        ? (String(this.settings.customMdDir || '').trim() || SIMPLE_MD_REL)
        : SIMPLE_MD_REL,
      assetDir: this.settings.mode === 'custom'
        ? (String(this.settings.customAssetDir || '').trim() || SIMPLE_ASSET_REL)
        : SIMPLE_ASSET_REL,
    };
    const list = [base];
    for (const v of (this.settings.externalVaults || [])) {
      if (!v || !v.id) continue;
      list.push({
        id: v.id,
        name: String(v.name || '').trim() || v.id,
        mdDir: String(v.mdDir || '').trim() || SIMPLE_MD_REL,
        assetDir: String(v.assetDir || '').trim() || SIMPLE_ASSET_REL,
      });
    }
    return list;
  }

  activeVault() {
    const list = this.externalVaultsList();
    return list.find((v) => v.id === this.settings.activeVaultId) || list[0];
  }

  /** 移出 Vault 时选目标外部库：只有一个直接用，多个弹菜单 */
  pickTargetVault() {
    const list = this.externalVaultsList();
    if (list.length <= 1) return Promise.resolve(list[0] || null);
    if (!obsidian.Menu) return Promise.resolve(list[0]);
    return new Promise((resolve) => {
      const menu = new obsidian.Menu();
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      for (const v of list) {
        menu.addItem((item) => item
          .setTitle(v.name)
          .setIcon('lucide-folder')
          .onClick(() => finish(v)));
      }
      menu.onHide(() => finish(null));
      menu.showAtPosition({
        x: Math.round((window.innerWidth || 1200) / 2),
        y: Math.round((window.innerHeight || 800) / 3),
      });
    });
  }

  /** 切换当前外部库并确保目录存在 */
  async setActiveVault(id) {
    this.settings.activeVaultId = id;
    await this.saveData(this.settings);
    this.ensureDirs();
  }

  mdRel() { return this.activeVault().mdDir; }

  assetRel() { return this.activeVault().assetDir; }

  /** 库外放 MD 的目录（绝对路径） */
  externalMdDir() { return resolveVaultRelative(this.app, this.mdRel()); }
  /** 库外放图片与其他附件的目录（绝对路径） */
  externalAssetDir() { return resolveVaultRelative(this.app, this.assetRel()); }

  // 以下四个保留旧方法名，既有调用点（插图 / 转移 / 诊断 / Modal）无需改动
  workspaceRoot() { return this.externalMdDir(); }
  notesDirFor() { return this.externalMdDir(); }
  externalNotesDir() { return this.externalMdDir(); }
  imageDirFor() { return this.externalAssetDir(); }

  // ---- 新建库外 MD --------------------------------------------------------

  openNewNoteModal() {
    const root = this.externalMdDir();
    if (!root) {
      new obsidian.Notice('拿不到 vault 根目录，无法计算库外目录', 7000);
      return;
    }
    new NewExternalNoteModal(this.app, this, root, this.activeExternalContext()).open();
  }

  /**
   * 新建库外 MD 的正文；返回 null = 不用模板（回退旧的「# 标题」行为）。
   * file：读库内/绝对模板文件，读不到时用内置默认 YAML 兜底，保证不会新建出空文件。
   * text：用设置里自定义的内容（留空同样用内置默认 YAML）。
   */
  async noteTemplateFor(title) {
    const mode = this.settings.noteTemplateMode || 'file';
    if (mode === 'none') return null;
    let raw;
    if (mode === 'text') {
      raw = this.settings.noteTemplateText;
      if (!String(raw || '').trim()) raw = DEFAULT_NOTE_TEMPLATE_TEXT;
    } else {
      const rel = String(this.settings.noteTemplatePath || '').trim();
      if (!rel) {
        raw = DEFAULT_NOTE_TEMPLATE_TEXT;
      } else {
        const abs = path.isAbsolute(rel) ? rel : path.resolve(vaultRoot(this.app) || '.', rel);
        try {
          raw = await fs.promises.readFile(abs, 'utf8');
        } catch (e) {
          this.dbg('模板文件读不到，改用内置默认 YAML', abs, e.message);
          raw = DEFAULT_NOTE_TEMPLATE_TEXT;
          new obsidian.Notice('库外 MD 模板文件读不到：' + abs + '\n已用内置默认 YAML 模板', 7000);
        }
      }
    }
    return renderNoteTemplate(raw, title);
  }

  /** subDir 仅为兼容旧调用保留；新建弹窗不传，固定落在默认库外 MD 目录 */
  async createExternalNote(name, subDir = '.') {
    const root = this.externalMdDir();
    if (!root) throw new Error('拿不到 vault 根目录，无法计算库外目录');

    const dir = path.resolve(root, (subDir || '').trim() || '.');
    await fs.promises.mkdir(dir, { recursive: true });

    let stem = String(name || '').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\.md$/i, '');
    if (!stem) stem = '未命名';
    const dest = uniquePath(dir, stem + '.md');
    const title = path.basename(dest, '.md');
    let content = null;
    try { content = await this.noteTemplateFor(title); }
    catch (e) { this.dbg('模板渲染失败，回退旧行为', e.message); }
    // 模板生效时原样写入模板内容，不再额外追加「# 标题」
    if (content == null) content = this.settings.writeTitle ? '# ' + title + '\n\n' : '';
    await fs.promises.writeFile(dest, content, 'utf8');
    this.dbg('created →', dest);

    // 把完整路径放进剪贴板，打开失败时可直接粘到文件选择器
    try { await navigator.clipboard.writeText(dest); } catch (e) { /* noop */ }
    // 1.14+ 可直接在 Obsidian 内打开库外 MD；老版本退回系统「打开方式」
    let opened = false;
    try { await this.openExternalMd(dest); opened = true; }
    catch (e) { this.dbg('新建后直接打开失败，降级系统打开', e.message); }
    if (!opened) await this.systemOpen(dest);

    new obsidian.Notice(
      '已创建 ' + title + '.md\n位置：' + dir + '\n路径已复制；若未自动打开，请用「打开仓库外的文件…」选择它',
      9000
    );
    return dest;
  }

  async systemOpen(filePath) {
    try {
      const electron = require('electron');
      const shell = electron && (electron.shell || (electron.remote && electron.remote.shell));
      if (shell && typeof shell.openPath === 'function') {
        const err = await shell.openPath(filePath);
        if (err) this.dbg('系统打开失败', err);
        return;
      }
      this.dbg('当前环境没有 shell.openPath，无法用系统方式打开', filePath);
    } catch (err) { this.dbg('系统打开异常', err); }
  }

  // ---- Ribbon：打开 External Vault ----------------------------------------

  /** 左侧 ribbon 图标；左键行为由设置决定，右键始终弹完整菜单 */
  setupRibbon() {
    if (!this.settings.ribbonEnabled) return;
    try {
      const el = this.addRibbonIcon('lucide-folder-open', '打开 External Vault', (evt) => {
        const action = this.settings.ribbonClickAction;
        if (action === 'reveal') this.guard(() => this.revealExternalVault());
        else if (action === 'latest') this.guard(() => this.openLatestExternalMd());
        else this.showExternalVaultMenu(evt);
      });
      if (el && typeof el.addClass === 'function') el.addClass('ev-ribbon-external-vault');
      const onCtx = (evt) => { evt.preventDefault(); this.showExternalVaultMenu(evt); };
      if (el && typeof el.addEventListener === 'function') el.addEventListener('contextmenu', onCtx);
      this.ribbonEl = el;
      this.ribbonCleanup = () => {
        if (el && typeof el.removeEventListener === 'function') el.removeEventListener('contextmenu', onCtx);
        try { if (el && typeof el.detach === 'function') el.detach(); } catch (e) { /* noop */ }
        try {
          const lr = this.app.workspace && this.app.workspace.leftRibbon;
          if (lr && typeof lr.removeRibbonAction === 'function' && this.manifest) {
            lr.removeRibbonAction(this.manifest.id + ':打开 External Vault');
          }
        } catch (e) { /* noop */ }
      };
      this.dbg('ribbon 按钮已添加');
    } catch (e) {
      console.warn(LOG, '添加 ribbon 按钮失败', e.message);
    }
  }

  /** 设置里开关切换后即时增删按钮，并清掉 leftRibbon 里的 action */
  refreshRibbon() {
    try { if (this.ribbonCleanup) this.ribbonCleanup(); } catch (e) { /* noop */ }
    this.ribbonCleanup = null;
    this.ribbonEl = null;
    if (this.settings.ribbonEnabled) this.setupRibbon();
  }

  /** External Vault 快速菜单：目录操作 + 最近编辑的库外笔记 */
  showExternalVaultMenu(evt) {
    if (!obsidian.Menu) { this.guard(() => this.revealExternalVault()); return; }
    try {
      const menu = new obsidian.Menu();
      const mdDir = this.externalMdDir();
      const add = (title, icon, fn, disabled) => {
        menu.addItem((item) => {
          item.setTitle(title);
          if (icon && typeof item.setIcon === 'function') item.setIcon(icon);
          if (disabled && typeof item.setDisabled === 'function') item.setDisabled(true);
          if (fn) item.onClick(() => this.guard(fn));
        });
      };
      add('打开库外文件', 'lucide-file-search', () => this.openExternalFilesModal({ mode: 'open' }));
      add('打开面板', 'lucide-panel-right', () => this.activateExternalPanel());
      add('打开附件目录', 'lucide-folder-open', () => this.revealExternalAssets());
      add('新建笔记', 'lucide-file-plus', () => this.openNewNoteModal());
      add('管理库外文件…', 'lucide-files', () => this.openExternalFilesModal());
      add('清理孤儿附件…', 'lucide-trash-2', () => this.openOrphanAssetsModal());
      add('撤销上一次移动', 'lucide-undo-2', () => this.undoLastMove());
      add('复制路径', 'lucide-copy', async () => {
        await navigator.clipboard.writeText(mdDir);
        if (this.settings.showNotice) new obsidian.Notice('已复制：' + mdDir);
      });
      menu.addSeparator();
      const notes = listExternalMdFiles(mdDir, this.settings.ribbonMaxNotes);
      if (!notes.length) {
        add('（这个文件夹里还没有 .md 文件）', null, null, true);
      } else {
        add('最近编辑的库外笔记', null, null, true);
        for (const n of notes) {
          const label = n.name.length > 32 ? n.name.slice(0, 32) + '…' : n.name;
          add(label, 'lucide-file-text', () => this.openExternalMd(n.abs));
        }
      }
      if (evt && typeof evt.clientX === 'number') {
        menu.showAtMouseEvent(evt);
      } else {
        let pos = { x: 120, y: 120 };
        try {
          const r = this.ribbonEl && this.ribbonEl.getBoundingClientRect();
          if (r) pos = { x: r.right + 6, y: r.top };
        } catch (e) { /* noop */ }
        menu.showAtPosition(pos);
      }
      this.dbg('ribbon 菜单', mdDir, '笔记数', notes.length);
    } catch (e) {
      this.reportError(new Error('打开 External Vault 菜单失败：' + e.message));
    }
  }

  /** 库外文件管理器：默认多选删除；mode='pick' 时单击选中并回调 */
  openExternalFilesModal(opts) {
    new ExternalFilesModal(this.app, this, opts || {}).open();
  }

  /** 读取库外文件列表：MD（含别名/附件数）+ 图片/PDF/其他文件，弹窗与侧边栏共用 */
  async listExternalEntries() {
    const mdDir = this.externalMdDir();
    const assetDir = this.externalAssetDir();
    const files = [];
    const seen = new Set();
    let mdList = [];
    try { mdList = await listMarkdownFiles(mdDir, true, 8); } catch (e) { mdList = []; }
    for (const abs of mdList) {
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { /* noop */ }
      let assets = 0;
      try {
        assets = this.assetPathsIn(abs)
          .filter((a) => !isInsideVault(a, this.app) && fs.existsSync(a)).length;
      } catch (e) { /* noop */ }
      let aliases = [];
      try { aliases = parseFrontmatterAliases(await fs.promises.readFile(abs, 'utf8')); }
      catch (e) { /* noop */ }
      seen.add(path.resolve(abs));
      files.push({
        abs,
        rel: path.relative(mdDir, abs).split(path.sep).join('/'),
        mtime: st ? st.mtimeMs : 0,
        ctime: st ? st.birthtimeMs : 0,
        size: st ? st.size : 0,
        assets,
        aliases,
        kind: 'md',
      });
    }
    const walk = async (dir, base, prefix) => {
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (e) { return; }
      for (const en of entries) {
        if (en.name.startsWith('.')) continue;
        const p = path.join(dir, en.name);
        if (en.isDirectory()) { await walk(p, base, prefix); continue; }
        if (!en.isFile() || isMdPath(en.name)) continue;
        const rp = path.resolve(p);
        if (seen.has(rp)) continue;
        seen.add(rp);
        let st = null;
        try { st = fs.statSync(p); } catch (e) { /* noop */ }
        const ext = path.extname(en.name).slice(1).toLowerCase();
        const kind = ext === 'pdf' ? 'pdf' : (isImageFile({ name: en.name }) ? 'image' : 'file');
        files.push({
          abs: p,
          rel: (prefix || '') + path.relative(base, p).split(path.sep).join('/'),
          mtime: st ? st.mtimeMs : 0,
          ctime: st ? st.birthtimeMs : 0,
          size: st ? st.size : 0,
          assets: 0,
          aliases: [],
          kind,
        });
      }
    };
    const assetInsideMd = mdDir && assetDir &&
      path.resolve(assetDir).startsWith(path.resolve(mdDir) + path.sep);
    if (assetDir && fs.existsSync(assetDir)) {
      await walk(assetDir, assetInsideMd ? mdDir : assetDir, assetInsideMd ? '' : 'attachments/');
    }
    if (mdDir && fs.existsSync(mdDir) &&
      path.resolve(mdDir) !== path.resolve(assetDir || '')) {
      await walk(mdDir, mdDir, '');
    }
    if (!this._externalNameCache) this._externalNameCache = new Map();
    for (const f of files) {
      if (f.kind !== 'md') continue;
      const base = path.basename(f.abs, path.extname(f.abs));
      if (!this._externalNameCache.has(base)) this._externalNameCache.set(base, f.abs);
      // frontmatter aliases 也参与解析（[[BTC]]、[[加密货币]] 等）
      for (const a of (f.aliases || [])) {
        const key = String(a || '').trim();
        if (key && !this._externalNameCache.has(key)) {
          this._externalNameCache.set(key, f.abs);
        }
      }
    }
    return files.sort((a, b) => b.mtime - a.mtime);
  }

  /** 按 mtime 缓存库外 MD 正文，供搜索使用 */
  async ensureExternalContents(entries) {
    if (!this._contentCache) this._contentCache = new Map();
    for (const f of entries || []) {
      if (f.kind !== 'md') continue;
      const cached = this._contentCache.get(f.abs);
      if (cached && cached.mtime === f.mtime) continue;
      try {
        const text = await fs.promises.readFile(f.abs, 'utf8');
        this._contentCache.set(f.abs, { mtime: f.mtime, text });
      } catch (e) { /* noop */ }
    }
    return this._contentCache;
  }

  /** 打开库外的图片 / PDF / 其他文件：优先 Obsidian 视图，失败则用系统默认应用 */
  async openExternalAny(abs) {
    const unix = String(abs).split(path.sep).join('/');
    try {
      const f = this.app.vault.getFileByPath('file:' + unix);
      if (f) {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(f);
        return true;
      }
    } catch (e) { /* noop */ }
    try {
      const { shell } = require('electron');
      if (shell && typeof shell.openPath === 'function') {
        const err = await shell.openPath(abs);
        if (!err) return true;
      }
    } catch (e) { /* noop */ }
    new obsidian.Notice(tr('无法打开：') + abs, 6000);
    return false;
  }

  /** 扫描附件目录里没有被任何库外笔记引用的文件 */
  async findOrphanAssets() {
    const assetDir = this.externalAssetDir();
    const mdDir = this.externalMdDir();
    if (!assetDir || !fs.existsSync(assetDir)) return [];
    const used = new Set();
    let mdFiles = [];
    try { mdFiles = await listMarkdownFiles(mdDir, true, 8); } catch (e) { mdFiles = []; }
    for (const md of mdFiles) {
      try {
        for (const a of this.assetPathsIn(md)) used.add(path.resolve(a));
      } catch (e) { /* noop */ }
    }
    const files = [];
    const walk = async (dir) => {
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (e) { return; }
      for (const en of entries) {
        if (en.name.startsWith('.')) continue;
        const p = path.join(dir, en.name);
        if (en.isDirectory()) await walk(p);
        else if (en.isFile()) {
          if (isMdPath(en.name)) continue; // 附件目录里误放的笔记不当作孤儿附件
          let st = null;
          try { st = fs.statSync(p); } catch (e) { /* noop */ }
          files.push({
            abs: p,
            rel: path.relative(assetDir, p).split(path.sep).join('/'),
            size: st ? st.size : 0,
            mtime: st ? st.mtimeMs : 0,
          });
        }
      }
    };
    await walk(assetDir);
    return files
      .filter((f) => !used.has(path.resolve(f.abs)))
      .sort((a, b) => b.mtime - a.mtime);
  }

  /** 打开孤儿附件清理弹窗 */
  openOrphanAssetsModal() {
    new OrphanAssetsModal(this.app, this).open();
  }

  /** 在当前外部库的 MD 目录下新建文件夹 */
  createExternalFolder() {
    const dir = this.externalMdDir();
    if (!dir) {
      new obsidian.Notice(tr('拿不到库外目录'), 5000);
      return;
    }
    new TextPromptModal(this.app, tr('新建文件夹'), tr('文件夹名称'), async (name) => {
      const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!safe) return;
      await fs.promises.mkdir(path.join(dir, safe), { recursive: true });
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
        if (leaf.view && typeof leaf.view.refresh === 'function') {
          leaf.view.refresh().catch(() => {});
        }
      });
    }).open();
  }

  /** 删除/剪切前的本地备份目录（不依赖系统废纸篓权限） */
  backupDirFor(tag) {
    try {
      const root = vaultRoot(this.app);
      if (!root) return null;
      const dir = path.join(root, '.obsidian', 'plugins', 'external-vault', '.undo',
        String(tag || 'op') + '-' + Date.now());
      fs.mkdirSync(dir, { recursive: true });
      this.cleanupBackups(5);
      return dir;
    } catch (e) { return null; }
  }

  /** 只保留最近 N 次备份，避免 .undo 目录无限增长 */
  cleanupBackups(keep) {
    try {
      const root = vaultRoot(this.app);
      if (!root) return;
      const base = path.join(root, '.obsidian', 'plugins', 'external-vault', '.undo');
      const entries = fs.readdirSync(base, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      const limit = typeof keep === 'number' ? keep : 5;
      for (const name of dirs.slice(0, Math.max(0, dirs.length - limit))) {
        try {
          fs.rmSync(path.join(base, name), { recursive: true, force: true });
        } catch (e) { /* noop */ }
      }
    } catch (e) { /* noop */ }
  }

  backupFile(src, backupDir, index) {
    if (!backupDir) return null;
    try {
      const dest = path.join(backupDir, String(index) + '-' + path.basename(src));
      fs.copyFileSync(src, dest);
      return dest;
    } catch (e) { return null; }
  }

  /** 撤销上一次移入/移出：删除目标文件，再从系统废纸篓把源文件移回原路径 */
  async undoLastMove() {
    const rec = this.settings.lastMove;
    if (!rec || (!(rec.notes && rec.notes.length) && !(rec.assets && rec.assets.length))) {
      throw new Error(tr('没有可撤销的移动记录'));
    }
    const items = [].concat(rec.notes || []).concat(rec.assets || []);
    const res = { removed: 0, restored: 0, failed: [] };
    for (const item of items) {
      if (!item.dest || !fs.existsSync(item.dest)) continue;
      try {
        const r = await cutSourceFiles([item.dest], true);
        res.removed += r.removed;
        if (r.failed.length) res.failed.push(...r.failed);
      } catch (e) {
        res.failed.push({ path: item.dest, message: e.message });
      }
    }
    for (const item of items) {
      if (!item.src) continue;
      if (fs.existsSync(item.src)) { res.restored += 1; continue; }
      // 优先从删除前的本地备份恢复（不依赖废纸篓权限）
      if (item.backup && fs.existsSync(item.backup)) {
        try {
          await fs.promises.mkdir(path.dirname(item.src), { recursive: true });
          await fs.promises.copyFile(item.backup, item.src);
          res.restored += 1;
          continue;
        } catch (e) {
          res.failed.push({ path: item.src, message: e.message });
          continue;
        }
      }
      const found = findTrashItem(item.src);
      if (!found) {
        res.failed.push({ path: item.src, message: tr('废纸篓中未找到') });
        continue;
      }
      try {
        await fs.promises.mkdir(path.dirname(item.src), { recursive: true });
        await fs.promises.rename(found, item.src);
        res.restored += 1;
      } catch (e) {
        res.failed.push({ path: item.src, message: e.message });
      }
    }
    this.settings.lastMove = null;
    await this.saveData(this.settings);
    const lines = [
      rec.kind === 'delete' ? tr('已撤销上一次删除') : tr('已撤销上一次移动'),
      tr('删除目标文件') + '：' + res.removed + ' ' + tr('个'),
      tr('恢复源文件') + '：' + res.restored + ' ' + tr('个'),
    ];
    if (rec.trashed === false) {
      lines.push(tr('当时关闭了废纸篓，源文件可能无法恢复'));
    }
    if (res.failed.length) {
      lines.push(tr('失败') + '：' + res.failed.length + ' ' + tr('个') +
        '（' + res.failed[0].path + '）');
    }
    new obsidian.Notice(lines.join('\n'), 12000);
  }

  /** 在右侧边栏打开常驻的库外文件面板 */
  async activateExternalPanel() {
    const ws = this.app.workspace;
    const leaves = ws.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) { ws.revealLeaf(leaves[0]); return; }
    const leaf = ws.getRightLeaf(false) || ws.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    ws.revealLeaf(leaf);
  }

  /** 在系统文件管理器中定位单个文件 */
  revealExternalFile(abs) {
    try {
      const { shell } = require('electron');
      if (shell && typeof shell.showItemInFolder === 'function') {
        shell.showItemInFolder(abs);
        return;
      }
    } catch (e) { /* noop */ }
    this.revealExternalVault();
  }

  /**
   * 把库内笔记里的链接解析成「库外 MD 的绝对路径」。
   * 支持：../External Vault/x.md（相对当前笔记目录）、file:/绝对路径、绝对路径。
   * 只认库外、存在、扩展名为 md 的目标；其余返回 null，交回 Obsidian 原生逻辑。
   */
  /** 按文件名（不含 .md）在外部库缓存里找绝对路径 */
  findExternalByName(name) {
    const key = String(name || '').replace(/\.md$/i, '').trim();
    if (!key || !this._externalNameCache) return null;
    return this._externalNameCache.get(key) || null;
  }

  /** 同步扫描外部库，按文件名或 frontmatter 别名匹配（缓存未就绪时兜底） */
  resolveExternalByAliasSync(name) {
    const key = String(name || '').replace(/\.md$/i, '').trim();
    const mdDir = this.externalMdDir();
    if (!key || !mdDir || !fs.existsSync(mdDir)) return null;
    const walk = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
      for (const en of entries) {
        if (en.name.startsWith('.')) continue;
        const p = path.join(dir, en.name);
        if (en.isDirectory()) {
          if (depth < 3) { const r = walk(p, depth + 1); if (r) return r; }
          continue;
        }
        if (!en.isFile() || !isMdPath(en.name)) continue;
        if (path.basename(en.name, path.extname(en.name)) === key) return p;
        try {
          const head = fs.readFileSync(p, 'utf8').slice(0, 3000);
          if (parseFrontmatterAliases(head).includes(key)) return p;
        } catch (e) { /* noop */ }
      }
      return null;
    };
    return walk(mdDir, 0);
  }

  externalTargetForLink(linktext, sourcePath) {
    try {
      let raw = String(linktext || '').trim();
      if (!raw) return null;
      if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
      raw = raw.split('#')[0].trim();
      if (!raw) return null;
      try { raw = decodeURIComponent(raw); } catch (e) { /* 保留原样 */ }

      const vRoot = vaultRoot(this.app);
      if (!vRoot) return null;
      const candidates = [];
      if (/^file:/i.test(raw)) {
        const abs = normalizeFsPath(raw);
        if (abs) candidates.push(abs);
      } else if (path.isAbsolute(raw)) {
        candidates.push(raw);
      } else {
        let baseDir = vRoot;
        if (sourcePath && !String(sourcePath).startsWith('file:')) {
          baseDir = path.dirname(path.resolve(vRoot, sourcePath));
        }
        if (/^\.\.?\//.test(raw)) candidates.push(path.resolve(baseDir, raw));
        else {
          candidates.push(path.resolve(vRoot, raw));
          candidates.push(path.resolve(baseDir, raw));
        }
      }
      // 裸 [[文件名]]：库内找不到时，去外部库目录（含子目录缓存）里找
      if (!raw.includes('/') && !/^file:/i.test(raw)) {
        const mdDir = this.externalMdDir();
        if (mdDir) {
          candidates.push(path.join(mdDir, raw));
          candidates.push(path.join(mdDir, raw + '.md'));
        }
        const cached = this.findExternalByName(raw);
        if (cached) candidates.push(cached);
        else {
          const syncHit = this.resolveExternalByAliasSync(raw);
          if (syncHit) candidates.push(syncHit);
        }
      }
      for (const abs of candidates) {
        if (!abs) continue;
        // 库内 Markdown 链接一般带 .md；[[wiki]] 形式可能不带扩展名，补一次
        const tries = isMdPath(abs) ? [abs] : [abs, abs + '.md'];
        for (const p of tries) {
          if (!isMdPath(p)) continue;
          if (isInsideVault(p, this.app)) continue;
          if (!fs.existsSync(p)) continue;
          return p;
        }
      }
      return null;
    } catch (e) {
      this.dbg('解析库外链接失败', e.message);
      return null;
    }
  }

  /** 生成从某篇库内笔记指向库外文件的相对链接（可跨电脑复用） */
  externalLinkFor(targetAbs, fromVaultRel) {
    const vRoot = vaultRoot(this.app);
    if (!vRoot) throw new Error('拿不到 vault 根目录');
    const fromAbs = path.resolve(vRoot, fromVaultRel || '');
    const fromDir = isMdPath(fromAbs) ? path.dirname(fromAbs) : fromAbs;
    let rel = path.relative(fromDir, targetAbs).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    // 逐段编码：空格、#、?、% 会被正确处理，中文保持原样
    return rel.split('/').map((seg) => seg
      .replace(/%/g, '%25').replace(/#/g, '%23')
      .replace(/\?/g, '%3F').replace(/ /g, '%20')).join('/');
  }

  /** 命令：在当前库内笔记光标处插入指向库外 MD 的相对链接 */
  async insertExternalLink() {
    const file = this.app.workspace.getActiveFile();
    if (!file || isExternalTFile(file) || !isMdPath(file.path)) {
      new obsidian.Notice('请先打开一个库内 Markdown 笔记，再插入库外文件链接', 7000);
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    this.openExternalFilesModal({
      mode: 'pick',
      onPick: (absList) => {
        const list = Array.isArray(absList) ? absList : [absList];
        const md = list.map((abs) => {
          const href = this.externalLinkFor(abs, file.path);
          const label = path.basename(abs, path.extname(abs));
          return '[' + label + '](' + href + ')';
        }).join('\n');
        if (view && view.editor && typeof view.editor.replaceSelection === 'function') {
          view.editor.replaceSelection(md);
          new obsidian.Notice('已插入 ' + list.length + ' 个链接', 5000);
        } else {
          navigator.clipboard.writeText(md)
            .then(() => new obsidian.Notice('已复制 ' + list.length + ' 个链接', 5000))
            .catch(() => new obsidian.Notice('链接：' + md, 9000));
        }
      },
    });
  }

  /**
   * Obsidian 的 openLinkText 只在 vault 索引里找目标，找不到会提示或新建空笔记。
   * 这里在调用原方法前，把指向库外 MD 的相对链接接管掉。
   */
  patchOpenLinkText() {
    try {
      const ws = this.app.workspace;
      if (!ws || typeof ws.openLinkText !== 'function' || ws.__evExternalLinkPatched) return;
      const orig = ws.openLinkText.bind(ws);
      this._origOpenLinkText = orig;
      ws.openLinkText = (linktext, sourcePath, newLeaf, openViewState) => {
        const abs = this.externalTargetForLink(linktext, sourcePath);
        if (abs) return this.openExternalMd(abs);
        return orig(linktext, sourcePath, newLeaf, openViewState);
      };
      ws.__evExternalLinkPatched = true;
      this.register(() => {
        try {
          if (!ws.__evExternalLinkPatched) return;
          ws.openLinkText = orig;
          delete ws.__evExternalLinkPatched;
        } catch (e) { /* noop */ }
      });
      this.dbg('openLinkText 已接管库外链接');
    } catch (e) { this.dbg('patch openLinkText 失败', e.message); }
  }

  /**
   * 库外链接的渲染：
   * 1) 保留 internal-link，只附加 ev-external-link 做视觉区分——这样 Obsidian 仍会
   *    发出 hover-link 事件，Hover Editor / 原生预览才能弹出真实内容。
   * 2) 配合 patchFirstLinkpathDest，把库外目标解析成 TExternalFile。
   * 3) 编辑视图用 CodeMirror 装饰器做同样的标记。
   */
  setupExternalLinkRendering() {
    // 1) 阅读视图：保留 internal-link，只加标记
    this.registerMarkdownPostProcessor((el, ctx) => {
      try {
        if (!ctx || !ctx.sourcePath || String(ctx.sourcePath).startsWith('file:')) return;
        const links = el.querySelectorAll('a.internal-link');
        for (const a of links) {
          const href = a.getAttribute('data-href') || a.getAttribute('href');
          if (!href) continue;
          const abs = this.externalTargetForLink(href, ctx.sourcePath);
          if (!abs) continue;
          a.classList.add('ev-external-link');
          a.setAttribute('data-ev-abs', abs);
          a.setAttribute('title', '库外文件：' + abs);
        }
      } catch (e) { this.dbg('标记库外链接失败', e.message); }
    });

    // 2) 阅读视图点击：由插件打开，源文件里仍是相对链接
    this.registerDomEvent(document, 'click', (e) => {
      const t = e.target;
      const a = t && typeof t.closest === 'function' ? t.closest('a.ev-external-link') : null;
      if (!a) return;
      const abs = a.getAttribute('data-ev-abs') ||
        this.externalTargetForLink(a.getAttribute('data-href') || a.getAttribute('href'), this.activeSourcePath());
      if (!abs) return;
      e.preventDefault();
      e.stopPropagation();
      this.guard(() => this.openExternalMd(abs));
    }, true);

    // 3) 编辑视图（Live Preview）：CodeMirror 装饰器给库外链接持久加 class
    try {
      const cmView = require('@codemirror/view');
      const cmState = require('@codemirror/state');
      const self = this;
      const mark = cmView.Decoration.mark({ class: 'ev-external-link' });
      const plugin = cmView.ViewPlugin.fromClass(class {
        constructor(view) { this.decorations = this.build(view); }
        update(update) {
          if (update.docChanged || update.viewportChanged) {
            this.decorations = this.build(update.view);
          }
        }
        build(view) {
          const builder = new cmState.RangeSetBuilder();
          const sourcePath = self.activeSourcePath();
          if (!sourcePath || sourcePath.startsWith('file:')) return builder.finish();
          const re = /\[[^\]]*\]\((<[^>]+>|[^)\s]+)\)/g;
          for (const range of view.visibleRanges) {
            const text = view.state.sliceDoc(range.from, range.to);
            let m;
            while ((m = re.exec(text))) {
              const target = m[1].replace(/^<|>$/g, '');
              if (!self.externalTargetForLink(target, sourcePath)) continue;
              const start = range.from + m.index;
              builder.add(start, start + m[0].length, mark);
            }
          }
          return builder.finish();
        }
      }, { decorations: (v) => v.decorations });
      this.registerEditorExtension(plugin);
    } catch (e) { this.dbg('编辑视图链接装饰器不可用', e.message); }

    // 4) 兜底：装饰器不可用时，悬停补 class；不拦截事件，保证 Hover Editor 能收到 hover
    this.registerDomEvent(document, 'mouseover', (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      const el = t.closest('.internal-link, .cm-hmd-internal-link, .cm-link, [data-href]');
      if (!el) return;
      const inner = el.querySelector && el.querySelector('[data-href]');
      const href = el.getAttribute('data-href') || el.getAttribute('href') ||
        (inner && inner.getAttribute('data-href'));
      if (!href) return;
      const abs = this.externalTargetForLink(href, this.activeSourcePath());
      if (!abs) return;
      el.classList.add('ev-external-link');
    }, true);

    // 5) Live Preview 兜底：定期扫描当前编辑器，给命中库外的链接补 class
    this.registerInterval(window.setInterval(() => {
      try { this.refreshEditorLinkClasses(); } catch (e) { /* noop */ }
    }, 1200));
    this.refreshEditorLinkClasses();
  }

  /**
   * Hover Editor 和原生预览都用 metadataCache.getFirstLinkpathDest 找目标。
   * 库外文件不在索引里，返回 null 就会被当成「未创建」。
   * 这里在找不到时补一个 TExternalFile，让它们走正常预览流程。
   */
  patchFirstLinkpathDest() {
    try {
      const mc = this.app.metadataCache;
      if (!mc || typeof mc.getFirstLinkpathDest !== 'function' || mc.__evExternalResolvePatched) return;
      const orig = mc.getFirstLinkpathDest.bind(mc);
      const cache = new Map();
      mc.getFirstLinkpathDest = (linkpath, sourcePath) => {
        const hit = orig(linkpath, sourcePath);
        if (hit) return hit;
        // 库外笔记里的链接：sourcePath 不在 vault 索引中，原生解析会失败；
        // 再用空 sourcePath 让 Obsidian 按文件名 / 别名全局匹配库内文件
        try {
          const inVault = orig(linkpath, '');
          if (inVault) return inVault;
        } catch (e) { /* noop */ }
        const key = String(sourcePath || '') + '|' + String(linkpath || '');
        const now = Date.now();
        const cached = cache.get(key);
        let abs = null;
        if (cached && now - cached.t < 3000) {
          abs = cached.abs;
        } else {
          abs = this.externalTargetForLink(linkpath, sourcePath);
          if (cache.size > 400) cache.clear();
          cache.set(key, { abs, t: now });
        }
        if (!abs) return hit;
        try {
          const f = this.app.vault.getFileByPath('file:' + abs);
          if (f) return f;
        } catch (e) { /* noop */ }
        return hit;
      };
      mc.__evExternalResolvePatched = true;
      this.register(() => {
        try {
          if (!mc.__evExternalResolvePatched) return;
          mc.getFirstLinkpathDest = orig;
          delete mc.__evExternalResolvePatched;
        } catch (e) { /* noop */ }
      });
      this.dbg('getFirstLinkpathDest 已接管库外链接');
    } catch (e) { this.dbg('patch getFirstLinkpathDest 失败', e.message); }
  }

  /**
   * Live Preview 的链接是 CodeMirror 生成的 span.cm-hmd-internal-link，
   * 没有稳定的 data-href 可供 CSS 选择，只能定期扫描当前编辑器补 class。
   * 链接目标从同一行残留的 data-href 或 .cm-url 文本里取。
   */
  refreshEditorLinkClasses() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view || !view.contentEl) return;
    const sourcePath = this.activeSourcePath();
    if (!sourcePath) return;
    const lines = view.contentEl.querySelectorAll('.cm-line');
    for (const line of lines) {
      const links = line.querySelectorAll('.cm-hmd-internal-link, .cm-link');
      if (!links.length) continue;
      let raw = '';
      const hrefEl = line.querySelector('[data-href]');
      if (hrefEl) raw = hrefEl.getAttribute('data-href') || '';
      if (!raw) {
        const urlEl = line.querySelector('.cm-url');
        if (urlEl) raw = urlEl.textContent || '';
      }
      if (!raw) continue;
      if (!this.externalTargetForLink(raw, sourcePath)) continue;
      for (const el of links) el.classList.add('ev-external-link');
    }
  }

  /** 库外笔记的标签页标题后加「（外）」 */
  setupExternalTabBadge() {
    this.registerInterval(window.setInterval(() => {
      try { this.markExternalTabTitles(); } catch (e) { /* noop */ }
    }, 800));
    this.registerEvent(this.app.workspace.on('file-open', () => {
      try { this.markExternalTabTitles(); } catch (e) { /* noop */ }
    }));
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      try { this.markExternalTabTitles(); } catch (e) { /* noop */ }
    }));
    this.markExternalTabTitles();
  }

  markExternalTabTitles() {
    const ws = this.app.workspace;
    if (!ws || typeof ws.iterateAllLeaves !== 'function') return;
    ws.iterateAllLeaves((leaf) => {
      try {
        const view = leaf && leaf.view;
        if (!view || !view.file) return;
        const headerEl = leaf.tabHeaderEl;
        const titleEl = headerEl && headerEl.querySelector
          ? headerEl.querySelector('.workspace-tab-header-inner-title')
          : null;
        if (!titleEl) return;
        if (isExternalTFile(view.file)) titleEl.classList.add('ev-external-tab');
        else titleEl.classList.remove('ev-external-tab');
      } catch (e) { /* noop */ }
    });
  }

  /** 当前活动笔记的 vault 相对路径，供链接解析使用 */
  activeSourcePath() {
    try {
      const f = this.app.workspace.getActiveFile();
      return f && f.path ? f.path : '';
    } catch (e) { return ''; }
  }

  /**
   * 1.14+ 桌面端：vault.getFileByPath("file:/绝对路径") 会经 externalFileManager
   * 返回 TExternalFile，交给 leaf.openFile 即可在 Obsidian 里直接打开库外 MD，
   * 不需要「打开仓库外的文件…」的文件对话框。
   */
  async openExternalMd(abs) {
    if (!abs || !fs.existsSync(abs)) throw new Error('库外 MD 不存在：' + abs);
    const vault = this.app.vault;
    const unix = String(abs).split(path.sep).join('/');
    let file = null;
    for (const key of ['file:' + unix, 'file://' + unix, unix]) {
      for (const fn of ['getFileByPath', 'getAbstractFileByPath']) {
        if (!vault || typeof vault[fn] !== 'function') continue;
        try {
          const f = vault[fn](key);
          if (f && (f.path || typeof f.getRealPath === 'function')) { file = f; break; }
        } catch (e) { this.dbg(fn, '失败', key, e.message); }
      }
      if (file) break;
    }
    if (!file) {
      try { await navigator.clipboard.writeText(abs); } catch (e) { /* noop */ }
      throw new Error('当前 Obsidian 无法直接打开库外文件（需 1.14+ 且安装程序已更新）。路径已复制，请用「打开仓库外的文件…」选择');
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    this.dbg('已在 Obsidian 中打开库外 MD', abs);
    return file;
  }

  async openLatestExternalMd() {
    const notes = listExternalMdFiles(this.externalMdDir(), 1);
    if (!notes.length) {
      new obsidian.Notice('External Vault 里还没有 .md 文件，可用「新建库外 Markdown 文件」创建一篇', 7000);
      return null;
    }
    return this.openExternalMd(notes[0].abs);
  }

  /** 在系统文件管理器里打开目录（仅用 electron shell） */
  async revealExternalFolder(dir) {
    if (!dir) throw new Error('拿不到库外目录，请检查插件设置');
    await fs.promises.mkdir(dir, { recursive: true });
    let shell = null;
    try {
      const electron = require('electron');
      shell = electron && (electron.shell || (electron.remote && electron.remote.shell));
    } catch (e) { /* 移动端 / 无 electron，走系统命令 */ }
    if (shell && typeof shell.openPath === 'function') {
      try {
        const r = await shell.openPath(dir);
        if (!r) { this.dbg('reveal via shell.openPath', dir); return 'openPath'; }
        this.dbg('shell.openPath 返回', r);
      } catch (e) { this.dbg('shell.openPath 失败', e.message); }
    }
    if (shell && typeof shell.showItemInFolder === 'function') {
      try {
        shell.showItemInFolder(dir);
        this.dbg('reveal via showItemInFolder', dir);
        return 'showItemInFolder';
      } catch (e) { this.dbg('showItemInFolder 失败', e.message); }
    }
    throw new Error('无法在文件管理器中打开目录：' + dir);
  }

  async revealExternalVault() {
    const dir = this.externalMdDir();
    const how = await this.revealExternalFolder(dir);
    if (this.settings.showNotice) new obsidian.Notice('已打开 External Vault：' + dir, 5000);
    return how;
  }

  async revealExternalAssets() {
    const dir = this.externalAssetDir();
    const how = await this.revealExternalFolder(dir);
    if (this.settings.showNotice) new obsidian.Notice('已打开附件目录：' + dir, 5000);
    return how;
  }

  // ---- 粘贴 / 拖入图片 ----------------------------------------------------

  /** 取本次事件里的附件；非图片文件是否接管由 handleOtherAttachments 决定 */
  attachmentsFrom(dt) {
    const all = filesFromDataTransfer(dt);
    return this.settings.handleOtherAttachments
      ? all.filter(isAttachmentFile)
      : all.filter(isImageFile);
  }

  async handlePaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = this.attachmentsFrom(cd);
    if (!files.length) return;
    const ctx = this.contextFor(e);
    if (!ctx) return;

    // 网页「图文一起复制」时不拦截，避免把正文文字丢掉
    let hasHtml = false;
    try { hasHtml = !!(cd.getData && cd.getData('text/html')); } catch (err) { /* noop */ }
    if (hasHtml) { this.dbg('富文本粘贴，放行'); return; }

    this.stop(e);
    this.dbg('paste', files.map((f) => f.name || f.type), '→', this.imageDirFor(ctx));
    await this.saveAndInsert(ctx, files, null);
  }

  async handleDrop(e) {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = this.attachmentsFrom(dt);
    if (!files.length) return;
    const ctx = this.contextFor(e);
    if (!ctx) return;

    this.stop(e);
    const pos = this.dropPosition(ctx.view, e);
    this.dbg('drop', files.map((f) => f.name), '→', this.imageDirFor(ctx), 'pos=', pos);
    await this.saveAndInsert(ctx, files, pos);
  }

  dropPosition(view, e) {
    try {
      const cm = view.editor.cm; // CodeMirror 6 EditorView（非公开 API，取不到就回退）
      if (cm && typeof cm.posAtCoords === 'function') {
        const off = cm.posAtCoords({ x: e.clientX, y: e.clientY });
        if (typeof off === 'number') return view.editor.offsetToPos(off);
      }
    } catch (err) { this.dbg('posAtCoords 不可用', err); }
    return null;
  }

  async saveAndInsert(ctx, files, pos) {
    const targetDir = this.imageDirFor(ctx);
    if (!targetDir) {
      this.reportError(new Error('拿不到 vault 根目录，无法计算附件目录'));
      return;
    }
    // 关键：链接是「从当前 MD 所在目录」到「附件目录」的相对路径
    const relDir = relativeFromMd(ctx.dir, targetDir);
    try {
      await fs.promises.mkdir(targetDir, { recursive: true });
    } catch (err) {
      this.reportError(new Error('无法创建附件目录 ' + targetDir + '：' + err.message));
      return;
    }

    const links = [];
    for (const file of files) {
      try {
        let buf;
        // Electron 里从 Finder 拖入的 File 带 .path，直接复制最快
        if (file.path && fs.existsSync(file.path)) {
          buf = await fs.promises.readFile(file.path);
        } else {
          buf = Buffer.from(await file.arrayBuffer());
        }
        const name = this.makeFileName(file);
        const dest = uniquePath(targetDir, name);
        await fs.promises.writeFile(dest, buf);
        const rel = (relDir ? relDir + '/' : '') + path.basename(dest);
        const target = formatLinkTarget(rel, this.settings.linkStyle);
        if (isImageFile(file)) {
          links.push('![](' + target + ')');
        } else {
          const label = path.basename(dest).replace(/[\[\]]/g, '_');
          links.push('[' + label + '](' + target + ')');
        }
        this.dbg('saved →', dest, 'link →', rel);
      } catch (err) {
        this.reportError(err);
      }
    }
    if (!links.length) return;

    const text = links.join('\n');
    const editor = ctx.view.editor;
    if (pos) editor.replaceRange(text, pos, pos);
    else editor.replaceSelection(text);

    if (this.settings.showNotice) {
      new obsidian.Notice('已保存 ' + links.length + ' 个附件到 ' + targetDir + '，并插入相对路径');
    }
  }

  makeFileName(file) {
    let name = '';
    if (this.settings.keepOriginalName && file.name) {
      name = path.basename(String(file.name).replace(/\\/g, '/'));
    }
    if (!name) {
      name = (isImageFile(file) ? 'Pasted image ' : 'Pasted file ') + stamp() +
        guessExt(file.type, file.name);
    }
    name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    if (!path.extname(name)) name += guessExt(file.type, file.name);
    return name;
  }

  // ---- 补救已被 Obsidian 原生逻辑写坏的 wiki 图片链接 -----------------------

  /** 找图时的候选目录：图片目录 → MD 同目录 → vault 附件夹 → 常用系统目录 */
  wikiImageSearchDirs(ctx) {
    const targetDir = this.imageDirFor(ctx);
    const dirs = [targetDir, ctx.dir,
      path.join(ctx.dir, 'images'), path.join(ctx.dir, 'assets')].filter(Boolean);
    const vRoot = vaultRoot(this.app);
    if (vRoot) {
      let cfg = null;
      try {
        const v = this.app.vault;
        cfg = (v && typeof v.getConfig === 'function')
          ? v.getConfig('attachmentFolderPath')
          : (v && v.config && v.config.attachmentFolderPath) || null;
      } catch (e) { /* noop */ }
      if (cfg) {
        dirs.push(/^\.{1,2}\//.test(cfg) ? path.resolve(ctx.dir, cfg) : path.resolve(vRoot, cfg));
      }
      for (const n of ['attachments', 'Attachments', 'assets', 'images', '附件']) {
        dirs.push(path.join(vRoot, n));
      }
      dirs.push(vRoot);
    }
    dirs.push(path.join(os.homedir(), 'Pictures'), path.join(os.homedir(), 'Downloads'),
      path.join(os.homedir(), 'Desktop'), os.tmpdir());
    return Array.from(new Set(dirs.filter(Boolean)));
  }

  findExistingImage(name, dirs) {
    const isFile = (p) => {
      try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (e) { return false; }
    };
    for (const d of dirs) {
      const p = path.join(d, name);
      if (isFile(p)) return p;
    }
    // 附件夹下再找一层子目录，但不递归整个 vault
    for (const d of dirs) {
      let subs = [];
      try {
        subs = fs.readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name);
      } catch (e) { continue; }
      for (const s of subs) {
        const p = path.join(d, s, name);
        if (isFile(p)) return p;
      }
    }
    return null;
  }

  /**
   * 修复两类坏链，把图复制到附件目录并重写成相对路径：
   *   ![[name.webp]]   ← 1.14 原生 drop 塞进库内附件夹后插入的 wiki 链接
   *   ![](images/x.png) ← 转移时附件已不在原处、链接原样留下的断链（v1.4.1）
   * 已是相对路径且文件存在的链接不动。
   */
  async fixWikiImageLinks() {
    const ctx = this.activeExternalContext();
    if (!ctx) {
      new obsidian.Notice('请先打开要修复的库外 MD 文件', 7000);
      return;
    }
    const editor = ctx.view.editor;
    let text;
    try {
      text = editor && typeof editor.getValue === 'function'
        ? editor.getValue()
        : await fs.promises.readFile(ctx.file, 'utf8');
    } catch (err) {
      text = await fs.promises.readFile(ctx.file, 'utf8');
    }

    const WIKI_IMG = /!\[\[([^\]|\n]+?)(?:#[^\]\n]*)?(?:\|[^\]\n]*)?\]\]/g;
    const names = new Map();
    let m;
    while ((m = WIKI_IMG.exec(text))) {
      const raw = m[1].trim();
      if (!IMAGE_EXT_RE.test(raw)) continue;
      const name = path.basename(raw.replace(/\\/g, '/'));
      if (!names.has(raw)) names.set(raw, name);
    }
    if (!names.size && !/!\[[^\]]*\]\(/.test(text)) {
      new obsidian.Notice('没有找到需要修复的图片链接（wiki 或 Markdown 断链）');
      return;
    }

    const targetDir = this.imageDirFor(ctx);
    const relDir = relativeFromMd(ctx.dir, targetDir);
    const prefix = relDir ? relDir + '/' : '';
    const dirs = this.wikiImageSearchDirs(ctx);
    let fixed = 0;
    const missing = [];

    for (const [raw, name] of names) {
      const already = path.join(targetDir, name);
      let src = null;
      try { if (fs.existsSync(already) && fs.statSync(already).isFile()) src = already; } catch (e) { /* noop */ }
      if (!src) src = this.findExistingImage(name, dirs);
      if (!src) { missing.push(name); continue; }

      try {
        await fs.promises.mkdir(targetDir, { recursive: true });
        if (src !== already) await fs.promises.copyFile(src, already);
      } catch (err) {
        this.reportError(new Error('复制图片失败 ' + name + '：' + err.message));
        continue;
      }

      const link = '![](' + formatLinkTarget(prefix + name, this.settings.linkStyle) + ')';
      const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('!\\[\\[' + esc + '(?:#[^\\]\\n]*)?(?:\\|[^\\]\\n]*)?\\]\\]', 'g');
      const before = text;
      text = text.replace(re, link);
      if (text !== before) fixed += 1;
      this.dbg('fix wiki', name, '←', src, '→', link);
    }

    // v1.4.1：Markdown 形式的断链（如 ![](images/x.png)，源文件已不在原处）
    const broken = [];
    const MD_IMG = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)([^)]*)\)/g;
    let bm;
    while ((bm = MD_IMG.exec(text)) !== null) {
      let t = String(bm[2] || '').trim();
      if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
      if (/^(https?:|data:|mailto:|obsidian:|file:|#)/i.test(t)) continue;
      const clean = t.split('#')[0].split('?')[0].trim();
      if (!IMAGE_EXT_RE.test(clean)) continue;
      let abs;
      try { abs = path.resolve(ctx.dir, decodeURIComponent(clean)); }
      catch (e) { abs = path.resolve(ctx.dir, clean); }
      try { if (fs.existsSync(abs) && fs.statSync(abs).isFile()) continue; } catch (e) { /* noop */ }
      broken.push({
        start: bm.index, end: bm.index + bm[0].length,
        alt: bm[1] || '', tail: bm[3] || '',
        name: path.basename(clean.replace(/\\/g, '/')),
      });
    }
    for (const b of broken) {
      const already = path.join(targetDir, b.name);
      let src = null;
      try { if (fs.existsSync(already) && fs.statSync(already).isFile()) src = already; } catch (e) { /* noop */ }
      if (!src) src = this.findExistingImage(b.name, dirs);
      if (!src) { if (!missing.includes(b.name)) missing.push(b.name); continue; }
      try {
        await fs.promises.mkdir(targetDir, { recursive: true });
        if (src !== already) await fs.promises.copyFile(src, already);
      } catch (err) {
        this.reportError(new Error('复制图片失败 ' + b.name + '：' + err.message));
        continue;
      }
      b.link = '![' + b.alt + '](' +
        formatLinkTarget(prefix + b.name, this.settings.linkStyle) + b.tail + ')';
      fixed += 1;
      this.dbg('fix md', b.name, '←', src, '→', b.link);
    }
    for (const b of broken.slice().sort((a, z) => z.start - a.start)) {
      if (!b.link) continue;
      text = text.slice(0, b.start) + b.link + text.slice(b.end);
    }

    if (!fixed) {
      new obsidian.Notice('没有可修复的链接，或没能在常见目录找到这些图片：' +
        (missing.join('、') || '（无）'), 9000);
      return;
    }
    const cursor = (() => { try { return editor && editor.getCursor ? editor.getCursor() : null; } catch (e) { return null; } })();
    try {
      if (editor && typeof editor.setValue === 'function') editor.setValue(text);
      if (cursor && typeof editor.setCursor === 'function') editor.setCursor(cursor);
    } catch (e) { this.dbg('同步编辑器失败（文件已写盘）', e); }
    await fs.promises.writeFile(ctx.file, text, 'utf8');

    new obsidian.Notice(
      '已修复 ' + fixed + ' 处图片链接 → ' + (prefix || './') + '…' +
      (missing.length ? '\n未找到：' + missing.join('、') : ''), 9000
    );
  }

  guard(fn) {
    Promise.resolve().then(fn).catch((err) => this.reportError(err));
  }

  // ---- 一键转移 -----------------------------------------------------------

  vaultPaths(direction) {
    const vRoot = vaultRoot(this.app);
    if (!vRoot) throw new Error('拿不到 vault 根目录');
    const mdDestDir = direction === 'in'
      ? path.resolve(vRoot, (this.settings.vaultTargetFolder || '').trim() || '.')
      : this.externalNotesDir();
    if (!mdDestDir) throw new Error('无法计算库外 MD 目录');
    let assetDestDir;
    if (direction === 'in') {
      const sub = (this.settings.vaultAssetFolder || 'assets').trim().split(/[\\/]+/).filter(Boolean).join('/') || 'assets';
      assetDestDir = path.resolve(mdDestDir, sub);
    } else {
      assetDestDir = this.imageDirFor({ dir: mdDestDir });
    }
    return { vRoot, mdDestDir, assetDestDir, relAssetDir: relativeFromMd(mdDestDir, assetDestDir) };
  }

  transferCurrent(direction) {
    if (direction === 'in') {
      const ctx = this.activeExternalContext();
      if (!ctx) {
        new obsidian.Notice('当前不是「打开仓库外的文件…」打开的库外 MD', 6000);
        return null;
      }
      return this.executeTransfer([ctx.file], 'in');
    }
    if (this.activeExternalContext()) {
      new obsidian.Notice('当前已经是库外文件，无需「移出库」；可用「转入库」', 6000);
      return null;
    }
    const file = this.app.workspace.getActiveFile();
    const vRoot = vaultRoot(this.app);
    if (!file || !vRoot || !isMdPath(file.path)) {
      new obsidian.Notice('请先打开一个库内 Markdown 笔记', 6000);
      return null;
    }
    return this.executeTransfer([path.resolve(vRoot, file.path)], 'out');
  }

  async transferFolder(direction) {
    let dir;
    if (direction === 'in') {
      dir = this.externalNotesDir();
      if (!dir || !fs.existsSync(dir)) {
        new obsidian.Notice('库外 MD 目录不存在：' + dir + '\n重载插件会自动创建', 7000);
        return;
      }
    } else {
      if (this.activeExternalContext()) {
        new obsidian.Notice('当前是库外文件；批量转移请用「转入库：库外 MD 目录全部 MD」', 7000);
        return;
      }
      const file = this.app.workspace.getActiveFile();
      const vRoot = vaultRoot(this.app);
      if (!file || !vRoot) {
        new obsidian.Notice('请先打开一个库内笔记，用来确定要移出的文件夹', 7000);
        return;
      }
      dir = path.dirname(path.resolve(vRoot, file.path));
    }
    const files = await listMarkdownFiles(dir, this.settings.transferRecursive);
    if (!files.length) {
      new obsidian.Notice('没有找到可转移的 .md 文件：' + dir, 6000);
      return;
    }
    new TransferConfirmModal(this.app, this, direction, files, dir).open();
  }

  /**
   * 打开刚写进 vault 的笔记。
   *
   * 不能用 workspace.openLinkText：库内目标文件是插件用 fs 直接写盘的，
   * Obsidian 的 metadataCache 要等文件监视器异步纳管才认识它。此时
   * openLinkText 内部 getFirstLinkpathDest() 返回 null，会被当成「点了不存在的
   * 双链」去 fileManager.createNewFile()，撞上磁盘上已存在的文件 →
   * vault.create() 抛 "File already exists."，被 openLinkText 自己 catch 成黑色提示。
   * 所以这里先等索引就绪，拿到 TFile 后走 leaf.openFile()，完全不碰创建逻辑。
   */
  async openImportedNote(rel, targetLeaf) {
    const ws = this.app.workspace;
    const vault = this.app.vault;
    const mc = this.app.metadataCache;
    const find = () => {
      try {
        if (vault && typeof vault.getFileByPath === 'function') {
          const f = vault.getFileByPath(rel);
          if (f && f.path && !f.children) return f;
        }
        if (vault && typeof vault.getAbstractFileByPath === 'function') {
          const f = vault.getAbstractFileByPath(rel);
          if (f && f.path && !f.children) return f;
        }
        if (mc && typeof mc.getFirstLinkpathDest === 'function') {
          const f = mc.getFirstLinkpathDest(rel, '');
          if (f && f.path) return f;
        }
      } catch (e) { /* noop */ }
      return null;
    };
    for (let i = 0; i < 25; i += 1) {
      const f = find();
      if (f) {
        try {
          const leaf = targetLeaf || (typeof ws.getLeaf === 'function' ? ws.getLeaf(false) : null);
          if (leaf && typeof leaf.openFile === 'function') {
            await leaf.openFile(f);
            return true;
          }
        } catch (e) { this.dbg('打开新笔记失败', e && e.message); }
        return false;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    this.dbg('新笔记未被索引，跳过自动打开：', rel);
    return false;
  }

  /**
   * 通用转移：MD 连同它引用的本地附件一起搬，链接按目标位置重写。
   * 三阶段：统一扫描分配目标名（共享附件只搬一次）→ 统一写盘 → 最后才动源文件。
   */
  async executeTransfer(mdPaths, direction, opts) {
    const options = opts || {};
    // 右键菜单会传入自己的目标目录；命令面板走默认 vaultPaths()
    const { vRoot, mdDestDir, assetDestDir, relAssetDir } = options.paths || this.vaultPaths(direction);

    const plans = [];
    const assetMap = new Map(); // 源附件绝对路径 → 目标绝对路径
    const usedMd = new Set();
    const usedAsset = new Set();
    let missingRefs = 0;
    for (const src of mdPaths) {
      let content;
      try { content = await fs.promises.readFile(src, 'utf8'); }
      catch (e) { console.warn(LOG, '读取失败', src, e.message); continue; }
      // 找不到源文件的附件引用会保持原样 → 转移后是裂图，真剪切前先记下来提示用户
      missingRefs += countMissingAssetRefs(content, src, direction === 'out' ? this.app : null);
      // 只有源在库内时才用 metadataCache 解析 wikilink，避免误把库内同名文件搬走
      const items = collectLocalAssets(content, src, direction === 'out' ? this.app : null);
      for (const it of items) {
        if (!assetMap.has(it.abs)) {
          assetMap.set(it.abs, allocName(assetDestDir, path.basename(it.abs), usedAsset));
        }
      }
      plans.push({ src, dest: allocName(mdDestDir, path.basename(src), usedMd), content, items });
    }
    if (!plans.length) throw new Error('没有可读取的 Markdown 文件');

    await fs.promises.mkdir(mdDestDir, { recursive: true });
    await fs.promises.mkdir(assetDestDir, { recursive: true });
    for (const [srcAbs, destAbs] of assetMap) {
      await fs.promises.copyFile(srcAbs, destAbs);
      this.dbg('asset', srcAbs, '→', destAbs);
    }
    for (const p of plans) {
      const text = rewriteContent(p.content, p.items, assetMap, relAssetDir, this.settings.linkStyle);
      await fs.promises.writeFile(p.dest, text, 'utf8');
      this.dbg('note', p.src, '→', p.dest);
    }

    const doMove = typeof options.moveSource === 'boolean'
      ? options.moveSource : this.settings.moveSourceAfterTransfer;
    let cut = { removed: 0, trashed: 0, failed: [] };
    let skipped = '';
    let openedInPlace = false;
    if (doMove) {
      const destFiles = new Set(plans.map((p) => p.dest).concat(Array.from(assetMap.values())));
      // 删源前的最后一道闸：目标文件必须全部确实写盘，否则保留源文件
      const missing = Array.from(destFiles).filter((p) => !fs.existsSync(p));
      if (missing.length) {
        skipped = '目标文件未写全，已保留源文件（未剪切）：' + missing[0];
        console.warn(LOG, skipped);
      } else {
        // 源 MD 即将被移走：先关掉指向它的标签页，避免留下裂图/已删除标签页
        if (typeof options.beforeRemove === 'function') {
          try { openedInPlace = !!(await options.beforeRemove(plans)); }
          catch (e) { this.dbg('转移前切换标签页失败', e.message); }
        }
        // 被其他笔记共用的附件只复制、保留原件，避免弄断别人的链接
        const keep = options.keepAssetSources instanceof Set ? options.keepAssetSources : new Set();
        const srcFiles = Array.from(new Set(plans.map((p) => p.src)
          .concat(Array.from(assetMap.keys()).filter((a) => !keep.has(a)))))
          .filter((s) => !destFiles.has(s)); // 源与目标同路径时绝不删
        cut = await cutSourceFiles(srcFiles, !!this.settings.cutUseTrash);
      }
    }

    let opened = openedInPlace;
    if (direction === 'in') {
      if (!openedInPlace) {
        const rel = path.relative(vRoot, plans[0].dest).split(path.sep).join('/');
        opened = await this.openImportedNote(rel);
      }
    } else {
      // 多选移出时复制目标目录（比只复制第一篇笔记的路径更有用）
      try {
        await navigator.clipboard.writeText(plans.length > 1 ? mdDestDir : plans[0].dest);
      } catch (e) { /* noop */ }
    }

    let moveLine;
    if (!doMove) moveLine = '\n源文件已保留（只复制）';
    else if (skipped) moveLine = '\n注意：' + skipped;
    else moveLine = '\n源文件已剪切：移除 ' + cut.removed + ' 个' +
      (cut.trashed ? '（其中 ' + cut.trashed + ' 个进废纸篓）' : '') +
      (cut.failed.length ? '\n注意：' + cut.failed.length + ' 个源文件未能删除，仍留在原处（详见控制台）' : '');
    const refLine = missingRefs
      ? '\n注意：' + missingRefs + ' 个附件引用找不到源文件，未搬运、链接保持原样（可用「修复：当前库外 MD 里的图片链接」补救）'
      : '';
    const openLine = (direction === 'in' && !opened)
      ? '\n新笔记已写入，但索引未就绪，未能自动打开；可在文件列表里手动打开'
      : '';
    const summary = '已' + (direction === 'in' ? '转入库' : '移出库') + ' ' + plans.length +
      ' 篇笔记 + ' + assetMap.size + ' 个附件\n目标：' + mdDestDir +
      '\n附件：' + assetDestDir +
      (options.note ? '\n' + options.note : '') + refLine + moveLine + openLine;
    new obsidian.Notice(summary, 10000);
    console.log(LOG, summary);
    if (missingRefs) console.warn(LOG, missingRefs + ' 个附件引用找不到源文件，链接未重写');
    if (doMove && cut.removed > 0) {
      this.settings.lastMove = {
        ts: Date.now(),
        direction,
        trashed: !!this.settings.cutUseTrash,
        notes: plans.map((p) => ({ src: p.src, dest: p.dest })),
        assets: Array.from(assetMap.entries()).map(([src, dest]) => ({ src, dest })),
      };
      try { await this.saveData(this.settings); } catch (e) { /* noop */ }
    }
    return {
      notes: plans.length, assets: assetMap.size, missingRefs,
      removed: cut.removed, trashed: cut.trashed, failed: cut.failed, skipped, opened,
    };
  }

  // ---- 右键菜单：移出 / 移入 Vault（v1.4） --------------------------------

  /**
   * 三个事件都挂：
   *   file-menu  → 单选：文件列表右键（file-explorer-context-menu）拿库内 TFile；
   *                      标签页右键（tab-header / more-options）拿 TExternalFile。
   *   files-menu → 多选：1.15 文件列表选中多个对象时触发，第二个参数是文件数组，
   *                      且此时不再触发 file-menu。
   *   leaf-menu  → 标签页右键兜底（某些版本可能不触发 file-menu）。
   * 同一个 Menu 对象用 WeakSet 去重；若两个事件都触发，后到的多选数组
   * 通过 __evUpdateMoveOut 把已添加条目的目标升级为数量更多的一组。
   */
  registerContextMenus() {
    const outMenus = new WeakSet();
    const inMenus = new WeakSet();
    const delMenus = new WeakSet();
    const externalSources = ['tab-header', 'more-options', 'sidebar-context-menu'];
    const canAdd = (menu, seen) => {
      if (!this.settings.contextMenuEnabled) return false;
      if (!menu || typeof menu.addItem !== 'function' || seen.has(menu)) return false;
      seen.add(menu);
      return true;
    };
    const outTitle = (n) => tr('移出 Vault（含附件）') + (n > 1 ? ' · ' + n + tr(' 篇') : '');
    /** rawFiles 可为单个 TFile（file-menu）或数组（files-menu） */
    const addMoveOut = (menu, rawFiles) => {
      if (!this.settings.contextMenuEnabled || !menu || typeof menu.addItem !== 'function') return;
      const targets = vaultMdTargets(rawFiles, this.app);
      if (!targets.length) return;
      if (outMenus.has(menu)) {
        if (typeof menu.__evUpdateMoveOut === 'function') menu.__evUpdateMoveOut(targets);
        return;
      }
      outMenus.add(menu);
      let chosen = targets;
      let itemRef = null;
      // 先挂上更新器：某些版本 addItem 的回调可能是延迟执行的，
      // 这样 files-menu 后到时也能把目标升级成多选，且条目渲染时读到最新 chosen
      try {
        menu.__evUpdateMoveOut = (next) => {
          if (!next || next.length <= chosen.length) return;
          chosen = next;
          if (itemRef && typeof itemRef.setTitle === 'function') {
            try { itemRef.setTitle(outTitle(chosen.length)); }
            catch (e) { this.dbg('更新多选菜单标题失败', e.message); }
          }
        };
      } catch (e) { this.dbg('挂载多选菜单更新器失败', e.message); }
      try {
        menu.addItem((item) => {
          itemRef = item;
          item
            .setSection('action')
            .setTitle(outTitle(chosen.length))
            .setIcon('lucide-log-out')
            .onClick(() => this.guard(() => this.contextMoveOut(chosen.map((t) => t.file))));
        });
      } catch (e) { this.dbg('添加「移出 Vault」菜单项失败', e.message); }
    };
    const addMoveIn = (menu, file) => {
      if (!canAdd(menu, inMenus)) return;
      try {
        menu.addItem((item) => item
          .setSection('action')
          .setTitle(tr('移入 Vault（含附件）'))
          .setIcon('lucide-log-in')
          .onClick(() => this.guard(() => this.contextMoveIn(file))));
      } catch (e) { this.dbg('添加「移入 Vault」菜单项失败', e.message); }
    };
    const addDelete = (menu, file) => {
      if (!canAdd(menu, delMenus)) return;
      try {
        menu.addItem((item) => item
          .setSection('action')
          .setTitle(tr('删除库外 MD（含附件）'))
          .setIcon('lucide-trash-2')
          .onClick(() => this.guard(() => this.promptDeleteExternalNote(file))));
      } catch (e) { this.dbg('添加「删除库外 MD」菜单项失败', e.message); }
    };

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file, source) => {
      try {
        if (!file || !isMdFileObject(file)) return;
        const external = isExternalTFile(file);
        // 第一张图：文件列表右键 → 移出 Vault
        if (!external && source === 'file-explorer-context-menu') addMoveOut(menu, file);
        // 第二张图：库外文件的标签页 / 更多选项右键 → 移入 Vault
        if (external && externalSources.indexOf(source) !== -1) {
          const abs = externalAbsFromFile(file, this.app);
          if (abs && this.isInsideExternalVault(abs)) {
            addMoveIn(menu, file);
            addDelete(menu, file);
          } else if (abs) {
            // 任意位置的 MD（既不在库内，也不在 External Vault）：
            // 两个方向都提供，附件一起搬
            menu.addItem((i) => i.setTitle('移入 OB Vault（含附件）').setIcon('lucide-log-in')
              .onClick(() => this.guard(() => this.contextMoveIn(file))));
            menu.addItem((i) => i.setTitle('移入 External Vault（含附件）').setIcon('lucide-folder-input')
              .onClick(() => this.guard(() => this.moveAnyToExternal(abs))));
            addDelete(menu, file);
          }
        }
      } catch (e) { this.dbg('file-menu 处理失败', e.message); }
    }));

    this.registerEvent(this.app.workspace.on('files-menu', (menu, files) => {
      try {
        // 多选时 1.15 只发这个事件；数组里可能混有文件夹 / 图片 / .canvas，统一过滤
        addMoveOut(menu, files);
      } catch (e) { this.dbg('files-menu 处理失败', e.message); }
    }));

    this.registerEvent(this.app.workspace.on('leaf-menu', (menu, leaf) => {
      try {
        const file = leaf && leaf.view && leaf.view.file;
        if (!file || !isMdFileObject(file)) return;
        if (isExternalTFile(file)) {
          addMoveIn(menu, file);
          addDelete(menu, file);
        } else {
          // 库内笔记的标签页右键：与文件列表一样提供「移出 Vault」
          addMoveOut(menu, file);
        }
      } catch (e) { this.dbg('leaf-menu 处理失败', e.message); }
    }));

    // 编辑器右键：库内笔记直接插入库外文件链接（可多选）
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      try {
        const file = view && view.file;
        if (!file || isExternalTFile(file) || !isMdPath(file.path)) return;
        if (!menu || typeof menu.addItem !== 'function') return;
        menu.addItem((item) => item
          .setSection('action')
          .setTitle('插入库外文件链接')
          .setIcon('lucide-link')
          .onClick(() => this.guard(() => this.insertExternalLink())));
      } catch (e) { this.dbg('editor-menu 处理失败', e.message); }
    }));
  }

  /** 读一篇 MD 里实际能找到的本地附件绝对路径 */
  assetPathsIn(mdAbs) {
    try {
      const text = fs.readFileSync(mdAbs, 'utf8');
      const app = isInsideVault(mdAbs, this.app) ? this.app : null;
      return Array.from(new Set(collectLocalAssets(text, mdAbs, app).map((i) => i.abs)));
    } catch (e) { return []; }
  }

  /**
   * 哪些附件还被「本次不搬走」的其他笔记引用？这些只复制、不移除原件。
   * 库内侧用 metadataCache（不读盘）；库外侧只扫源 MD 同目录。
   */
  async sharedAssets(assets, excludeMdAbs) {
    const shared = new Set();
    const list = Array.from(new Set(assets || []));
    if (!list.length) return shared;
    const excluded = new Set((excludeMdAbs || []).map((p) => path.resolve(p)));
    const vRoot = vaultRoot(this.app);

    const vaultAssets = vRoot ? list.filter((a) => isInsideVault(a, this.app)) : [];
    if (vaultAssets.length) {
      const relOf = (a) => path.relative(vRoot, a).split(path.sep).join('/');
      const rels = new Set(vaultAssets.map(relOf));
      try {
        const mc = this.app.metadataCache;
        const files = this.app.vault && typeof this.app.vault.getMarkdownFiles === 'function'
          ? this.app.vault.getMarkdownFiles() : [];
        for (const f of files) {
          if (excluded.has(path.resolve(vRoot, f.path))) continue;
          let cache = null;
          try { cache = mc && mc.getFileCache && mc.getFileCache(f); } catch (e) { /* noop */ }
          const refs = [].concat((cache && cache.embeds) || [], (cache && cache.links) || []);
          for (const r of refs) {
            let dest = null;
            try { dest = mc && mc.getFirstLinkpathDest && mc.getFirstLinkpathDest(r.link, f.path); }
            catch (e) { /* noop */ }
            if (dest && rels.has(dest.path)) {
              for (const a of vaultAssets) if (relOf(a) === dest.path) shared.add(a);
            }
          }
        }
      } catch (e) { this.dbg('共享附件检测（库内）失败', e.message); }
    }

    const extAssets = list.filter((a) => !isInsideVault(a, this.app));
    if (extAssets.length) {
      const dirs = new Set((excludeMdAbs || []).map((p) => path.dirname(path.resolve(p))));
      for (const d of dirs) {
        let mds = [];
        try { mds = await listMarkdownFiles(d, false); } catch (e) { /* noop */ }
        for (const f of mds) {
          if (excluded.has(path.resolve(f))) continue;
          let text = '';
          try { text = await fs.promises.readFile(f, 'utf8'); } catch (e) { continue; }
          for (const a of extAssets) if (text.includes(path.basename(a))) shared.add(a);
        }
      }
    }
    return shared;
  }

  /** 编辑器里可能有尚未落盘的改动，转移前把当前内容刷到源 MD */
  flushOpenEditor(src, matchFn) {
    try {
      if (typeof this.app.workspace.iterateAllLeaves !== 'function') return;
      this.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf && leaf.view;
        if (!view || !view.editor || typeof view.editor.getValue !== 'function') return;
        if (!matchFn(view)) return;
        const text = view.editor.getValue();
        if (typeof text === 'string') fs.writeFileSync(src, text, 'utf8');
      });
    } catch (e) { this.dbg('刷新编辑器内容失败', e.message); }
  }

  /**
   * 多选移出：一次遍历所有标签页，按「view.file → 对应源 MD」逐个刷盘。
   * 不能对每篇 MD 各调一次 flushOpenEditor，否则一个标签页的内容会被写到别篇源里。
   * 文件对象引用可能不同，故同时用绝对路径兜底匹配。
   */
  flushOpenEditors(targets) {
    try {
      if (typeof this.app.workspace.iterateAllLeaves !== 'function') return;
      const vRoot = vaultRoot(this.app);
      const byRef = new Map(targets.map((t) => [t.file, t.abs]));
      const byPath = new Map(targets.map((t) => [t.abs, t.abs]));
      this.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf && leaf.view;
        if (!view || !view.editor || typeof view.editor.getValue !== 'function') return;
        const f = view.file;
        if (!f) return;
        let dest = byRef.get(f);
        if (!dest && vRoot && f.path && !isExternalTFile(f)) {
          dest = byPath.get(path.resolve(vRoot, String(f.path)));
        }
        if (!dest) return;
        const text = view.editor.getValue();
        if (typeof text === 'string') fs.writeFileSync(dest, text, 'utf8');
      });
    } catch (e) { this.dbg('刷新多个编辑器内容失败', e.message); }
  }

  /** 源 MD 被移走前，关掉指向它的标签页 */
  detachLeaves(predicate) {
    const leaves = [];
    try {
      if (typeof this.app.workspace.iterateAllLeaves === 'function') {
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf && leaf.view && predicate(leaf.view, leaf)) leaves.push(leaf);
        });
      }
    } catch (e) { this.dbg('枚举标签页失败', e.message); }
    for (const leaf of leaves) {
      try { leaf.detach(); } catch (e) { this.dbg('关闭标签页失败', e.message); }
    }
    this.dbg('已关闭标签页', leaves.length);
  }

  /** 找当前打开某个文件的标签页；找不到返回 null */
  findLeafByFile(predicate) {
    let found = null;
    try {
      if (typeof this.app.workspace.iterateAllLeaves !== 'function') return null;
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (found) return;
        const view = leaf && leaf.view;
        if (view && view.file && predicate(view.file)) found = leaf;
      });
    } catch (e) { this.dbg('查找标签页失败', e.message); }
    return found;
  }

  /** 把已有标签页切换到库外文件（移出 Vault 时用，避免关标签造成跳动） */
  async openExternalInLeaf(leaf, abs) {
    if (!leaf || typeof leaf.openFile !== 'function' || !abs) return false;
    try {
      const unix = String(abs).split(path.sep).join('/');
      const f = this.app.vault.getFileByPath('file:' + unix);
      if (!f) return false;
      await leaf.openFile(f);
      return true;
    } catch (e) {
      this.dbg('标签切换为库外文件失败', e.message);
      return false;
    }
  }

  /** 文件列表右键（单选 / 多选）：MD → 库外 MD 目录；附件 → 库外附件目录 */
  /** 判断绝对路径是否位于当前外部库的 MD / 附件目录内 */
  isInsideExternalVault(abs) {
    if (!abs) return false;
    const p = path.resolve(abs);
    const dirs = [this.externalMdDir(), this.externalAssetDir()].filter(Boolean);
    return dirs.some((d) => {
      const base = path.resolve(d);
      return p === base || p.startsWith(base + path.sep);
    });
  }

  /** 任意位置的库外 MD → 选中的 External Vault（含附件） */
  async moveAnyToExternal(abs) {
    const targetVault = await this.pickTargetVault();
    if (!targetVault) return null;
    const vRoot = vaultRoot(this.app);
    if (!vRoot) throw new Error('拿不到 vault 根目录');
    const mdDestDir = resolveVaultRelative(this.app, targetVault.mdDir);
    const assetDestDir = resolveVaultRelative(this.app, targetVault.assetDir);
    if (!mdDestDir || !assetDestDir) throw new Error('拿不到目标外部库目录');
    return this.executeTransfer([abs], 'out', {
      paths: {
        vRoot, mdDestDir, assetDestDir,
        relAssetDir: relativeFromMd(mdDestDir, assetDestDir),
      },
      moveSource: this.settings.contextMenuMoveSource,
      note: '目标外部库：' + targetVault.name,
    });
  }

  async contextMoveOut(fileOrFiles) {
    const targets = vaultMdTargets(fileOrFiles, this.app);
    if (!targets.length) throw new Error('没有可移出的库内 Markdown 文件');
    const rawCount = Array.isArray(fileOrFiles) ? fileOrFiles.length : 1;
    const valid = targets.filter((t) => fs.existsSync(t.abs));
    if (!valid.length) throw new Error('源文件不存在：' + targets[0].abs);
    this.flushOpenEditors(valid);
    const srcs = valid.map((t) => t.abs);
    const srcSet = new Set(srcs);
    const byRef = new Set(valid.map((t) => t.file));
    const vRoot = vaultRoot(this.app);
    const matches = (f) => {
      if (!f) return false;
      if (byRef.has(f)) return true;
      if (!vRoot || !f.path || isExternalTFile(f)) return false;
      return srcSet.has(path.resolve(vRoot, String(f.path)));
    };
    const targetVault = await this.pickTargetVault();
    if (!targetVault) return null; // 用户取消
    const mdDestDir = resolveVaultRelative(this.app, targetVault.mdDir);
    const assetDestDir = resolveVaultRelative(this.app, targetVault.assetDir);
    if (!mdDestDir || !assetDestDir) throw new Error('拿不到目标外部库目录');
    const paths = {
      vRoot, mdDestDir, assetDestDir,
      relAssetDir: relativeFromMd(mdDestDir, assetDestDir),
    };
    // 多篇选中笔记共用一张图时只搬一次；被「本次不搬走」的笔记引用的附件保留原件
    const assets = new Set();
    for (const src of srcs) for (const a of this.assetPathsIn(src)) assets.add(a);
    const keep = await this.sharedAssets(Array.from(assets), srcs);
    const notes = [];
    const ignored = rawCount - targets.length;
    if (ignored > 0) notes.push('已忽略 ' + ignored + ' 个非 Markdown 项（含文件夹）');
    if (srcs.length < targets.length) {
      notes.push((targets.length - srcs.length) + ' 个源文件不存在，已跳过');
    }
    if (srcs.length > 1) notes.push('本次共 ' + srcs.length + ' 篇笔记');
    if (keep.size) notes.push(keep.size + ' 个附件还被别的笔记引用，已保留原件');
    return this.executeTransfer(srcs, 'out', {
      paths,
      moveSource: this.settings.contextMenuMoveSource,
      keepAssetSources: keep,
      beforeRemove: async (plans) => {
        if (!vRoot) return false;
        let switched = false;
        for (const p of plans || []) {
          const leaf = this.findLeafByFile(
            (f) => !isExternalTFile(f) && path.resolve(vRoot, String(f.path)) === p.src);
          if (!leaf) continue;
          const ok = await this.openExternalInLeaf(leaf, p.dest);
          switched = switched || ok;
        }
        return switched;
      },
      note: notes.join('\n'),
    });
  }

  /** 库外文件标签页右键：MD → 库根目录；附件 → 库内默认附件文件夹 */
  async contextMoveIn(file) {
    const src = externalAbsFromFile(file, this.app);
    if (!src) throw new Error('无法解析这个库外文件的绝对路径');
    if (!fs.existsSync(src)) throw new Error('库外文件不存在：' + src);
    this.flushOpenEditor(src, (v) => externalAbsFromFile(v.file, this.app) === src);
    const vRoot = vaultRoot(this.app);
    if (!vRoot) throw new Error('拿不到 vault 根目录');
    const mdDestDir = path.resolve(vRoot,
      String(this.settings.contextMenuVaultMdFolder || '').trim() || '.');
    const af = this.settings.contextMenuUseDefaultAttachmentFolder
      ? resolveDefaultAttachmentFolder(this.app, mdDestDir, this.settings.vaultAssetFolder)
      : {
        dir: path.resolve(mdDestDir,
          String(this.settings.vaultAssetFolder || 'assets').trim() || 'assets'),
        raw: '',
      };
    const paths = {
      vRoot, mdDestDir, assetDestDir: af.dir,
      relAssetDir: relativeFromMd(mdDestDir, af.dir),
    };
    const keep = await this.sharedAssets(this.assetPathsIn(src), [src]);
    return this.executeTransfer([src], 'in', {
      paths,
      moveSource: this.settings.contextMenuMoveSource,
      keepAssetSources: keep,
      beforeRemove: async (plans) => {
        const leaf = this.findLeafByFile((f) => externalAbsFromFile(f, this.app) === src);
        const dest = plans && plans[0] && plans[0].dest;
        if (!leaf || !dest) return false;
        const rel = path.relative(vRoot, dest).split(path.sep).join('/');
        return this.openImportedNote(rel, leaf);
      },
      note: (this.settings.contextMenuUseDefaultAttachmentFolder
        ? '附件使用库内默认附件文件夹：' + (af.raw ||
          '（未配置，回退 ' + (String(this.settings.vaultAssetFolder || 'assets').trim() || 'assets') + '）')
        : '附件使用插件设置的子目录') +
        (keep.size ? '\n' + keep.size + ' 个附件还被别的笔记引用，已保留原件' : ''),
    });
  }

  /**
   * 这些附件是否还被库外目录里的其他 MD 引用（递归扫描，不读库内索引）。
   * excludeMdAbs 支持单个路径或路径数组；批量删除时要把「所有待删笔记」一起排除。
   */
  async assetsUsedElsewhere(assets, excludeMdAbs) {
    const used = new Set();
    const list = Array.from(new Set(assets || [])).filter((a) => fs.existsSync(a));
    if (!list.length) return used;
    const rawExclude = Array.isArray(excludeMdAbs) ? excludeMdAbs : [excludeMdAbs];
    const excluded = new Set(rawExclude.filter(Boolean).map((p) => path.resolve(p)));
    const wanted = new Set(list.map((a) => path.resolve(a)));
    let mds = [];
    try { mds = await listMarkdownFiles(this.externalMdDir(), true, 8); }
    catch (e) { this.dbg('扫描库外 MD 失败，按「全部共享」处理', e.message); return new Set(list); }
    for (const md of mds) {
      if (excluded.has(path.resolve(md))) continue;
      let text = '';
      try { text = await fs.promises.readFile(md, 'utf8'); } catch (e) { continue; }
      for (const it of collectLocalAssets(text, md, null)) {
        const abs = path.resolve(it.abs);
        if (wanted.has(abs)) used.add(it.abs);
      }
    }
    return used;
  }

  /** 批量删除计划：只统计库外、存在、且不被「未选中」笔记引用的附件 */
  async deletePlanFor(srcs) {
    const list = Array.from(new Set((srcs || []).map((p) => path.resolve(p))));
    const assets = new Set();
    for (const src of list) {
      for (const a of this.assetPathsIn(src)) {
        if (!isInsideVault(a, this.app) && fs.existsSync(a)) assets.add(a);
      }
    }
    const all = Array.from(assets);
    const shared = await this.assetsUsedElsewhere(all, list);
    return { assets: all, shared, doomed: all.filter((a) => !shared.has(a)) };
  }

  /** 单篇确认弹窗：先算清会删哪些附件，再由用户点确认 */
  async promptDeleteExternalNote(file) {
    const src = externalAbsFromFile(file, this.app);
    if (!src) throw new Error('无法解析这个库外文件的绝对路径');
    if (!fs.existsSync(src)) throw new Error('库外文件不存在：' + src);
    const plan = await this.deletePlanFor([src]);
    new DeleteExternalNoteModal(this.app, this, src, plan.assets, plan.shared).open();
  }

  /** 批量删除库外 MD；附件只删「只被这些笔记引用」的库外文件 */
  async deleteExternalNotes(srcs) {
    const list = Array.from(new Set((srcs || []).map((p) => path.resolve(p))))
      .filter((p) => fs.existsSync(p));
    if (!list.length) throw new Error('没有可删除的库外 Markdown 文件');

    // 未保存的编辑器内容先落盘，避免删掉后又被写回
    for (const src of list) {
      this.flushOpenEditor(src, (v) => externalAbsFromFile(v.file, this.app) === src);
    }
    const plan = await this.deletePlanFor(list);

    // 删除库外笔记一律走系统废纸篓，保证可恢复
    // 删除前先在本机留一份备份，撤销时优先用它（不依赖废纸篓读取权限）
    const backupDir = this.backupDirFor('delete');
    const backupMap = new Map();
    list.forEach((p, i) => {
      const b = this.backupFile(p, backupDir, i);
      if (b) backupMap.set(p, b);
    });

    const mdRes = await cutSourceFiles(list, true);
    const failedMd = new Set(mdRes.failed.map((f) => path.resolve(f.path)));
    const deleted = list.filter((p) => !failedMd.has(p));

    // 删除失败的 MD 仍在引用附件，这些附件必须留下
    const keepByFailed = new Set();
    for (const src of failedMd) {
      for (const a of this.assetPathsIn(src)) keepByFailed.add(path.resolve(a));
    }
    const toDelete = plan.doomed.filter((a) => !keepByFailed.has(path.resolve(a)));

    for (const src of deleted) {
      this.detachLeaves((view) => externalAbsFromFile(view.file, this.app) === src);
    }
    toDelete.forEach((p, i) => {
      const b = this.backupFile(p, backupDir, list.length + i);
      if (b) backupMap.set(p, b);
    });

    const assetRes = toDelete.length
      ? await cutSourceFiles(toDelete, true)
      : { removed: 0, trashed: 0, failed: [] };

    // 记录本次删除，供「撤销上一次移动」从备份 / 废纸篓恢复
    const removedNotes = deleted.filter((p) => !fs.existsSync(p));
    const removedAssets = toDelete.filter((p) => !fs.existsSync(p));
    if (removedNotes.length || removedAssets.length) {
      this.settings.lastMove = {
        ts: Date.now(),
        kind: 'delete',
        trashed: true,
        notes: removedNotes.map((p) => ({ src: p, dest: null, backup: backupMap.get(p) || null })),
        assets: removedAssets.map((p) => ({ src: p, dest: null, backup: backupMap.get(p) || null })),
      };
      try { await this.saveData(this.settings); } catch (e) { /* noop */ }
    }

    const lines = ['已删除 ' + deleted.length + ' 篇库外 MD' +
      (failedMd.size ? '（' + failedMd.size + ' 篇删除失败）' : '')];
    lines.push('附件：删除 ' + assetRes.removed + ' 个' +
      (plan.shared.size ? '，保留 ' + plan.shared.size + ' 个（仍被其他笔记引用）' : ''));
    if (assetRes.failed.length) lines.push(assetRes.failed.length + ' 个附件删除失败，已留在原处');
    new obsidian.Notice(lines.join('\n'), 8000);

    return {
      notes: deleted.length,
      removed: assetRes.removed,
      kept: plan.shared.size,
      failed: mdRes.failed.concat(assetRes.failed),
    };
  }

  /** 单篇删除：右键菜单 / 命令入口 */
  async deleteExternalNote(file) {
    const src = externalAbsFromFile(file, this.app);
    if (!src) throw new Error('无法解析这个库外文件的绝对路径');
    if (!fs.existsSync(src)) throw new Error('库外文件不存在：' + src);
    const r = await this.deleteExternalNotes([src]);
    return { md: src, removed: r.removed, kept: r.kept, failed: r.failed };
  }

  /** 探测不到路径时用它导出真实数据结构，便于按版本适配 */
  async diagnose() {
    const views = this.candidateViews();
    const view = views[0] || null;
    const ctx = this.activeExternalContext();
    const vp = (d) => {
      try {
        const p = this.vaultPaths(d);
        return { md: p.mdDestDir, assets: p.assetDestDir, linkPrefix: p.relAssetDir };
      } catch (e) { return String(e && e.message ? e.message : e); }
    };
    const out = {
      plugin: 'external-vault',
      apiVersion: obsidian.apiVersion || null,
      hasView: !!view,
      candidateViews: views.length,
      viewStates: views.map((v) => {
        try {
          return {
            type: typeof v.getViewType === 'function' ? v.getViewType() : null,
            file: v.file ? v.file.path : null,
            state: typeof v.getState === 'function' ? v.getState() : null,
            resolved: resolveExternal(v, this.app),
          };
        } catch (e) { return String(e && e.message ? e.message : e); }
      }),
      vaultRoot: vaultRoot(this.app),
      settings: Object.assign({}, this.settings),
      resolvedPaths: {
        mode: this.settings.mode,
        mdRel: this.mdRel(),
        assetRel: this.assetRel(),
        mdDir: this.externalMdDir(),
        assetDir: this.externalAssetDir(),
        linkPrefixBetweenDirs: (this.externalMdDir() && this.externalAssetDir())
          ? relativeFromMd(this.externalMdDir(), this.externalAssetDir()) : null,
        linkPrefixFromCurrentMd: ctx ? relativeFromMd(ctx.dir, this.imageDirFor(ctx)) : null,
        transferIn: vp('in'),
        transferOut: vp('out'),
      },
      contextMenu: {
        enabled: this.settings.contextMenuEnabled,
        menuEvents: ['file-menu', 'files-menu', 'leaf-menu'],
        hasTExternalFileClass: !!obsidian.TExternalFile,
        attachmentFolderSetting: attachmentFolderSetting(this.app),
        defaultAttachmentFolder: (() => {
          try {
            return resolveDefaultAttachmentFolder(this.app, vaultRoot(this.app),
              this.settings.vaultAssetFolder).dir;
          } catch (e) { return String(e && e.message ? e.message : e); }
        })(),
        moveInMdDir: path.resolve(vaultRoot(this.app) || '.',
          String(this.settings.contextMenuVaultMdFolder || '').trim() || '.'),
        moveOutMdDir: this.externalMdDir(),
        moveOutAssetDir: this.externalAssetDir(),
      },
      ribbon: {
        enabled: this.settings.ribbonEnabled,
        clickAction: this.settings.ribbonClickAction,
        maxNotes: this.settings.ribbonMaxNotes,
        mdDir: this.externalMdDir(),
        noteCount: listExternalMdFiles(this.externalMdDir(), 9999).length,
        canOpenExternalMd: !!(this.app.vault && typeof this.app.vault.getFileByPath === 'function'),
      },
      file: null,
      state: null,
      domExternalClass: false,
      resolved: null,
    };
    if (view) {
      const f = view.file;
      if (f) {
        const o = {};
        for (const k of Object.getOwnPropertyNames(f)) {
          try {
            const v = f[k];
            if (v === null || ['string', 'number', 'boolean'].indexOf(typeof v) !== -1) o[k] = v;
            else if (v && typeof v === 'object') o[k] = '[' + (v.constructor && v.constructor.name) + ']';
          } catch (err) { o[k] = '<getter error>'; }
        }
        try {
          const a = f.vault && f.vault.adapter;
          o._vaultBase = a && (a.basePath || (typeof a.getBasePath === 'function' ? a.getBasePath() : null));
          o._isMainVault = f.vault === this.app.vault;
        } catch (err) { /* noop */ }
        out.file = o;
      }
      try { out.state = typeof view.getState === 'function' ? view.getState() : null; } catch (err) { out.state = String(err); }
      try { out.domExternalClass = !!view.containerEl.querySelector('.mod-external-file'); } catch (err) { /* noop */ }
      out.resolved = resolveExternal(view, this.app);
    }

    const text = JSON.stringify(out, null, 2);
    console.log(LOG, 'diagnose\n' + text);
    try {
      await navigator.clipboard.writeText(text);
      new obsidian.Notice('诊断信息已复制到剪贴板（控制台也有一份）');
    } catch (err) {
      new obsidian.Notice('请从开发者控制台查看诊断信息');
    }
  }
}

// ---------------------------------------------------------------------------

class DeleteExternalNoteModal extends obsidian.Modal {
  constructor(app, plugin, src, assets, shared) {
    super(app);
    this.plugin = plugin;
    this.src = src;
    this.assets = assets;
    this.shared = shared;
  }

  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass('external-vault-modal');

    el.createEl('h2', { text: '删除库外 Markdown（含附件）' });

    const doomed = this.assets.filter((a) => !this.shared.has(a));
    const lines = [
      '笔记：' + this.src,
      '将删除附件：' + doomed.length + ' 个',
    ];
    if (doomed.length) {
      lines.push(doomed.slice(0, 6).map((a) => '  · ' + path.basename(a)).join('\n') +
        (doomed.length > 6 ? '\n  · …' : ''));
    }
    if (this.shared.size) {
      lines.push('保留附件：' + this.shared.size + ' 个（仍被其他笔记引用）');
    }
    el.createDiv({ cls: 'ev-preview' }).textContent = lines.join('\n');

    el.createEl('p', {
      cls: 'setting-item-description',
      text: '文件会移到系统废纸篓，可从废纸篓找回。只删除库外目录里的附件，库内附件一律保留。',
    });

    const buttons = el.createDiv({ cls: 'ev-buttons' });
    const ok = buttons.createEl('button', { text: '确认删除', cls: 'mod-warning' });
    const cancel = buttons.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    ok.addEventListener('click', () => {
      this.close();
      Promise.resolve(this.plugin.deleteExternalNote({
        path: 'file:' + this.src, extension: 'md', getRealPath: () => this.src,
      })).catch((err) => this.plugin.reportError(err));
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  onClose() { this.contentEl.empty(); }
}

class ExternalFilesModal extends obsidian.Modal {
  constructor(app, plugin, opts) {
    super(app);
    this.plugin = plugin;
    this.opts = opts || {};
    this.mode = this.opts.mode === 'pick' ? 'pick' : this.opts.mode === 'open' ? 'open' : 'manage';
    this.onPick = this.opts.onPick || null;
    this.files = [];
    this.selected = new Set();
    this.query = '';
    this.stage = 'list';
    this.confirmData = null;
    this.listEl = null;
    this.allBox = null;
    this.countEl = null;
    this.okBtn = null;
  }

  async onOpen() {
    try { this.modalEl.addClass('ev-files-modal'); } catch (e) { /* noop */ }
    this.render();
    await this.load();
  }

  async load() {
    this.files = await this.plugin.listExternalEntries();
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    el.addClass('external-vault-modal');
    if (this.stage === 'confirm' && this.confirmData) {
      this.renderConfirm(el);
      return;
    }

    const picking = this.mode === 'pick';
    const opening = this.mode === 'open';
    const head = el.createDiv({ cls: 'ev-files-head' });
    head.createEl('h2', {
      text: opening ? '打开库外文件' : (picking ? '插入库外文件链接' : '库外文件'),
    });
    const searchWrap = head.createDiv({ cls: 'ev-files-search' });
    const search = searchWrap.createEl('input', {
      type: 'search', placeholder: tr('搜索文件名、路径、别名或拼音首字母…'),
    });
    search.value = this.query || '';
    search.addEventListener('input', () => {
      this.query = search.value;
      this.plugin.ensureExternalContents(this.files)
        .then(() => this.renderList())
        .catch(() => this.renderList());
    });

    el.createEl('p', {
      cls: 'setting-item-description',
      text: opening
        ? '双击一行直接打开；也可以搜索文件名或路径。'
        : (picking
          ? '勾选一个或多个文件，点「插入」在光标处生成相对链接（../External Vault/…）；换电脑只要目录结构一致即可继续用。'
          : '目录：' + this.plugin.externalMdDir() + '　共 ' + this.files.length + ' 篇'),
    });

    if (!opening) {
    const toolbar = el.createDiv({ cls: 'ev-files-toolbar' });
    const all = toolbar.createEl('label', { cls: 'ev-files-all' });
    this.allBox = all.createEl('input', { type: 'checkbox' });
    this.allBox.addEventListener('change', () => {
      const rows = this.filtered();
      if (this.allBox.checked) rows.forEach((f) => this.selected.add(f.abs));
      else rows.forEach((f) => this.selected.delete(f.abs));
      this.renderList();
    });
    all.createSpan({ text: '全选' });
    this.countEl = toolbar.createSpan({ cls: 'ev-files-count', text: '已选 ' + this.selected.size + ' 篇' });
    }

    this.listEl = el.createDiv({ cls: 'ev-files-list' });
    this.renderList();

    const buttons = el.createDiv({ cls: 'ev-buttons' });
    const finder = buttons.createEl('button', { text: tr('打开 Finder'), cls: 'ev-finder-btn' });
    finder.addEventListener('click', () => {
      this.close();
      this.plugin.guard(() => this.plugin.revealExternalVault());
    });
    if (!opening) {
      this.okBtn = buttons.createEl('button', {
        text: picking ? '插入' : '删除选中（含附件）',
        cls: picking ? 'mod-cta' : 'mod-warning',
      });
      this.okBtn.addEventListener('click', () => {
        if (picking) this.commitPick();
        else this.prepareDelete();
      });
    }
    const close = buttons.createEl('button', {
      text: opening ? '关闭' : (picking ? '取消' : '关闭'),
    });
    close.addEventListener('click', () => this.close());
    this.updateFooter();
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  /** 当前搜索词过滤后的文件（按名称或相对路径，忽略大小写） */
  filtered() {
    return searchExternalEntries(this.files, this.query, this.plugin._contentCache);
  }

  /** 只重建列表，让搜索框保持焦点与输入法状态 */
  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();
    const rows = this.filtered();
    if (!rows.length) {
      this.listEl.createDiv({
        cls: 'ev-files-empty',
        text: this.files.length ? '没有匹配的文件' : 'External Vault 里还没有 Markdown 文件',
      });
      this.updateFooter();
      return;
    }
    const opening = this.mode === 'open';
    for (const f of rows) {
      const row = this.listEl.createEl('label', {
        cls: 'ev-files-row' + (opening ? ' is-openable' : ''),
      });
      if (!opening) {
        const box = row.createEl('input', { type: 'checkbox' });
        box.checked = this.selected.has(f.abs);
        box.addEventListener('change', () => {
          if (box.checked) this.selected.add(f.abs);
          else this.selected.delete(f.abs);
          this.updateFooter();
        });
      }
      const main = row.createDiv({ cls: 'ev-files-main' });
      const kindLabel = f.kind === 'md' ? 'MD'
        : (f.kind === 'pdf' ? 'PDF' : (f.kind === 'image' ? 'IMG' : 'FILE'));
      const nameLine = main.createDiv({ cls: 'ev-files-name' });
      nameLine.createSpan({ cls: 'ev-files-kind', text: kindLabel });
      nameLine.createSpan({ text: path.basename(f.abs) });
      main.createDiv({ cls: 'ev-files-path', text: f.rel });
      if (f.aliases && f.aliases.length) {
        main.createDiv({ cls: 'ev-files-alias', text: tr('别名：') + f.aliases.join(' / ') });
      }
      const meta = row.createDiv({ cls: 'ev-files-meta' });
      meta.textContent = f.kind === 'md'
        ? ((f.assets ? f.assets + tr(' 个附件') : tr('无附件')) +
          (f.mtime ? ' · ' + new Date(f.mtime).toLocaleString() : ''))
        : (formatBytes(f.size) +
          (f.mtime ? ' · ' + new Date(f.mtime).toLocaleString() : ''));
      if (opening) {
        row.addEventListener('click', () => {
          this.listEl.querySelectorAll('.ev-files-row.is-active')
            .forEach((x) => x.classList.remove('is-active'));
          row.classList.add('is-active');
        });
        row.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openPicked(f);
        });
      }
    }
    this.updateFooter();
  }

  updateFooter() {
    const n = this.selected.size;
    if (this.countEl) this.countEl.textContent = '已选 ' + n + ' 篇';
    const rows = this.filtered();
    if (this.allBox) {
      this.allBox.checked = rows.length > 0 && rows.every((f) => this.selected.has(f.abs));
    }
    if (this.okBtn) {
      this.okBtn.disabled = n === 0;
      this.okBtn.textContent = this.mode === 'pick' ? '插入' : '删除选中（含附件）';
    }
  }

  commitPick() {
    const list = Array.from(this.selected);
    if (!list.length) return;
    if (this.onPick) this.onPick(list);
    this.close();
  }

  /** open 模式：双击一行直接打开库外文件 */
  openPicked(f) {
    this.close();
    this.plugin.guard(() => (f.kind === 'md'
      ? this.plugin.openExternalMd(f.abs)
      : this.plugin.openExternalAny(f.abs)));
  }

  async prepareDelete() {
    const srcs = Array.from(this.selected);
    if (!srcs.length) return;
    try {
      const plan = await this.plugin.deletePlanFor(srcs);
      this.confirmData = { srcs, plan };
      this.stage = 'confirm';
      this.render();
    } catch (e) { this.plugin.reportError(e); }
  }

  renderConfirm(el) {
    const { srcs, plan } = this.confirmData;
    el.createEl('h2', { text: tr('确认删除库外 MD（含附件）') });
    const lines = [
      '将删除：' + srcs.length + ' 篇 Markdown',
      '将删除附件：' + plan.doomed.length + ' 个',
    ];
    if (plan.doomed.length) {
      lines.push(plan.doomed.slice(0, 8).map((a) => '  · ' + path.basename(a)).join('\n') +
        (plan.doomed.length > 8 ? '\n  · …' : ''));
    }
    if (plan.shared.size) lines.push('保留附件：' + plan.shared.size + ' 个（仍被其他笔记引用）');
    el.createDiv({ cls: 'ev-preview' }).textContent = lines.join('\n');
    el.createEl('p', {
      cls: 'setting-item-description',
      text: '文件会移到系统废纸篓，可从废纸篓找回。只删除库外目录里的附件；库内附件一律保留。',
    });

    const buttons = el.createDiv({ cls: 'ev-buttons' });
    const ok = buttons.createEl('button', { text: '确认删除', cls: 'mod-warning' });
    ok.addEventListener('click', () => {
      ok.disabled = true;
      ok.textContent = '删除中…';
      Promise.resolve(this.plugin.deleteExternalNotes(srcs))
        .then(() => this.close())
        .catch((e) => {
          ok.disabled = false;
          ok.textContent = '确认删除';
          this.plugin.reportError(e);
        });
    });
    const back = buttons.createEl('button', { text: '返回' });
    back.addEventListener('click', () => {
      this.stage = 'list';
      this.confirmData = null;
      this.render();
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  onClose() { this.contentEl.empty(); }
}

class TransferConfirmModal extends obsidian.Modal {
  constructor(app, plugin, direction, files, sourceDir) {
    super(app);
    this.plugin = plugin;
    this.direction = direction;
    this.files = files;
    this.sourceDir = sourceDir;
    this.move = plugin.settings.moveSourceAfterTransfer;
  }

  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass('external-vault-modal');

    el.createEl('h2', { text: this.direction === 'in' ? '转入库：批量转移' : '移出库：批量转移' });
    let dest = '';
    try { dest = this.plugin.vaultPaths(this.direction).mdDestDir; } catch (e) { dest = '（未配置）'; }
    const info = el.createDiv({ cls: 'ev-preview' });
    info.textContent =
      '来源：' + this.sourceDir + '\n' +
      '目标：' + dest + '\n' +
      '共 ' + this.files.length + ' 篇 .md（' + (this.plugin.settings.transferRecursive ? '含子文件夹' : '仅当前层') + '）\n' +
      '前几篇：' + this.files.slice(0, 6).map((f) => path.basename(f)).join('、') +
      (this.files.length > 6 ? ' …' : '');

    el.createEl('p', {
      cls: 'setting-item-description',
      text: '附件会一并复制，MD 里的本地图片/文件链接自动重写成新位置的相对路径；[[笔记双链]] 不会被搬动。',
    });

    new obsidian.Setting(el)
      .setName('转移后剪切源文件（删除原件）')
      .setDesc('开启后源文件从原位置直接删除，不再生成额外备份目录，不可撤销；关闭则只复制')
      .addToggle((t) => t.setValue(this.move).onChange((v) => { this.move = v; }));

    const buttons = el.createDiv({ cls: 'ev-buttons' });
    const ok = buttons.createEl('button', { text: '开始转移', cls: 'mod-cta' });
    const cancel = buttons.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    ok.addEventListener('click', () => {
      this.close();
      Promise.resolve(this.plugin.executeTransfer(this.files, this.direction, { moveSource: this.move }))
        .catch((err) => this.plugin.reportError(err));
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      else if (e.key === 'Enter') ok.click();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class NewExternalNoteModal extends obsidian.Modal {
  constructor(app, plugin, root, ctx) {
    super(app);
    this.plugin = plugin;
    this.root = root;
    this.ctx = ctx;
  }

  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass('external-vault-modal');

    el.createEl('h2', { text: '新建库外 Markdown 文件' });

    const nameLabel = el.createDiv({ cls: 'ev-label', text: '文件名' });
    const nameInput = el.createEl('input', { type: 'text', cls: 'ev-input', placeholder: '不用写 .md' });

    const buttons = el.createDiv({ cls: 'ev-buttons' });
    const ok = buttons.createEl('button', { text: '创建并打开', cls: 'mod-cta' });
    const cancel = buttons.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    ok.addEventListener('click', () => this.submit(nameInput.value));

    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(nameInput.value); }
      else if (e.key === 'Escape') this.close();
    };
    nameInput.addEventListener('keydown', onKey);

    setTimeout(() => nameInput.focus(), 0);
    this.nameInput = nameInput;
  }

  submit(name) {
    if (!String(name || '').trim()) {
      this.nameInput.focus();
      return;
    }
    this.close();
    // 不传子目录：直接落到默认的库外 MD 目录（External Vault 根目录）
    Promise.resolve(this.plugin.createExternalNote(name))
      .catch((err) => this.plugin.reportError(err));
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------

class ExternalFileImageSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const el = this.containerEl;
    el.empty();
    // 只给本插件的设置页加标记，避免分组标题样式影响 Obsidian 其它设置页
    if (typeof el.addClass === 'function') el.addClass('ev-settings');
    else if (el.classList && typeof el.classList.add === 'function') el.classList.add('ev-settings');
    const save = async (key, value) => {
      this.plugin.settings[key] = value;
      await this.plugin.saveData(this.plugin.settings);
    };

    el.createEl('h2', { text: tr('库外文件图片 / 新建') });

    new obsidian.Setting(el)
      .setName(tr('语言'))
      .setDesc(tr('界面语言；切换后建议重载插件（Cmd+R）以更新命令名'))
      .addDropdown((d) => d
        .addOption('auto', tr('跟随 Obsidian'))
        .addOption('zh', '中文')
        .addOption('en', 'English')
        .setValue(this.plugin.settings.language || 'auto')
        .onChange(async (v) => {
          this.plugin.settings.language = v;
          await this.plugin.saveData(this.plugin.settings);
          UI_LANG = detectLang(this.plugin.settings);
          this.display();
        }));

    new obsidian.Setting(el)
      .setName(tr('当前外部库'))
      .setDesc(tr('右侧面板、新建笔记、移出 Vault 都作用于这个库'))
      .addDropdown((d) => {
        for (const v of this.plugin.externalVaultsList()) d.addOption(v.id, v.name);
        d.setValue(this.plugin.settings.activeVaultId || 'default')
          .onChange((v) => this.plugin.setActiveVault(v).then(() => this.display()));
      });
    el.createEl('p', {
      cls: 'setting-item-description',
      text: tr('编辑库外 MD 时，粘贴 / 拖入的附件自动存进库外附件目录并插入相对路径；库内笔记行为不变。'),
    });

    new obsidian.Setting(el).setName(tr('目录模式')).setHeading();

    new obsidian.Setting(el)
      .setName(tr('选择方式'))
      .setDesc(tr('简易：无需设置任何文件夹；自定义：自己填两个相对目录'))
      .addDropdown((d) => d
        .addOption('simple', tr('简易（默认，无需设置）'))
        .addOption('custom', tr('自定义两个目录'))
        .setValue(this.plugin.settings.mode)
        .onChange((v) => { save('mode', v).then(() => this.display()); }));

    el.createEl('p', {
      cls: 'setting-item-description',
      text: tr('所有目录都相对当前 vault 根目录填写，"../" 表示与库同级。当前库：') + (vaultRoot(this.app) || tr('（未知）')),
    });

    const mdAbs = this.plugin.externalMdDir();
    const assetAbs = this.plugin.externalAssetDir();
    const relLink = (mdAbs && assetAbs) ? relativeFromMd(mdAbs, assetAbs) : '';
    const preview = el.createDiv({ cls: 'ev-settings-preview' });
    preview.textContent =
      tr('库外 MD 目录：') + this.plugin.mdRel() + '\n' +
      '        → ' + (mdAbs || '?') + '\n' +
      tr('库外附件目录：') + this.plugin.assetRel() + '\n' +
      '        → ' + (assetAbs || '?') + '\n' +
      tr('插入的链接前缀：') + (relLink ? relLink + '/' : './');

    if (this.plugin.settings.mode === 'custom') {
      let mdText;
      new obsidian.Setting(el)
        .setName(tr('库外放 MD 的目录'))
        .setDesc(tr('相对 vault 根，例如 ../External Vault；也可写多层，如 ../PBL/notes'))
        .addText((t) => {
          mdText = t;
          t.setPlaceholder(SIMPLE_MD_REL)
            .setValue(this.plugin.settings.customMdDir)
            .onChange((v) => save('customMdDir', v.trim()));
        })
        .addButton((b) => b.setButtonText(tr('选择…')).onClick(() => {
          pickDirectory((dir) => {
            const v = this.toRelative(dir);
            mdText.setValue(v);
            save('customMdDir', v).then(() => this.display());
          }, vaultRoot(this.app));
        }));

      let assetText;
      new obsidian.Setting(el)
        .setName(tr('库外放附件的目录'))
        .setDesc(tr('相对 vault 根，例如 ../External Vault/attachments'))
        .addText((t) => {
          assetText = t;
          t.setPlaceholder(SIMPLE_ASSET_REL)
            .setValue(this.plugin.settings.customAssetDir)
            .onChange((v) => save('customAssetDir', v.trim()));
        })
        .addButton((b) => b.setButtonText(tr('选择…')).onClick(() => {
          pickDirectory((dir) => {
            const v = this.toRelative(dir);
            assetText.setValue(v);
            save('customAssetDir', v).then(() => this.display());
          }, vaultRoot(this.app));
        }));

      el.createEl('p', {
        cls: 'setting-item-description',
        text: tr('「选择…」会把手选的绝对路径自动换算成相对 vault 根的写法；请选一个「里面至少有一个文件」的文件夹，空文件夹请直接手输。两个目录改动后，插入的链接前缀会自动重算。'),
      });
    } else {
      el.createEl('p', {
        cls: 'setting-item-description',
        text: tr('简易模式固定使用与库同级的 External Vault/ 放 MD、External Vault/attachments/ 放附件；插件加载时自动创建，不需要选任何文件夹。'),
      });
    }

    new obsidian.Setting(el).setName(tr('其他外部库')).setHeading();
    const extras = this.plugin.settings.externalVaults || [];
    for (const v of extras) {
      new obsidian.Setting(el)
        .setName(v.name || v.id)
        .setDesc(tr('名称'))
        .addText((t) => t.setValue(v.name || '')
          .onChange((x) => { v.name = x.trim(); save('externalVaults', extras); }))
        .addButton((b) => b.setButtonText(tr('删除')).onClick(async () => {
          this.plugin.settings.externalVaults = extras.filter((x) => x.id !== v.id);
          if (this.plugin.settings.activeVaultId === v.id) {
            this.plugin.settings.activeVaultId = 'default';
          }
          await save('externalVaults', this.plugin.settings.externalVaults);
          this.display();
        }));
      new obsidian.Setting(el)
        .setName(tr('MD 目录'))
        .addText((t) => t.setValue(v.mdDir || '')
          .onChange((x) => { v.mdDir = x.trim(); save('externalVaults', extras); }));
      new obsidian.Setting(el)
        .setName(tr('附件目录'))
        .addText((t) => t.setValue(v.assetDir || '')
          .onChange((x) => { v.assetDir = x.trim(); save('externalVaults', extras); }));
    }
    new obsidian.Setting(el)
      .setDesc(tr('每个外部库有独立的 MD 和附件目录；在顶部「当前外部库」切换'))
      .addButton((b) => b.setButtonText(tr('添加外部库')).setCta().onClick(() => {
        pickDirectory(async (dir) => {
          if (!dir) return;
          const mdRel = this.toRelative(dir) || dir;
          const assetAbs = path.join(dir, 'attachments');
          const assetRel = this.toRelative(assetAbs) || assetAbs;
          const item = {
            id: 'vault-' + Date.now(),
            name: path.basename(dir) || tr('外部库'),
            mdDir: mdRel,
            assetDir: assetRel,
          };
          this.plugin.settings.externalVaults =
            (this.plugin.settings.externalVaults || []).concat([item]);
          await save('externalVaults', this.plugin.settings.externalVaults);
          this.display();
        }, vaultRoot(this.app));
      }));

    new obsidian.Setting(el)
      .setName(tr('接管非图片附件'))
      .setDesc(tr('开启后拖入 PDF、docx、zip 等文件也存进附件目录并插入 [文件名](相对路径)；.md/.txt 等笔记类不接管'))
      .addToggle((t) => t.setValue(this.plugin.settings.handleOtherAttachments)
        .onChange((v) => save('handleOtherAttachments', v)));

    // 「一键转移（连附件）」这一组设置已从面板移除：它只影响命令面板的 4 个旧命令。
    // 这些命令仍按 DEFAULT_SETTINGS 的固定默认值运行；唯一对右键菜单也生效的
    // 「剪切时移入系统废纸篓」已移到下面的「右键菜单」组。

    new obsidian.Setting(el).setName(tr('右键菜单：移出 / 移入 Vault')).setHeading();
    el.createEl('p', {
      cls: 'setting-item-description',
      text: tr('库内笔记右键 →「移出 Vault」（支持多选）；库外标签页右键 →「移入 Vault」。附件随 MD 一起搬走并重写相对路径，笔记双链、网络图片不动。命令面板的「转入库 / 移出库」旧命令沿用固定默认规则。'),
    });

    const vRoot = vaultRoot(this.app);
    const inMdDir = path.resolve(vRoot || '.',
      String(this.plugin.settings.contextMenuVaultMdFolder || '').trim() || '.');
    const inAsset = (() => {
      try {
        if (this.plugin.settings.contextMenuUseDefaultAttachmentFolder) {
          return resolveDefaultAttachmentFolder(this.app, inMdDir, this.plugin.settings.vaultAssetFolder);
        }
        return {
          dir: path.resolve(inMdDir,
            String(this.plugin.settings.vaultAssetFolder || 'assets').trim() || 'assets'),
          raw: '',
        };
      } catch (e) { return { dir: '?', raw: '' }; }
    })();
    const menuPreview = el.createDiv({ cls: 'ev-settings-preview' });
    menuPreview.textContent =
      tr('移出 Vault：MD → ') + (mdAbs || '?') + '\n' +
      tr('             附件 → ') + (assetAbs || '?') + '\n' +
      tr('移入 Vault：MD → ') + inMdDir + '\n' +
      tr('             附件 → ') + inAsset.dir + '\n' +
      tr('库内默认附件夹配置：') + (attachmentFolderSetting(this.app) || tr('（未配置，回退 assets）')) +
      '\nTExternalFile 类：' + (obsidian.TExternalFile ? tr('可用') : tr('不可用（走路径兜底）'));

    new obsidian.Setting(el)
      .setName(tr('显示右键菜单项'))
      .setDesc(tr('关掉后两个右键菜单里都不再出现本插件的条目'))
      .addToggle((t) => t.setValue(this.plugin.settings.contextMenuEnabled)
        .onChange((v) => save('contextMenuEnabled', v)));

    new obsidian.Setting(el)
      .setName(tr('移入 Vault：MD 目标文件夹'))
      .setDesc(tr('相对 vault 根目录；留空 = 库根目录（默认）'))
      .addText((t) => t.setPlaceholder(tr('（库根目录）'))
        .setValue(this.plugin.settings.contextMenuVaultMdFolder)
        .onChange((v) => save('contextMenuVaultMdFolder', v.trim()).then(() => this.display())));

    new obsidian.Setting(el)
      .setName(tr('移入 Vault：附件放到库内默认附件文件夹'))
      .setDesc(tr('读取 设置 → 文件与链接 → 默认附件位置（当前为 ') +
        (attachmentFolderSetting(this.app) || '/') + tr('）；关闭则放到目标 MD 目录下的 assets 子目录'))
      .addToggle((t) => t.setValue(this.plugin.settings.contextMenuUseDefaultAttachmentFolder)
        .onChange((v) => save('contextMenuUseDefaultAttachmentFolder', v).then(() => this.display())));

    new obsidian.Setting(el)
      .setName(tr('移入 / 移出后剪切源文件（删除原件）'))
      .setDesc(tr('默认开 = 真正剪切，源文件从原位置直接删除，不生成额外备份目录；关闭则只复制。想留后路可开启下面的「剪切时移入系统废纸篓」'))
      .addToggle((t) => t.setValue(this.plugin.settings.contextMenuMoveSource)
        .onChange((v) => save('contextMenuMoveSource', v)));

    new obsidian.Setting(el)
      .setName(tr('剪切时移入系统废纸篓'))
      .setDesc(tr('默认开 = 源文件移入系统废纸篓，可找回；关闭则直接从磁盘删除。对右键菜单和命令面板同时生效'))
      .addToggle((t) => t.setValue(this.plugin.settings.cutUseTrash)
        .onChange((v) => save('cutUseTrash', v)));

    el.createEl('p', {
      cls: 'setting-item-description',
      text: tr('安全处理：删除源文件前会先确认所有目标文件已写盘；被其他笔记共用的附件只复制、保留原件。注意：移出 Vault 后库内其他笔记指向该笔记的 [[双链]] 会失效，直接删除不可撤销。'),
    });

    new obsidian.Setting(el).setName(tr('Ribbon 按钮：打开 External Vault')).setHeading();
    el.createEl('p', {
      cls: 'setting-item-description',
      text: tr('左键默认弹出菜单，右键始终弹出完整菜单；目录路径见上方「目录模式」。'),
    });

    new obsidian.Setting(el)
      .setName(tr('显示 Ribbon 按钮'))
      .setDesc(tr('开关即时生效，不必重载插件'))
      .addToggle((t) => t.setValue(this.plugin.settings.ribbonEnabled)
        .onChange((v) => save('ribbonEnabled', v).then(() => this.plugin.refreshRibbon())));

    new obsidian.Setting(el)
      .setName(tr('左键点击的动作'))
      .setDesc(tr('右键不受此项影响，始终弹出完整菜单'))
      .addDropdown((d) => d
        .addOption('menu', tr('弹出 External Vault 菜单（默认）'))
        .addOption('reveal', tr('直接在文件管理器中打开 External Vault'))
        .addOption('latest', tr('直接打开最近编辑的一篇库外 MD'))
        .setValue(this.plugin.settings.ribbonClickAction)
        .onChange((v) => save('ribbonClickAction', v)));

    new obsidian.Setting(el)
      .setName(tr('菜单里最多列几篇库外 MD'))
      .setDesc(tr('按修改时间倒序，只列库外 MD 目录当前层的文件'))
      .addDropdown((d) => d
        .addOption('10', tr('10 篇'))
        .addOption('20', tr('20 篇（默认）'))
        .addOption('50', tr('50 篇'))
        .addOption('200', tr('200 篇'))
        .setValue(String(this.plugin.settings.ribbonMaxNotes))
        .onChange((v) => save('ribbonMaxNotes', Number(v))));

    new obsidian.Setting(el).setName(tr('插入与新建')).setHeading();

    new obsidian.Setting(el)
      .setName(tr('相对路径写法'))
      .setDesc(tr('默认尖括号：文件名含空格或中文时最稳妥，Obsidian / Typora / VS Code 都认'))
      .addDropdown((d) => d
        .addOption('angle', tr('尖括号 <...>（推荐）'))
        .addOption('encode', tr('百分号编码（%20 等）'))
        .addOption('plain', tr('原样（文件名须无空格）'))
        .setValue(this.plugin.settings.linkStyle)
        .onChange((v) => save('linkStyle', v)));

    new obsidian.Setting(el)
      .setName(tr('拖入时保留原文件名'))
      .setDesc(tr('关闭后所有图片统一命名为「Pasted image 时间戳」；重名自动加 -1、-2'))
      .addToggle((t) => t.setValue(this.plugin.settings.keepOriginalName)
        .onChange((v) => save('keepOriginalName', v)));

    new obsidian.Setting(el).setName(tr('新建库外 MD 模板')).setHeading();

    const tplMode = this.plugin.settings.noteTemplateMode || 'file';
    new obsidian.Setting(el)
      .setName(tr('模板来源'))
      .setDesc(tr('默认套用内置 YAML frontmatter 模板；可换成库内模板文件，或直接写自定义内容'))
      .addDropdown((d) => d
        .addOption('file', tr('模板文件（默认）'))
        .addOption('text', tr('自定义内容'))
        .addOption('none', tr('不用模板'))
        .setValue(tplMode)
        .onChange(async (v) => { await save('noteTemplateMode', v); this.display(); }));

    if (tplMode === 'file') {
      new obsidian.Setting(el)
        .setName(tr('模板文件路径'))
        .setDesc(tr('相对 vault 根目录，也可填绝对路径；留空或读不到时用内置默认 YAML。模板里可用 {{title}}、{{filename}}、{{date}}、{{date:YYYY-MM-DD}}、{{time}}'))
        .addText((t) => t
          .setPlaceholder(tr('（留空使用内置 YAML）'))
          .setValue(this.plugin.settings.noteTemplatePath || '')
          .onChange((v) => save('noteTemplatePath', v)));
    }

    if (tplMode === 'text') {
      new obsidian.Setting(el)
        .setName(tr('自定义模板内容'))
        .setDesc(tr('新建库外 MD 的正文原样写入这里的内容；支持 {{title}}、{{filename}}、{{date}}、{{date:YYYY-MM-DD}}、{{time}}；留空 = 内置默认 YAML'))
        .addTextArea((t) => {
          const box = t.inputEl;
          if (box) {
            box.rows = 8;
            if (box.classList && typeof box.classList.add === 'function') box.classList.add('ev-template-textarea');
            else box.className = 'ev-template-textarea';
          }
          t.setPlaceholder(DEFAULT_NOTE_TEMPLATE_TEXT)
            .setValue(this.plugin.settings.noteTemplateText || '')
            .onChange((v) => save('noteTemplateText', v));
        });
    }

    new obsidian.Setting(el)
      .setName(tr('不用模板时写入标题'))
      .setDesc(tr('仅当「模板来源」选「不用模板」时生效：文件内容自动写一行「# 文件名」；模板模式不会追加标题'))
      .addToggle((t) => t.setValue(this.plugin.settings.writeTitle)
        .onChange((v) => save('writeTitle', v)));

    new obsidian.Setting(el)
      .setName(tr('显示成功提示'))
      .addToggle((t) => t.setValue(this.plugin.settings.showNotice)
        .onChange((v) => save('showNotice', v)));

    new obsidian.Setting(el)
      .setName(tr('调试日志'))
      .setDesc(tr('在开发者控制台打印路径探测、保存位置等信息'))
      .addToggle((t) => t.setValue(this.plugin.settings.debug)
        .onChange((v) => save('debug', v)));

    new obsidian.Setting(el).setName(tr('故障排查')).setHeading();
    el.createEl('p', {
      cls: 'setting-item-description',
      text: tr('插图或右键菜单没生效时，运行命令「诊断：复制当前库外文件信息」，把剪贴板内容发来即可适配。'),
    });
  }

  /** 选中的绝对路径 → 相对 vault 根目录（允许 ../ 到库外、与库同级） */
  toRelative(dir) {
    return toVaultRelative(this.app, dir);
  }
}

/** 简单的单行文本输入弹窗（新建文件夹用） */
class TextPromptModal extends obsidian.Modal {
  constructor(app, title, placeholder, onSubmit) {
    super(app);
    this.titleText = title;
    this.placeholder = placeholder || '';
    this.onSubmit = onSubmit;
    this.value = '';
  }

  onOpen() {
    this.titleEl.setText(this.titleText);
    const el = this.contentEl;
    el.empty();
    const input = el.createEl('input', { type: 'text', placeholder: this.placeholder });
    input.style.width = '100%';
    input.addEventListener('input', () => { this.value = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.submit(); });
    const row = el.createDiv({ cls: 'ev-buttons' });
    const ok = row.createEl('button', { text: tr('确定'), cls: 'mod-cta' });
    ok.addEventListener('click', () => this.submit());
    const cancel = row.createEl('button', { text: tr('取消') });
    cancel.addEventListener('click', () => this.close());
    window.setTimeout(() => input.focus(), 30);
  }

  submit() {
    const v = String(this.value || '').trim();
    if (!v) return;
    this.close();
    Promise.resolve(this.onSubmit(v)).catch(() => {});
  }
}

/** 孤儿附件清理：列出附件目录里没有任何库外笔记引用的文件 */
class OrphanAssetsModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.files = [];
    this.selected = new Set();
    this.listEl = null;
    this.countEl = null;
    this.allBox = null;
  }

  async onOpen() {
    this.titleEl.setText(tr('清理孤儿附件'));
    await this.refresh();
  }

  async refresh() {
    this.files = await this.plugin.findOrphanAssets();
    this.selected.clear();
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    el.addClass('external-vault-modal');
    const head = el.createDiv({ cls: 'ev-files-head' });
    head.createEl('h2', { text: tr('清理孤儿附件') });
    el.createEl('p', {
      cls: 'setting-item-description',
      text: tr('下面这些文件在附件目录里，但没有被任何库外笔记引用。删除会移入系统废纸篓。') +
        ' ' + tr('目录：') + this.plugin.externalAssetDir(),
    });
    const toolbar = el.createDiv({ cls: 'ev-files-toolbar' });
    const all = toolbar.createEl('label', { cls: 'ev-files-all' });
    this.allBox = all.createEl('input', { type: 'checkbox' });
    this.allBox.addEventListener('change', () => {
      if (this.allBox.checked) this.files.forEach((f) => this.selected.add(f.abs));
      else this.selected.clear();
      this.renderList();
    });
    all.createSpan({ text: tr('全选') });
    this.countEl = toolbar.createSpan({ cls: 'ev-files-count', text: '' });
    this.listEl = el.createDiv({ cls: 'ev-files-list' });
    this.renderList();
    const buttons = el.createDiv({ cls: 'ev-buttons' });
    const finder = buttons.createEl('button', { text: tr('打开 Finder'), cls: 'ev-finder-btn' });
    finder.addEventListener('click', () => this.plugin.guard(() => this.plugin.revealExternalAssets()));
    const ok = buttons.createEl('button', { text: tr('删除选中（移入废纸篓）'), cls: 'mod-warning' });
    ok.addEventListener('click', () => this.plugin.guard(() => this.deleteSelected()));
    const close = buttons.createEl('button', { text: tr('关闭') });
    close.addEventListener('click', () => this.close());
    this.updateFooter();
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();
    if (!this.files.length) {
      this.listEl.createDiv({ cls: 'ev-files-empty', text: tr('没有发现孤儿附件') });
      this.updateFooter();
      return;
    }
    for (const f of this.files) {
      const row = this.listEl.createEl('label', { cls: 'ev-files-row' });
      const box = row.createEl('input', { type: 'checkbox' });
      box.checked = this.selected.has(f.abs);
      box.addEventListener('change', () => {
        if (box.checked) this.selected.add(f.abs);
        else this.selected.delete(f.abs);
        this.updateFooter();
      });
      const main = row.createDiv({ cls: 'ev-files-main' });
      main.createDiv({ cls: 'ev-files-name', text: path.basename(f.abs) });
      main.createDiv({ cls: 'ev-files-path', text: f.rel });
      const meta = row.createDiv({ cls: 'ev-files-meta' });
      meta.textContent = formatBytes(f.size) +
        (f.mtime ? ' · ' + new Date(f.mtime).toLocaleString() : '');
    }
    this.updateFooter();
  }

  updateFooter() {
    if (this.countEl) {
      const total = Array.from(this.selected).reduce((n, abs) => {
        const f = this.files.find((x) => x.abs === abs);
        return n + (f ? f.size : 0);
      }, 0);
      this.countEl.textContent = tr('已选') + ' ' + this.selected.size + ' ' + tr('个') +
        ' · ' + formatBytes(total);
    }
    if (this.allBox) {
      this.allBox.checked = this.files.length > 0 &&
        this.files.every((f) => this.selected.has(f.abs));
    }
  }

  async deleteSelected() {
    const list = Array.from(this.selected);
    if (!list.length) return;
    const res = await cutSourceFiles(list, true);
    new obsidian.Notice(
      tr('已删除') + ' ' + res.removed + ' ' + tr('个孤儿附件') +
      (res.failed.length ? '\n' + res.failed.length + ' ' + tr('个删除失败') : ''),
      6000,
    );
    await this.refresh();
  }
}

/** 右侧边栏常驻的库外文件面板 */
class ExternalVaultView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.files = [];
    this.query = '';
    this.listEl = null;
    this.sortMode = 'mtime-desc';
    this.collapseAll = true; // 默认折叠文件夹，避免大量附件把 MD 挤到下面
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'External Vault'; }
  getIcon() { return 'lucide-folder-open'; }

  async onOpen() {
    this.render();
    await this.refresh();
    // 等视图标题栏渲染完成后再插入，否则 querySelector 可能拿不到 .view-header
    window.setTimeout(() => {
      try { this.buildHeaderActions(); } catch (e) { /* noop */ }
    }, 80);
    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.refresh().catch(() => {});
    }));
    this.registerInterval(window.setInterval(() => {
      this.refresh().catch(() => {});
    }, 30000));
  }

  /** 把按钮放进视图标题栏、文件夹图标右侧，随标题栏一起显示/折叠 */
  buildHeaderActions() {
    const bar = document.createElement('div');
    bar.className = 'ev-panel-toolbar-fallback is-visible';
    const addIcon = (icon, label, fn) => {
      const b = document.createElement('div');
      b.className = 'clickable-icon';
      b.setAttribute('aria-label', label);
      b.setAttribute('data-tooltip-position', 'bottom');
      if (obsidian.setIcon) obsidian.setIcon(b, icon);
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    addIcon('lucide-file-plus', tr('新建笔记'), () => this.plugin.guard(() => this.plugin.openNewNoteModal()));
    addIcon('lucide-arrow-down-up', tr('排序'), (e) => this.showSortMenu(e));
    addIcon('lucide-chevrons-up-down', tr('折叠 / 展开'), () => {
      this.collapseAll = !this.collapseAll;
      this.renderList();
    });
    addIcon('lucide-refresh-cw', tr('刷新'), () => { this.refresh().catch(() => {}); });
    addIcon('lucide-folder-open', tr('打开 Finder'), () => this.plugin.guard(() => this.plugin.revealExternalVault()));
    addIcon('lucide-more-horizontal', tr('更多'), (e) => this.showPanelMenu(e));
    this.contentEl.prepend(bar);
  }

  async refresh() {
    try { this.files = await this.plugin.listExternalEntries(); }
    catch (e) { this.files = []; }
    this.renderList();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    el.addClass('ev-panel');
    const head = el.createDiv({ cls: 'ev-panel-head' });
    const search = head.createEl('input', {
      type: 'search', placeholder: tr('搜索'),
    });
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.plugin.ensureExternalContents(this.files)
        .then(() => this.renderList())
        .catch(() => this.renderList());
    });
    this.listEl = el.createDiv({ cls: 'ev-panel-list nav-files-container' });
    this.renderList();
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();
    const q = String(this.query || '').trim().toLowerCase();
    const rows = searchExternalEntries(this.files, q, this.plugin._contentCache);
    if (!rows.length) {
      this.listEl.createDiv({
        cls: 'ev-panel-empty',
        text: this.files.length ? tr('没有匹配的文件') : tr('还没有库外文件'),
      });
      return;
    }
    this.activeAbs = '';
    try {
      const ctx = this.plugin.activeExternalContext();
      if (ctx && ctx.file) this.activeAbs = path.resolve(ctx.file);
    } catch (e) { /* noop */ }
    this.expandAll = !!q || !this.collapseAll; // 搜索时自动展开；「折叠全部」时收起
    this.renderNode(this.buildTree(rows), 0, this.listEl);
  }

  /** 按相对路径建目录树 */
  buildTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = String(f.rel || '').split('/');
      parts.pop();
      let node = root;
      for (const name of parts) {
        if (!name || name === '.') continue;
        if (!node.dirs.has(name)) node.dirs.set(name, { dirs: new Map(), files: [] });
        node = node.dirs.get(name);
      }
      node.files.push(f);
    }
    return root;
  }

  renderNode(node, depth, container) {
    const dirs = Array.from(node.dirs.keys()).sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
    for (const name of dirs) {
      const child = node.dirs.get(name);
      const folderEl = container.createDiv({ cls: 'tree-item nav-folder' });
      const folderTitle = folderEl.createDiv({ cls: 'tree-item-self nav-folder-title' });
      const collapse = folderTitle.createDiv({
        cls: 'tree-item-icon collapse-icon nav-folder-collapse-indicator',
      });
      const startOpen = !!this.expandAll;
      if (obsidian.setIcon) obsidian.setIcon(collapse, startOpen ? 'chevron-down' : 'chevron-right');
      folderTitle.createDiv({ cls: 'tree-item-inner nav-folder-title-content', text: name });
      const children = folderEl.createDiv({ cls: 'tree-item-children nav-folder-children' });
      children.style.display = startOpen ? '' : 'none';
      this.renderNode(child, depth + 1, children);
      let open = startOpen;
      folderTitle.addEventListener('click', () => {
        open = !open;
        children.style.display = open ? '' : 'none';
        folderTitle.classList.toggle('is-collapsed', !open);
        if (obsidian.setIcon) obsidian.setIcon(collapse, open ? 'chevron-down' : 'chevron-right');
      });
    }
    const files = node.files.slice().sort((a, b) => {
      const [key, dir] = String(this.sortMode || 'mtime-desc').split('-');
      let cmp = 0;
      if (key === 'name') {
        cmp = path.basename(a.abs).localeCompare(path.basename(b.abs),
          'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
      } else if (key === 'ctime') {
        cmp = (a.ctime || 0) - (b.ctime || 0);
      } else {
        cmp = (a.mtime || 0) - (b.mtime || 0);
      }
      return dir === 'desc' ? -cmp : cmp;
    });
    for (const f of files) {
      const active = this.activeAbs && path.resolve(f.abs) === this.activeAbs;
      const fileEl = container.createDiv({ cls: 'tree-item nav-file' });
      const title = fileEl.createDiv({
        cls: 'tree-item-self nav-file-title' + (active ? ' ev-active' : ''),
      });
      title.createDiv({ cls: 'ev-panel-bullet', text: active ? '•' : '' });
      const content = title.createDiv({
        cls: 'tree-item-inner nav-file-title-content',
        text: path.basename(f.abs, path.extname(f.abs)),
      });
      const tip = [];
      if (f.mtime) tip.push(tr('最后修改于') + ' ' + fmtDateTime(f.mtime));
      if (f.ctime) tip.push(tr('创建于') + ' ' + fmtDateTime(f.ctime));
      if (tip.length) {
        title.setAttribute('aria-label', tip.join('\n'));
        title.setAttribute('data-tooltip-position', 'right');
      } else {
        content.title = f.rel;
      }
      title.addEventListener('click', () => {
        this.plugin.guard(() => (f.kind === 'md'
          ? this.plugin.openExternalMd(f.abs)
          : this.plugin.openExternalAny(f.abs)));
      });
      title.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showRowMenu(e, f);
      });
    }
  }

  showRowMenu(evt, f) {
    if (!obsidian.Menu) return;
    const menu = new obsidian.Menu();
    const file = { path: 'file:' + f.abs, extension: 'md', getRealPath: () => f.abs };
    menu.addItem((i) => i.setTitle(tr('打开')).setIcon('lucide-file-text')
      .onClick(() => this.plugin.guard(() => this.plugin.openExternalMd(f.abs))));
    menu.addItem((i) => i.setTitle(tr('在 Finder 中显示')).setIcon('lucide-folder-open')
      .onClick(() => this.plugin.guard(() => this.plugin.revealExternalFile(f.abs))));
    if (f.kind === 'md') {
      menu.addItem((i) => i.setTitle(tr('移入 Vault（含附件）')).setIcon('lucide-log-in')
        .onClick(() => this.plugin.guard(() => this.plugin.contextMoveIn(file))));
      menu.addItem((i) => i.setTitle(tr('删除库外 MD（含附件）')).setIcon('lucide-trash')
        .onClick(() => this.plugin.guard(() => this.plugin.promptDeleteExternalNote(file))));
    }
    menu.showAtMouseEvent(evt);
  }

  showSortMenu(evt) {
    if (!obsidian.Menu) return;
    const menu = new obsidian.Menu();
    const add = (title, mode) => menu.addItem((i) => i
      .setTitle(title)
      .setChecked(this.sortMode === mode)
      .onClick(() => { this.sortMode = mode; this.renderList(); }));
    add(tr('文件名 (A-Z)'), 'name-asc');
    add(tr('文件名 (Z-A)'), 'name-desc');
    menu.addSeparator();
    add(tr('编辑时间 (从新到旧)'), 'mtime-desc');
    add(tr('编辑时间 (从旧到新)'), 'mtime-asc');
    menu.addSeparator();
    add(tr('创建时间 (从新到旧)'), 'ctime-desc');
    add(tr('创建时间 (从旧到新)'), 'ctime-asc');
    menu.showAtMouseEvent(evt);
  }

  showPanelMenu(evt) {
    if (!obsidian.Menu) return;
    const menu = new obsidian.Menu();
    menu.addItem((i) => i.setTitle(tr('刷新')).setIcon('lucide-refresh-cw')
      .onClick(() => { this.refresh().catch(() => {}); }));
    menu.addItem((i) => i.setTitle(tr('打开 Finder')).setIcon('lucide-folder-open')
      .onClick(() => this.plugin.guard(() => this.plugin.revealExternalVault())));
    menu.addItem((i) => i.setTitle(tr('清理孤儿附件')).setIcon('lucide-trash-2')
      .onClick(() => this.plugin.guard(() => this.plugin.openOrphanAssetsModal())));
    menu.addItem((i) => i.setTitle(tr('撤销上一次移动')).setIcon('lucide-undo-2')
      .onClick(() => this.plugin.guard(() => this.plugin.undoLastMove())));
    menu.showAtMouseEvent(evt);
  }
}

module.exports = ExternalFileImagePlugin;
