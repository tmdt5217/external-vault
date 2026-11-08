'use strict';

/*
 * external-vault-pxm  v1.10.5
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
 *               attachmentFolderPath，例如 Attachments_all）
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
 * 不再生成 .pxm-transferred/<时间戳>/ 备份目录；删除前会校验所有目标文件已写盘，
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

const LOG = '[external-vault-pxm]';

/** 简易模式内置目录，全部相对 vault 根目录（../ = 与库同级） */
const SIMPLE_MD_REL = '../External Vault';
const SIMPLE_ASSET_REL = '../External Vault/attachments';

/** 新建库外 MD 的默认模板：与核心 Templates 插件的「【YAML】★universal」一致 */
const DEFAULT_NOTE_TEMPLATE_PATH = 'Attachments_all/template/【YAML】★universal.md';
const DEFAULT_NOTE_TEMPLATE_TEXT = '---\ncategory: \ntags: \naliases: \nstars: \n来源:\n---\n\n\n\n\n';

const DEFAULT_SETTINGS = {
  mode: 'simple',                       // 'simple' 免配置 | 'custom' 自定义两个相对目录
  customMdDir: SIMPLE_MD_REL,           // 库外放 MD 的目录（相对 vault 根）
  customAssetDir: SIMPLE_ASSET_REL,     // 库外放图片/附件的目录（相对 vault 根）
  vaultTargetFolder: '',                // 命令面板「转入库」时 MD 放哪个库内文件夹（空 = 根）
  vaultAssetFolder: 'assets',           // 命令面板「转入库」时附件放在目标 MD 目录下的哪个子目录
  handleOtherAttachments: true,         // 拖入非图片文件（PDF 等）也存进附件目录
  moveSourceAfterTransfer: false,       // 命令面板：转移后删除源文件（默认关 = 只复制）
  transferRecursive: false,             // 批量转移时是否包含子文件夹
  cutUseTrash: false,                   // 剪切时移入系统废纸篓（默认关 = 直接从磁盘删除）
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
 *   "Attachments_all" = 库根下的 Attachments_all/
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
function pickDirectory(onPicked) {
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
 * 真剪切：把源文件从原位置移除，不再生成 .pxm-transferred 备份目录。
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

    // ---- 命令面板：所有功能统一用「库外文件：」前缀，输入这四个字即可看到全部 ----
    this.addCommand({
      id: 'new-external-note',
      name: '库外文件：新建 Markdown',
      callback: () => { Promise.resolve(this.openNewNoteModal()).catch((err) => this.reportError(err)); },
    });
    this.addCommand({
      id: 'open-external-vault',
      name: '库外文件：打开 External Vault 菜单',
      callback: () => { this.showExternalVaultMenu(null); },
    });
    this.addCommand({
      id: 'open-latest-external-note',
      name: '库外文件：打开最近编辑的笔记',
      callback: () => this.guard(() => this.openLatestExternalMd()),
    });
    this.addCommand({
      id: 'manage-external-files',
      name: '库外文件：查看全部 / 批量删除',
      callback: () => this.guard(() => this.openExternalFilesModal()),
    });
    this.addCommand({
      id: 'insert-external-link',
      name: '库外文件：插入相对链接（可多选）',
      callback: () => this.guard(() => this.insertExternalLink()),
    });
    this.addCommand({
      id: 'delete-external-note',
      name: '库外文件：删除当前库外 MD（含附件）',
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
      name: '库外文件：移入 Vault（当前文件，含附件）',
      callback: () => this.guard(() => this.transferCurrent('in')),
    });
    this.addCommand({
      id: 'transfer-out-current',
      name: '库外文件：移出 Vault（当前笔记，含附件）',
      callback: () => this.guard(() => this.transferCurrent('out')),
    });
    this.addCommand({
      id: 'transfer-in-folder',
      name: '库外文件：移入 Vault（整个库外目录，含附件）',
      callback: () => this.guard(() => this.transferFolder('in')),
    });
    this.addCommand({
      id: 'transfer-out-folder',
      name: '库外文件：移出 Vault（当前笔记所在文件夹，含附件）',
      callback: () => this.guard(() => this.transferFolder('out')),
    });
    this.addCommand({
      id: 'context-move-out-current',
      name: '库外文件：移出 Vault（右键动作，含附件）',
      callback: () => this.guard(() => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !isMdFileObject(f)) throw new Error('请先打开一个库内 Markdown 笔记');
        return this.contextMoveOut(f);
      }),
    });
    this.addCommand({
      id: 'context-move-in-current',
      name: '库外文件：移入 Vault（右键动作，含附件）',
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
      name: '库外文件：在文件管理器中打开 MD 目录',
      callback: () => this.guard(() => this.revealExternalVault()),
    });
    this.addCommand({
      id: 'reveal-external-assets',
      name: '库外文件：在文件管理器中打开附件目录',
      callback: () => this.guard(() => this.revealExternalAssets()),
    });
    this.addCommand({
      id: 'copy-external-vault-path',
      name: '库外文件：复制 External Vault 路径',
      callback: () => this.guard(async () => {
        const dir = this.externalMdDir();
        await navigator.clipboard.writeText(dir);
        new obsidian.Notice('已复制：' + dir, 4000);
      }),
    });
    this.addCommand({
      id: 'copy-external-assets-path',
      name: '库外文件：复制附件目录路径',
      callback: () => this.guard(async () => {
        const dir = this.externalAssetDir();
        await navigator.clipboard.writeText(dir);
        new obsidian.Notice('已复制：' + dir, 4000);
      }),
    });

    this.addCommand({
      id: 'fix-wiki-image-links',
      name: '库外文件：修复当前笔记的图片链接',
      callback: () => this.guard(() => this.fixWikiImageLinks()),
    });
    this.addCommand({
      id: 'diagnose-external-file',
      name: '库外文件：诊断当前库外文件',
      callback: () => { this.diagnose().catch((err) => this.reportError(err)); },
    });

    this.patchOpenLinkText();
    this.patchFirstLinkpathDest();
    this.setupExternalLinkRendering();

    console.log(LOG, 'loaded v1.10.5', 'md=', this.mdRel(), 'assets=', this.assetRel(),
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

  mdRel() {
    return this.settings.mode === 'custom'
      ? (String(this.settings.customMdDir || '').trim() || SIMPLE_MD_REL)
      : SIMPLE_MD_REL;
  }

  assetRel() {
    return this.settings.mode === 'custom'
      ? (String(this.settings.customAssetDir || '').trim() || SIMPLE_ASSET_REL)
      : SIMPLE_ASSET_REL;
  }

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
      if (el && typeof el.addClass === 'function') el.addClass('pxm-ribbon-external-vault');
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
      add('打开External Vault', 'lucide-folder-open', () => this.revealExternalVault());
      add('打开附件目录', 'lucide-image', () => this.revealExternalAssets());
      add('新建库外MD', 'lucide-file-plus', () => this.openNewNoteModal());
      add('复制External Vault路径', 'lucide-copy', async () => {
        await navigator.clipboard.writeText(mdDir);
        if (this.settings.showNotice) new obsidian.Notice('已复制：' + mdDir);
      });
      add('管理库外文件…', 'lucide-files', () => this.openExternalFilesModal());
      menu.addSeparator();
      const notes = listExternalMdFiles(mdDir, this.settings.ribbonMaxNotes);
      if (!notes.length) {
        add('（这个文件夹里还没有 .md 文件）', null, null, true);
      } else {
        add('最近编辑的库外笔记', null, null, true);
        for (const n of notes) add(n.name, 'lucide-file-text', () => this.openExternalMd(n.abs));
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

  /**
   * 把库内笔记里的链接解析成「库外 MD 的绝对路径」。
   * 支持：../External Vault/x.md（相对当前笔记目录）、file:/绝对路径、绝对路径。
   * 只认库外、存在、扩展名为 md 的目标；其余返回 null，交回 Obsidian 原生逻辑。
   */
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
      if (!ws || typeof ws.openLinkText !== 'function' || ws.__pxmExternalLinkPatched) return;
      const orig = ws.openLinkText.bind(ws);
      this._origOpenLinkText = orig;
      ws.openLinkText = (linktext, sourcePath, newLeaf, openViewState) => {
        const abs = this.externalTargetForLink(linktext, sourcePath);
        if (abs) return this.openExternalMd(abs);
        return orig(linktext, sourcePath, newLeaf, openViewState);
      };
      ws.__pxmExternalLinkPatched = true;
      this.register(() => {
        try {
          if (!ws.__pxmExternalLinkPatched) return;
          ws.openLinkText = orig;
          delete ws.__pxmExternalLinkPatched;
        } catch (e) { /* noop */ }
      });
      this.dbg('openLinkText 已接管库外链接');
    } catch (e) { this.dbg('patch openLinkText 失败', e.message); }
  }

  /**
   * 库外链接的渲染：
   * 1) 保留 internal-link，只附加 pxm-external-link 做视觉区分——这样 Obsidian 仍会
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
          a.classList.add('pxm-external-link');
          a.setAttribute('data-pxm-abs', abs);
          a.setAttribute('title', '库外文件：' + abs);
        }
      } catch (e) { this.dbg('标记库外链接失败', e.message); }
    });

    // 2) 阅读视图点击：由插件打开，源文件里仍是相对链接
    this.registerDomEvent(document, 'click', (e) => {
      const t = e.target;
      const a = t && typeof t.closest === 'function' ? t.closest('a.pxm-external-link') : null;
      if (!a) return;
      const abs = a.getAttribute('data-pxm-abs') ||
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
      const mark = cmView.Decoration.mark({ class: 'pxm-external-link' });
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
      el.classList.add('pxm-external-link');
    }, true);
  }

  /**
   * Hover Editor 和原生预览都用 metadataCache.getFirstLinkpathDest 找目标。
   * 库外文件不在索引里，返回 null 就会被当成「未创建」。
   * 这里在找不到时补一个 TExternalFile，让它们走正常预览流程。
   */
  patchFirstLinkpathDest() {
    try {
      const mc = this.app.metadataCache;
      if (!mc || typeof mc.getFirstLinkpathDest !== 'function' || mc.__pxmExternalResolvePatched) return;
      const orig = mc.getFirstLinkpathDest.bind(mc);
      const cache = new Map();
      mc.getFirstLinkpathDest = (linkpath, sourcePath) => {
        const hit = orig(linkpath, sourcePath);
        if (hit) return hit;
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
      mc.__pxmExternalResolvePatched = true;
      this.register(() => {
        try {
          if (!mc.__pxmExternalResolvePatched) return;
          mc.getFirstLinkpathDest = orig;
          delete mc.__pxmExternalResolvePatched;
        } catch (e) { /* noop */ }
      });
      this.dbg('getFirstLinkpathDest 已接管库外链接');
    } catch (e) { this.dbg('patch getFirstLinkpathDest 失败', e.message); }
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
      path.join(ctx.dir, 'images'), path.join(ctx.dir, 'assets'),
      path.join(ctx.dir, 'Attachments_all')].filter(Boolean);
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
      for (const n of ['Attachments_all', 'attachments', 'Attachments', 'assets', 'images', '附件']) {
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
  async openImportedNote(rel) {
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
          const leaf = typeof ws.getLeaf === 'function' ? ws.getLeaf(false) : null;
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
          try { await options.beforeRemove(plans); } catch (e) { this.dbg('转移前关闭标签页失败', e.message); }
        }
        // 被其他笔记共用的附件只复制、保留原件，避免弄断别人的链接
        const keep = options.keepAssetSources instanceof Set ? options.keepAssetSources : new Set();
        const srcFiles = Array.from(new Set(plans.map((p) => p.src)
          .concat(Array.from(assetMap.keys()).filter((a) => !keep.has(a)))))
          .filter((s) => !destFiles.has(s)); // 源与目标同路径时绝不删
        cut = await cutSourceFiles(srcFiles, !!this.settings.cutUseTrash);
      }
    }

    let opened = false;
    if (direction === 'in') {
      const rel = path.relative(vRoot, plans[0].dest).split(path.sep).join('/');
      opened = await this.openImportedNote(rel);
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
   * 通过 __pxmUpdateMoveOut 把已添加条目的目标升级为数量更多的一组。
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
    const outTitle = (n) => '移出 Vault（含附件）' + (n > 1 ? ' · ' + n + ' 篇' : '');
    /** rawFiles 可为单个 TFile（file-menu）或数组（files-menu） */
    const addMoveOut = (menu, rawFiles) => {
      if (!this.settings.contextMenuEnabled || !menu || typeof menu.addItem !== 'function') return;
      const targets = vaultMdTargets(rawFiles, this.app);
      if (!targets.length) return;
      if (outMenus.has(menu)) {
        if (typeof menu.__pxmUpdateMoveOut === 'function') menu.__pxmUpdateMoveOut(targets);
        return;
      }
      outMenus.add(menu);
      let chosen = targets;
      let itemRef = null;
      // 先挂上更新器：某些版本 addItem 的回调可能是延迟执行的，
      // 这样 files-menu 后到时也能把目标升级成多选，且条目渲染时读到最新 chosen
      try {
        menu.__pxmUpdateMoveOut = (next) => {
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
          .setTitle('移入 Vault（含附件）')
          .setIcon('lucide-log-in')
          .onClick(() => this.guard(() => this.contextMoveIn(file))));
      } catch (e) { this.dbg('添加「移入 Vault」菜单项失败', e.message); }
    };
    const addDelete = (menu, file) => {
      if (!canAdd(menu, delMenus)) return;
      try {
        menu.addItem((item) => item
          .setSection('action')
          .setTitle('删除库外 MD（含附件）')
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
          addMoveIn(menu, file);
          addDelete(menu, file);
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
        if (file && isMdFileObject(file) && isExternalTFile(file)) {
          addMoveIn(menu, file);
          addDelete(menu, file);
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

  /** 文件列表右键（单选 / 多选）：MD → 库外 MD 目录；附件 → 库外附件目录 */
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
    const mdDestDir = this.externalMdDir();
    const assetDestDir = this.externalAssetDir();
    if (!mdDestDir || !assetDestDir) throw new Error('拿不到库外目录，请检查插件设置');
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
      beforeRemove: () => this.detachLeaves((view) => matches(view.file)),
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
      beforeRemove: () => this.detachLeaves(
        (view) => externalAbsFromFile(view.file, this.app) === src),
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

    const mdRes = await cutSourceFiles(list, this.settings.cutUseTrash);
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
    const assetRes = toDelete.length
      ? await cutSourceFiles(toDelete, this.settings.cutUseTrash)
      : { removed: 0, trashed: 0, failed: [] };

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
      plugin: 'external-vault-pxm',
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
      text: (this.plugin.settings.cutUseTrash
        ? '文件会移到系统废纸篓，可从废纸篓找回。'
        : '文件会直接从磁盘删除，不生成备份，不可撤销。') +
        '只删除库外目录里的附件，库内附件一律保留。',
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
    this.mode = this.opts.mode === 'pick' ? 'pick' : 'manage';
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
    const dir = this.plugin.externalMdDir();
    let list = [];
    try { list = await listMarkdownFiles(dir, true, 8); } catch (e) { list = []; }
    this.files = list.map((abs) => {
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { /* noop */ }
      let assets = 0;
      try {
        assets = this.plugin.assetPathsIn(abs)
          .filter((a) => !isInsideVault(a, this.app) && fs.existsSync(a)).length;
      } catch (e) { /* noop */ }
      return {
        abs,
        rel: path.relative(dir, abs).split(path.sep).join('/'),
        mtime: st ? st.mtimeMs : 0,
        assets,
      };
    }).sort((a, b) => b.mtime - a.mtime);
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
    const head = el.createDiv({ cls: 'ev-files-head' });
    head.createEl('h2', { text: picking ? '插入库外文件链接' : '库外文件' });
    const searchWrap = head.createDiv({ cls: 'ev-files-search' });
    const search = searchWrap.createEl('input', {
      type: 'search', placeholder: '搜索文件名或路径…',
    });
    search.value = this.query || '';
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderList();
    });

    el.createEl('p', {
      cls: 'setting-item-description',
      text: picking
        ? '勾选一个或多个文件，点「插入」在光标处生成相对链接（../External Vault/…）；换电脑只要目录结构一致即可继续用。'
        : '目录：' + this.plugin.externalMdDir() + '　共 ' + this.files.length + ' 篇',
    });

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

    this.listEl = el.createDiv({ cls: 'ev-files-list' });
    this.renderList();

    const buttons = el.createDiv({ cls: 'ev-buttons' });
    this.okBtn = buttons.createEl('button', {
      text: picking ? '插入' : '删除选中（含附件）',
      cls: picking ? 'mod-cta' : 'mod-warning',
    });
    this.okBtn.addEventListener('click', () => {
      if (picking) this.commitPick();
      else this.prepareDelete();
    });
    const close = buttons.createEl('button', { text: picking ? '取消' : '关闭' });
    close.addEventListener('click', () => this.close());
    this.updateFooter();
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  /** 当前搜索词过滤后的文件（按名称或相对路径，忽略大小写） */
  filtered() {
    const q = String(this.query || '').trim().toLowerCase();
    if (!q) return this.files;
    return this.files.filter((f) =>
      f.rel.toLowerCase().includes(q) || path.basename(f.abs).toLowerCase().includes(q));
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
    for (const f of rows) {
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
      meta.textContent = (f.assets ? f.assets + ' 个附件' : '无附件') +
        (f.mtime ? ' · ' + new Date(f.mtime).toLocaleString() : '');
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
    el.createEl('h2', { text: '确认删除库外 MD（含附件）' });
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
      text: (this.plugin.settings.cutUseTrash
        ? '文件会移到系统废纸篓，可从废纸篓找回。'
        : '文件会直接从磁盘删除，不生成备份，不可撤销。') +
        '只删除库外目录里的附件；库内附件一律保留。',
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
      .setDesc('开启后源文件从原位置直接删除，不再生成 .pxm-transferred 备份目录，不可撤销；关闭则只复制')
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

    el.createEl('h2', { text: '库外文件图片 / 新建' });
    el.createEl('p', {
      cls: 'setting-item-description',
      text: '编辑库外 MD 时，粘贴 / 拖入的附件自动存进库外附件目录并插入相对路径；库内笔记行为不变。',
    });

    new obsidian.Setting(el).setName('目录模式').setHeading();

    new obsidian.Setting(el)
      .setName('选择方式')
      .setDesc('简易：无需设置任何文件夹；自定义：自己填两个相对目录')
      .addDropdown((d) => d
        .addOption('simple', '简易（默认，无需设置）')
        .addOption('custom', '自定义两个目录')
        .setValue(this.plugin.settings.mode)
        .onChange((v) => { save('mode', v).then(() => this.display()); }));

    el.createEl('p', {
      cls: 'setting-item-description',
      text: '所有目录都相对当前 vault 根目录填写，"../" 表示与库同级。当前库：' + (vaultRoot(this.app) || '（未知）'),
    });

    const mdAbs = this.plugin.externalMdDir();
    const assetAbs = this.plugin.externalAssetDir();
    const relLink = (mdAbs && assetAbs) ? relativeFromMd(mdAbs, assetAbs) : '';
    const preview = el.createDiv({ cls: 'ev-settings-preview' });
    preview.textContent =
      '库外 MD 目录：' + this.plugin.mdRel() + '\n' +
      '        → ' + (mdAbs || '?') + '\n' +
      '库外附件目录：' + this.plugin.assetRel() + '\n' +
      '        → ' + (assetAbs || '?') + '\n' +
      '插入的链接前缀：' + (relLink ? relLink + '/' : './');

    if (this.plugin.settings.mode === 'custom') {
      let mdText;
      new obsidian.Setting(el)
        .setName('库外放 MD 的目录')
        .setDesc('相对 vault 根，例如 ../External Vault；也可写多层，如 ../PBL/notes')
        .addText((t) => {
          mdText = t;
          t.setPlaceholder(SIMPLE_MD_REL)
            .setValue(this.plugin.settings.customMdDir)
            .onChange((v) => save('customMdDir', v.trim()));
        })
        .addButton((b) => b.setButtonText('选择…').onClick(() => {
          pickDirectory((dir) => {
            const v = this.toRelative(dir);
            mdText.setValue(v);
            save('customMdDir', v).then(() => this.display());
          });
        }));

      let assetText;
      new obsidian.Setting(el)
        .setName('库外放附件的目录')
        .setDesc('相对 vault 根，例如 ../External Vault/attachments')
        .addText((t) => {
          assetText = t;
          t.setPlaceholder(SIMPLE_ASSET_REL)
            .setValue(this.plugin.settings.customAssetDir)
            .onChange((v) => save('customAssetDir', v.trim()));
        })
        .addButton((b) => b.setButtonText('选择…').onClick(() => {
          pickDirectory((dir) => {
            const v = this.toRelative(dir);
            assetText.setValue(v);
            save('customAssetDir', v).then(() => this.display());
          });
        }));

      el.createEl('p', {
        cls: 'setting-item-description',
        text: '「选择…」会把手选的绝对路径自动换算成相对 vault 根的写法；请选一个「里面至少有一个文件」的文件夹，空文件夹请直接手输。两个目录改动后，插入的链接前缀会自动重算。',
      });
    } else {
      el.createEl('p', {
        cls: 'setting-item-description',
        text: '简易模式固定使用与库同级的 External Vault/ 放 MD、External Vault/attachments/ 放附件；插件加载时自动创建，不需要选任何文件夹。',
      });
    }

    new obsidian.Setting(el)
      .setName('接管非图片附件')
      .setDesc('开启后拖入 PDF、docx、zip 等文件也存进附件目录并插入 [文件名](相对路径)；.md/.txt 等笔记类不接管')
      .addToggle((t) => t.setValue(this.plugin.settings.handleOtherAttachments)
        .onChange((v) => save('handleOtherAttachments', v)));

    // 「一键转移（连附件）」这一组设置已从面板移除：它只影响命令面板的 4 个旧命令。
    // 这些命令仍按 DEFAULT_SETTINGS 的固定默认值运行；唯一对右键菜单也生效的
    // 「剪切时移入系统废纸篓」已移到下面的「右键菜单」组。

    new obsidian.Setting(el).setName('右键菜单：移出 / 移入 Vault').setHeading();
    el.createEl('p', {
      cls: 'setting-item-description',
      text: '库内笔记右键 →「移出 Vault」（支持多选）；库外标签页右键 →「移入 Vault」。附件随 MD 一起搬走并重写相对路径，笔记双链、网络图片不动。命令面板的「转入库 / 移出库」旧命令沿用固定默认规则。',
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
      '移出 Vault：MD → ' + (mdAbs || '?') + '\n' +
      '             附件 → ' + (assetAbs || '?') + '\n' +
      '移入 Vault：MD → ' + inMdDir + '\n' +
      '             附件 → ' + inAsset.dir + '\n' +
      '库内默认附件夹配置：' + (attachmentFolderSetting(this.app) || '（未配置，回退 assets）') +
      '\nTExternalFile 类：' + (obsidian.TExternalFile ? '可用' : '不可用（走路径兜底）');

    new obsidian.Setting(el)
      .setName('显示右键菜单项')
      .setDesc('关掉后两个右键菜单里都不再出现本插件的条目')
      .addToggle((t) => t.setValue(this.plugin.settings.contextMenuEnabled)
        .onChange((v) => save('contextMenuEnabled', v)));

    new obsidian.Setting(el)
      .setName('移入 Vault：MD 目标文件夹')
      .setDesc('相对 vault 根目录；留空 = 库根目录（默认）')
      .addText((t) => t.setPlaceholder('（库根目录）')
        .setValue(this.plugin.settings.contextMenuVaultMdFolder)
        .onChange((v) => save('contextMenuVaultMdFolder', v.trim()).then(() => this.display())));

    new obsidian.Setting(el)
      .setName('移入 Vault：附件放到库内默认附件文件夹')
      .setDesc('读取 设置 → 文件与链接 → 默认附件位置（当前为 ' +
        (attachmentFolderSetting(this.app) || '/') + '）；关闭则放到目标 MD 目录下的 assets 子目录')
      .addToggle((t) => t.setValue(this.plugin.settings.contextMenuUseDefaultAttachmentFolder)
        .onChange((v) => save('contextMenuUseDefaultAttachmentFolder', v).then(() => this.display())));

    new obsidian.Setting(el)
      .setName('移入 / 移出后剪切源文件（删除原件）')
      .setDesc('默认开 = 真正剪切，源文件从原位置直接删除，不生成 .pxm-transferred 备份目录；关闭则只复制。想留后路可开启下面的「剪切时移入系统废纸篓」')
      .addToggle((t) => t.setValue(this.plugin.settings.contextMenuMoveSource)
        .onChange((v) => save('contextMenuMoveSource', v)));

    new obsidian.Setting(el)
      .setName('剪切时移入系统废纸篓')
      .setDesc('默认关 = 直接从磁盘删除；开启后源文件移入系统废纸篓，可找回。对右键菜单和命令面板同时生效')
      .addToggle((t) => t.setValue(this.plugin.settings.cutUseTrash)
        .onChange((v) => save('cutUseTrash', v)));

    el.createEl('p', {
      cls: 'setting-item-description',
      text: '安全处理：删除源文件前会先确认所有目标文件已写盘；被其他笔记共用的附件只复制、保留原件。注意：移出 Vault 后库内其他笔记指向该笔记的 [[双链]] 会失效，直接删除不可撤销。',
    });

    new obsidian.Setting(el).setName('Ribbon 按钮：打开 External Vault').setHeading();
    el.createEl('p', {
      cls: 'setting-item-description',
      text: '左键默认弹出菜单，右键始终弹出完整菜单；目录路径见上方「目录模式」。',
    });

    new obsidian.Setting(el)
      .setName('显示 Ribbon 按钮')
      .setDesc('开关即时生效，不必重载插件')
      .addToggle((t) => t.setValue(this.plugin.settings.ribbonEnabled)
        .onChange((v) => save('ribbonEnabled', v).then(() => this.plugin.refreshRibbon())));

    new obsidian.Setting(el)
      .setName('左键点击的动作')
      .setDesc('右键不受此项影响，始终弹出完整菜单')
      .addDropdown((d) => d
        .addOption('menu', '弹出 External Vault 菜单（默认）')
        .addOption('reveal', '直接在文件管理器中打开 External Vault')
        .addOption('latest', '直接打开最近编辑的一篇库外 MD')
        .setValue(this.plugin.settings.ribbonClickAction)
        .onChange((v) => save('ribbonClickAction', v)));

    new obsidian.Setting(el)
      .setName('菜单里最多列几篇库外 MD')
      .setDesc('按修改时间倒序，只列库外 MD 目录当前层的文件')
      .addDropdown((d) => d
        .addOption('10', '10 篇')
        .addOption('20', '20 篇（默认）')
        .addOption('50', '50 篇')
        .addOption('200', '200 篇')
        .setValue(String(this.plugin.settings.ribbonMaxNotes))
        .onChange((v) => save('ribbonMaxNotes', Number(v))));

    new obsidian.Setting(el).setName('插入与新建').setHeading();

    new obsidian.Setting(el)
      .setName('相对路径写法')
      .setDesc('默认尖括号：文件名含空格或中文时最稳妥，Obsidian / Typora / VS Code 都认')
      .addDropdown((d) => d
        .addOption('angle', '尖括号 <...>（推荐）')
        .addOption('encode', '百分号编码（%20 等）')
        .addOption('plain', '原样（文件名须无空格）')
        .setValue(this.plugin.settings.linkStyle)
        .onChange((v) => save('linkStyle', v)));

    new obsidian.Setting(el)
      .setName('拖入时保留原文件名')
      .setDesc('关闭后所有图片统一命名为「Pasted image 时间戳」；重名自动加 -1、-2')
      .addToggle((t) => t.setValue(this.plugin.settings.keepOriginalName)
        .onChange((v) => save('keepOriginalName', v)));

    new obsidian.Setting(el).setName('新建库外 MD 模板').setHeading();

    const tplMode = this.plugin.settings.noteTemplateMode || 'file';
    new obsidian.Setting(el)
      .setName('模板来源')
      .setDesc('默认套用库里的「【YAML】★universal」；可换成别的模板文件，或直接写自定义内容')
      .addDropdown((d) => d
        .addOption('file', '模板文件（默认）')
        .addOption('text', '自定义内容')
        .addOption('none', '不用模板')
        .setValue(tplMode)
        .onChange(async (v) => { await save('noteTemplateMode', v); this.display(); }));

    if (tplMode === 'file') {
      new obsidian.Setting(el)
        .setName('模板文件路径')
        .setDesc('相对 vault 根目录，也可填绝对路径；留空或读不到时用内置默认 YAML。模板里可用 {{title}}、{{filename}}、{{date}}、{{date:YYYY-MM-DD}}、{{time}}')
        .addText((t) => t
          .setPlaceholder(DEFAULT_NOTE_TEMPLATE_PATH)
          .setValue(this.plugin.settings.noteTemplatePath || '')
          .onChange((v) => save('noteTemplatePath', v)));
    }

    if (tplMode === 'text') {
      new obsidian.Setting(el)
        .setName('自定义模板内容')
        .setDesc('新建库外 MD 的正文原样写入这里的内容；支持 {{title}}、{{filename}}、{{date}}、{{date:YYYY-MM-DD}}、{{time}}；留空 = 内置默认 YAML')
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
      .setName('不用模板时写入标题')
      .setDesc('仅当「模板来源」选「不用模板」时生效：文件内容自动写一行「# 文件名」；模板模式不会追加标题')
      .addToggle((t) => t.setValue(this.plugin.settings.writeTitle)
        .onChange((v) => save('writeTitle', v)));

    new obsidian.Setting(el)
      .setName('显示成功提示')
      .addToggle((t) => t.setValue(this.plugin.settings.showNotice)
        .onChange((v) => save('showNotice', v)));

    new obsidian.Setting(el)
      .setName('调试日志')
      .setDesc('在开发者控制台打印路径探测、保存位置等信息')
      .addToggle((t) => t.setValue(this.plugin.settings.debug)
        .onChange((v) => save('debug', v)));

    new obsidian.Setting(el).setName('故障排查').setHeading();
    el.createEl('p', {
      cls: 'setting-item-description',
      text: '插图或右键菜单没生效时，运行命令「诊断：复制当前库外文件信息」，把剪贴板内容发来即可适配。',
    });
  }

  /** 选中的绝对路径 → 相对 vault 根目录（允许 ../ 到库外、与库同级） */
  toRelative(dir) {
    return toVaultRelative(this.app, dir);
  }
}

module.exports = ExternalFileImagePlugin;
