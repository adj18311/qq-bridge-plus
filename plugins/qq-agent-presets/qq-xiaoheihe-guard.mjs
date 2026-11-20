// 小黑盒 MCP 的「本地媒体路径」硬边界。
//
// 为什么需要这个文件
// ------------------
// QQ 预设只放行 12 个精确的 `mcp__xiaoheihe__*` 工具（名字白名单在
// qq-tool-restrict.mjs 里，本文件不负责授权）。但其中 4 个工具会把字符串参数
// 当成**本机文件路径**交给 Playwright 代模型读取/上传：
//
//   publish_content  images[]                         → File.Exists + SetFilesAsync
//   publish_article  content 里的图片绝对路径          → ArticlePublishService.ParseContentWithImages
//                    （服务层还支持 args.Images，HTTP 工具当前未声明；本守卫仍防御性校验）
//   publish_video    videoPath / coverImagePath       → File.Exists + SetFilesAsync
//   post_comment     images[]                         → File.Exists + SetFilesAsync
//
// 模型本身没有本地 FS 工具，但**有**这 4 个工具 —— 只要把任意本机绝对路径塞进
// 参数，小黑盒 MCP（跑在浏览器进程里）就会替它读文件。因此"只用专用素材目录"
// 不能只写在提示词里，必须在执行期兜底，否则等于借小黑盒绕开 QQ 会话的
// 本地文件隔离（凭据、Cookie、聊天记录、用户任意文件都可能被上传到公网）。
//
// 契约
// ----
//   guardXiaoheiheArguments(exec, options?) → string | undefined
//     exec    = { name, arguments }
//     options = { root? }   // 测试注入用；生产不传
//   返回 undefined  = 放行（或不属于本守卫的职责）
//   返回 string     = 中文拒绝原因（**不含**原始参数值/路径/凭据，避免二次泄露）
//
// 分工（重要）
// ------------
// - 非 `mcp__xiaoheihe__` 名称：一律返回 undefined（其它守卫/白名单负责）。
// - 未知 `mcp__xiaoheihe__*` 名称：同样返回 undefined。12 个原名由
//   qq-tool-restrict.mjs 的精确白名单负责拒绝，本文件不重复授权逻辑。
// - 只读/登录类工具（check_login_status、search_content……）：无本地路径语义，
//   返回 undefined（不读取、不校验）。
//
// 素材目录
// --------
//   root = options.root
//        || process.env.XIAOHEIHE_MEDIA_ROOT
//        || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
//                     'xiaoheihe-media')
// 目录由管理员自行创建并放素材；本守卫**不创建**目录（mkdir 是副作用，
// 且自动创建会掩盖配置错误）。目录不存在时，任何带路径的上传都会被拒。
//
// 放行规则（针对已声明的路径字段）
// --------------------------------
//   1. 必须是非空字符串（数组字段必须是字符串数组，否则直接拒）；
//   2. 必须是本地绝对路径：盘符绝对路径 `X:\...` 或 `X:/...`（参数直传时两者
//      Win32/Playwright 都认）；拒绝相对路径、盘符相对路径（`C:foo`）、
//      单斜杠/反斜杠根路径、UNC/网络路径、URL、file://；
//   3. 首尾不得有空白，不得含控制字符（避免 Normalize 后语义漂移）；
//   4. 后缀必须匹配字段类型：
//        图片 png/jpg/jpeg/gif/webp/bmp（与上游 ArticlePublishService 的 exts 一致）
//        视频 mp4/mov/m4v/avi/mkv/webm/flv/wmv/mpg/mpeg
//      后缀大小写不敏感；
//   5. 必须存在、必须是普通文件（不是目录/设备/FIFO），且**不是符号链接**；
//   6. realpath 之后必须仍在专用素材目录的 realpath 之内（防 `..` 越界、
//      防父目录符号链接/junction 逃逸、防跨盘）；
//   7. 只做 lstat/stat/realpath —— **绝不读文件内容**，不写文件，不联网。
//
// publish_article.content 的图片路径识别
// --------------------------------------
// 上游 ArticlePublishService.ParseContentWithImages 用两条正则（.NET，大小写敏感）：
//
//   exts        = png|jpg|jpeg|gif|webp|bmp
//   winPattern  = [a-zA-Z]:\\[^\r\n"']+?\.(exts)          // 反斜杠盘符路径，允许空格
//   posixPattern= /(?:[^\s"']+/)*[^\s"']+\.(exts)         // 任何 / 开头的片段
//
// 它随后把匹配到的字符串直接交给 `chooser.SetFilesAsync(path)`，所以：
//   · 正文里的 `C:\任意目录\任意图.png`（包括 markdown `![](...)`、带空格路径）
//     会被原样读取 —— 必须逐个校验；
//   · 正文里的 `/任意/路径.png` 会被 **当前盘符根** 解析，无法证明仍在素材目录内，
//     因此本守卫明确拒绝这种形式（"不支持的表达式可以明确拒绝"）；
//   · `D:/.../a.png` 这种正斜杠盘符路径：winPattern 不匹配，posixPattern 只会截出
//     `/.../a.png`（丢掉盘符），服务端实际读的是另一个路径 —— 同样拒绝；
//   · `file://` 无法被上游正则还原成本地绝对路径 —— 拒绝；
//   · 普通网页链接（非图片后缀）是正常正文内容，应当放行；
//   · **图片 URL 一律拒绝**：上游 posixPattern 会把 URL 里的 `/.../a.png` 片段当成
//     本地路径（实测 `https://Pictures/private.png` 会截出 `//Pictures/private.png`，
//     Windows 按 UNC；单斜杠片段按当前盘符根解释），无法证明它不会读到专用目录
//     之外（也不能假设 File.Exists 一定失败），因此图片 URL 明确告知"表达式暂不支持"，
//     图片必须改用专用素材目录内的本地绝对路径。普通非图片链接不受影响。
//     实现上：含图片后缀的 http(s) URL 先整体拒绝，其余 http(s) URL 再做等长
//     空格屏蔽后扫描本地路径片段，避免把普通链接误伤成路径。
// 本守卫的扫描是上述两条正则的**保守超集**（大小写不敏感、包含 UNC/正斜杠/
// file:///图片 URL 的检测），宁可多拒，不放过服务端可能读取的本地路径。
//
// 已知不做的事
// ------------
// - 不实现任何新的小黑盒动作，不加人工确认，不改工具白名单；
// - 不处理 publish_content/post_comment/reply_comment 的 content 文本
//   （上游只把它们键入编辑器，不解析本地路径）；
// - 不读文件内容，不猜测文件类型/MIME（只看后缀，和上游行为对齐）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NAMESPACE_PREFIX = 'mcp__xiaoheihe__'

/** 上游 ArticlePublishService.ParseContentWithImages 支持的图片后缀。 */
const IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
/** 视频上传的常见本地后缀（与图床/播放器常见格式一致）。 */
const VIDEO_EXTENSIONS = Object.freeze([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.mpg', '.mpeg',
])
const IMAGE_EXT_SET = new Set(IMAGE_EXTENSIONS)
const VIDEO_EXT_SET = new Set(VIDEO_EXTENSIONS)

/** 无本地路径语义的小黑盒工具：只读/登录/文本互动，不需要路径校验。 */
const XIAOHEIHE_PATHLESS_TOOLS = new Set([
  'check_login_status',
  'interactive_login',
  'get_login_qr_code',
  'get_user_profile',
  'get_home_content',
  'search_content',
  'get_post_detail',
  'reply_comment',
])

/**
 * 带本地路径语义的小黑盒工具 → 字段规则。
 * kind: image / video（后缀集合）；article 表示需要扫描正文里的图片路径。
 * type: array 表示字段是字符串数组；缺省表示单字符串。
 *
 * publish_article.images 是**防御性**校验：当前 HTTP 工具的 schema 没有该参数，
 * 但服务层 PublishArticleArgs 有 Images 字段，且旧/未来版本可能暴露；多校验
 * 一个同名字段不会影响正常文章发布（缺省时直接跳过）。
 */
const XIAOHEIHE_MEDIA_FIELDS = Object.freeze({
  publish_content: Object.freeze([
    Object.freeze({ field: 'images', kind: 'image', type: 'array' }),
  ]),
  publish_article: Object.freeze([
    Object.freeze({ field: 'content', kind: 'article' }),
    Object.freeze({ field: 'images', kind: 'image', type: 'array' }),
  ]),
  publish_video: Object.freeze([
    Object.freeze({ field: 'videoPath', kind: 'video' }),
    Object.freeze({ field: 'coverImagePath', kind: 'image' }),
  ]),
  post_comment: Object.freeze([
    Object.freeze({ field: 'images', kind: 'image', type: 'array' }),
  ]),
})

// ── 拒绝原因（静态中文模板，绝不拼接原始参数值） ─────────────────────────────

const DETAIL = Object.freeze({
  typeArray: '必须是本地路径字符串数组',
  typeString: '必须是字符串路径',
  empty: '不能是空字符串',
  whitespace: '首尾不能包含空白字符',
  control: '包含非法控制字符',
  url: '不接受 URL，请先由管理员把素材放入专用目录',
  fileUrl: '不接受 file:// 形式，请使用本地绝对路径',
  unc: '不接受网络/UNC 路径',
  rooted: '不接受以单个斜杠或反斜杠开头的路径，请使用盘符绝对路径',
  driveRelative: '不接受盘符相对路径（如 C:foo.png），请使用盘符绝对路径',
  relative: '必须是本地绝对路径',
  outside: '必须位于小黑盒专用素材目录内',
  missing: '指向的文件不存在',
  notFile: '必须指向普通文件而不是目录/设备',
  symlink: '不接受符号链接',
  statFailed: '无法读取该路径的文件信息',
  rootMissing: '小黑盒专用素材目录不存在（请管理员先创建目录并放入素材）',
  rootNotDir: '小黑盒专用素材目录不可用',
  imageExt: `图片只允许本地图片后缀 ${IMAGE_EXTENSIONS.join(' / ')}`,
  videoExt: `视频只允许本地视频后缀 ${VIDEO_EXTENSIONS.join(' / ')}`,
  articleForwardSlash: '只接受反斜杠形式的盘符绝对路径，不接受正斜杠形式（服务端会把 / 开头的片段按当前盘符解释）',
  articleRooted: '只接受反斜杠形式的盘符绝对路径，不接受以 / 开头的路径（服务端会按当前盘符解释）',
  articleFileUrl: '不接受 file:// 形式，请直接在正文里写反斜杠盘符绝对路径',
  articleUnc: '不接受网络/UNC 路径',
  articleImageUrl: '不接受 http(s) 图片 URL：上游会把 URL 里的 /... 图片片段按本地路径尝试读取（当前盘符根/UNC 歧义），该表达式暂不支持；图片请改用专用素材目录内的本地绝对路径',
})

/** 统一的中文拒绝文案：只包含工具名/字段名（schema 名）与静态规则，不含参数值。 */
function reject(tool, field, detail) {
  return `小黑盒工具 ${tool} 的 ${field} ${detail}；素材只允许由管理员预放在小黑盒专用素材目录内，已拒绝。`
}

// ── 素材目录解析 ──────────────────────────────────────────────────────────────

/** 默认素材根：XIAOHEIHE_MEDIA_ROOT → DSH_HOME/xiaoheihe-media → ~/.dsh/xiaoheihe-media。 */
function defaultMediaRoot() {
  const explicit = process.env.XIAOHEIHE_MEDIA_ROOT
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const dshHome = process.env.DSH_HOME
  const base = typeof dshHome === 'string' && dshHome.trim() !== ''
    ? dshHome.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(base, 'xiaoheihe-media')
}

/** options.root 优先于环境变量；只做解析，不创建目录。 */
function mediaRootFromOptions(options) {
  if (options && typeof options === 'object') {
    const injected = options.root
    if (typeof injected === 'string' && injected.trim() !== '') return path.resolve(injected.trim())
  }
  return path.resolve(defaultMediaRoot())
}

/**
 * realpath：优先使用 native 实现。
 * 关键差异（Windows）：`fs.realpathSync` 的 JS 实现**不解析目录 junction**，
 * 只有 `realpathSync.native` 会解析 —— 不解析就等于 symlink/junction 逃逸
 * 检测失效（见测试「父目录 junction 指向素材目录外」）。
 */
function realPathOf(target) {
  if (typeof fs.realpathSync.native === 'function') return fs.realpathSync.native(target)
  return fs.realpathSync(target)
}

/** 每个 guard 调用一个懒加载上下文：避免无路径的调用去 stat 素材目录。 */
function createContext(options) {
  return { rootPath: undefined, rootReal: undefined, rootError: undefined }
}

function loadRoot(context, options) {
  if (context.rootPath !== undefined) return context
  context.rootPath = mediaRootFromOptions(options)
  try {
    const stat = fs.statSync(context.rootPath)
    if (!stat.isDirectory()) {
      context.rootError = DETAIL.rootNotDir
      return context
    }
    context.rootReal = realPathOf(context.rootPath)
  } catch (error) {
    context.rootError = error && error.code === 'ENOENT' ? DETAIL.rootMissing : DETAIL.rootNotDir
  }
  return context
}

// ── 路径字符串分类 ────────────────────────────────────────────────────────────

/**
 * 对「显式参数里的路径字符串」做形态分类。返回 code：
 * type / empty / whitespace / control / url / file-url / unc / rooted /
 * drive-relative / absolute / relative。
 * 只判形态，不碰文件系统。
 */
function classifyArgumentPath(value) {
  if (typeof value !== 'string') return 'type'
  if (value.length === 0) return 'empty'
  if (value.trim() !== value) return 'whitespace'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'control'
  if (/^file:(?:\/\/|\/)/i.test(value)) return 'file-url'
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return 'url'
  if (/^[\\/]{2}/.test(value)) return 'unc'
  if (/^[\\/]/.test(value)) return 'rooted'
  if (/^[A-Za-z]:/.test(value)) {
    if (!/^[A-Za-z]:[\\/]/.test(value)) return 'drive-relative'
    return 'absolute'
  }
  return 'relative'
}

/** 分类码 → 中文细节（absolute 不在此表）。 */
const CLASSIFICATION_DETAIL = Object.freeze({
  type: DETAIL.typeString,
  empty: DETAIL.empty,
  whitespace: DETAIL.whitespace,
  control: DETAIL.control,
  url: DETAIL.url,
  'file-url': DETAIL.fileUrl,
  unc: DETAIL.unc,
  rooted: DETAIL.rooted,
  'drive-relative': DETAIL.driveRelative,
  relative: DETAIL.relative,
})

// ── 真实路径包含关系 ──────────────────────────────────────────────────────────

/** childReal 是否位于 rootReal 内（自身不算；Windows 下大小写不敏感）。 */
function isRealPathInside(rootReal, childReal) {
  const caseFold = process.platform === 'win32'
  const root = caseFold ? rootReal.toLowerCase() : rootReal
  const child = caseFold ? childReal.toLowerCase() : childReal
  const rel = path.relative(root, child)
  if (rel === '') return false // 等于根目录本身（应为目录，文件校验会先拒）
  if (path.isAbsolute(rel)) return false // 跨盘
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !rel.startsWith('../')
}

/**
 * 校验一个已确认形态为「盘符绝对路径」的本地文件。
 * 返回 undefined 表示放行；返回中文细节字符串表示拒绝。
 * 只调用 lstat / realpath / stat，**不读取文件内容**。
 */
function validateAbsoluteLocalFile(rawPath, kind, context, options) {
  const ext = path.extname(rawPath).toLowerCase()
  const allowed = kind === 'video' ? VIDEO_EXT_SET : IMAGE_EXT_SET
  if (!allowed.has(ext)) return kind === 'video' ? DETAIL.videoExt : DETAIL.imageExt

  const loaded = loadRoot(context, options)
  if (loaded.rootError) return loaded.rootError

  const resolved = path.resolve(rawPath)
  let linkStat
  try {
    linkStat = fs.lstatSync(resolved)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return DETAIL.missing
    return DETAIL.statFailed
  }
  if (linkStat.isSymbolicLink()) return DETAIL.symlink
  if (linkStat.isDirectory()) return DETAIL.notFile
  if (!linkStat.isFile()) return DETAIL.notFile

  let realPath
  try {
    realPath = realPathOf(resolved)
  } catch {
    return DETAIL.statFailed
  }
  let realStat
  try {
    realStat = fs.statSync(realPath)
  } catch {
    return DETAIL.statFailed
  }
  if (!realStat.isFile()) return DETAIL.notFile
  if (!isRealPathInside(loaded.rootReal, realPath)) return DETAIL.outside
  return undefined
}

/** 校验显式参数里的单条路径（数组元素或单字符串字段）。 */
function validateArgumentPath(tool, field, value, kind, context, options) {
  const code = classifyArgumentPath(value)
  if (code !== 'absolute') return reject(tool, field, CLASSIFICATION_DETAIL[code])
  const detail = validateAbsoluteLocalFile(value, kind, context, options)
  return detail ? reject(tool, field, detail) : undefined
}

// ── publish_article.content 扫描 ──────────────────────────────────────────────

/** 把 http(s) URL 片段替换成等长空格：保留索引、但不再参与"/ 开头"本地路径扫描。 */
function maskHttpUrls(content) {
  return content.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (match) => ' '.repeat(match.length))
}

/** 提取 http(s) URL 片段文本（用于判断"图片 URL 歧义"，不读取任何内容）。 */
function collectHttpUrls(content) {
  return [...content.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)].map((match) => match[0])
}

/** URL 文本里是否含图片后缀（上游 posixPattern 会从 URL 中截出该片段当本地路径）。 */
const URL_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)/i

/**
 * 扫描文章正文里上游可能读取的图片路径。
 * 返回 undefined（放行）或中文拒绝原因。匹配范围是上游两条正则的保守超集：
 *   · 反斜杠盘符路径：逐个按「专用目录内已有普通图片」校验；
 *   · 正斜杠盘符路径 / 单斜杠开头路径 / UNC / file:// / 图片 URL：明确拒绝
 *     （上游对它们的解析结果与用户书写意图不一致，无法证明仍在专用目录内）。
 *   · 普通网页链接（不含图片后缀）放行；含图片后缀的 http(s) URL 视为上游
 *     posixPattern 的本地读取歧义，明确拒绝并说明"表达式暂不支持"。
 * 注意：函数内新建正则对象，不使用带 lastIndex 的共享状态。
 */
function validateArticleContent(tool, content, context, options) {
  if (content === undefined || content === null) return undefined
  if (typeof content !== 'string') return reject(tool, 'content', DETAIL.typeString)

  const field = 'content 中的图片路径'

  // file://：上游正则无法还原为盘符绝对路径，明确拒绝（普通非图片 https 不受影响）。
  if (/\bfile:(?:\/\/|\/)/i.test(content)) return reject(tool, field, DETAIL.articleFileUrl)

  // 图片 URL 歧义：**必须拒绝**，不能假设 File.Exists 一定失败。
  // 上游 posixPattern 会从 http(s) 链接文本里截出 `/...图片后缀` 片段当成本地路径
  // 交给 SetFilesAsync（实测 `https://Pictures/private.png` → `//Pictures/private.png`，
  // Windows 按 UNC 解释；单斜杠片段则会落到当前盘符根）。无论哪种，都无法证明仍在
  // 专用素材目录内，所以图片 URL 表达式一律"暂不支持"；普通非图片链接照常放行。
  for (const url of collectHttpUrls(content)) {
    if (URL_IMAGE_EXT_RE.test(url)) return reject(tool, field, DETAIL.articleImageUrl)
  }

  const masked = maskHttpUrls(content)

  // 1) 正斜杠盘符路径（D:/...）：上游 winPattern 不认，posixPattern 会截断盘符。
  //    只扫 URL 屏蔽后的文本，避免把 https:// 里的 "s:/" 误判成盘符。
  const forwardSlashDrive = /[A-Za-z]:\/[^\r\n"']+?\.(?:png|jpe?g|gif|webp|bmp)/gi
  for (const _match of masked.matchAll(forwardSlashDrive)) {
    return reject(tool, field, DETAIL.articleForwardSlash)
  }

  // 2) UNC / 网络路径、设备路径（\\server\share\x.png、\\?\C:\x.png）。
  //    扫**原始正文**作纵深防御：含图片后缀的 URL 已在上一步按"图片 URL"拒绝，
  //    这里保证即使 URL 规则将来调整，也不会漏掉 URL 文本里的 UNC 表达式。
  const uncPath = /\\\\[^\r\n"']+?\.(?:png|jpe?g|gif|webp|bmp)/gi
  for (const _match of content.matchAll(uncPath)) {
    return reject(tool, field, DETAIL.articleUnc)
  }

  // 3) 任何 "/" 开头的片段（上游 posixPattern 会按当前盘符解析）。
  //    只扫 URL 屏蔽后的文本：普通网页 https 链接必须放行（需求明确要求），
  //    其 /path.png 片段属于 URL 内容，不当作本地路径处理。
  const rootedPath = /\/[^\s"']+?\.(?:png|jpe?g|gif|webp|bmp)/gi
  for (const _match of masked.matchAll(rootedPath)) {
    return reject(tool, field, DETAIL.articleRooted)
  }

  // 4) 反斜杠盘符路径：与服务端读取行为一致，逐个按素材目录规则校验。
  //    必须扫**原始正文**作纵深防御 —— winPattern 不区分 URL，会从 http(s) 链接
  //    文本里直接抠出 `C:\...\x.png`（含图片后缀的 URL 已在上一步拒绝，此处
  //    保证"URL 规则"与"本地路径规则"不互相依赖）。
  const backslashDrive = /[A-Za-z]:\\[^\r\n"']+?\.(?:png|jpe?g|gif|webp|bmp)/gi
  const candidates = [...content.matchAll(backslashDrive)].map((match) => match[0])
  const seen = new Set()
  for (const candidate of candidates) {
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const detail = validateAbsoluteLocalFile(candidate, 'image', context, options)
    if (detail) return reject(tool, field, detail)
  }
  return undefined
}

// ── 字段级校验 ────────────────────────────────────────────────────────────────

function validateMediaField(tool, rule, value, context, options) {
  if (rule.kind === 'article') return validateArticleContent(tool, value, context, options)

  if (rule.type === 'array') {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) return reject(tool, rule.field, DETAIL.typeArray)
    for (const item of value) {
      if (typeof item !== 'string') return reject(tool, rule.field, DETAIL.typeArray)
      const reason = validateArgumentPath(tool, rule.field, item, rule.kind, context, options)
      if (reason) return reason
    }
    return undefined
  }

  // 单字符串字段：缺省/空串视为"没有路径"，不产生本地读取（交服务端处理参数错误）。
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return reject(tool, rule.field, DETAIL.typeString)
  if (value.length === 0) return undefined
  return validateArgumentPath(tool, rule.field, value, rule.kind, context, options)
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

/**
 * 小黑盒工具执行前的本地媒体路径守卫。
 *
 * @param {{ name?: unknown, arguments?: unknown }} exec 工具执行描述
 * @param {{ root?: string }} [options] 仅测试注入素材根目录；生产不传
 * @returns {string | undefined} 中文拒绝原因；undefined 表示放行/不归本守卫管
 */
export function guardXiaoheiheArguments(exec, options) {
  if (!exec || typeof exec !== 'object') return undefined
  const name = exec.name
  if (typeof name !== 'string' || !name.startsWith(NAMESPACE_PREFIX)) return undefined

  const tool = name.slice(NAMESPACE_PREFIX.length)
  // 未知工具名不在这里授权：12 个原名由 qq-tool-restrict.mjs 精确白名单拒绝。
  if (XIAOHEIHE_PATHLESS_TOOLS.has(tool)) return undefined
  const rules = XIAOHEIHE_MEDIA_FIELDS[tool]
  if (!rules) return undefined

  const args = exec.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    // 没有参数对象就没有路径可读；参数形态错误由 MCP 服务端按 schema 处理。
    return undefined
  }

  try {
    const context = createContext(options)
    for (const rule of rules) {
      const reason = validateMediaField(tool, rule, args[rule.field], context, options)
      if (reason) return reason
    }
  } catch {
    // 任何意外异常都 fail-closed，且不回显异常信息（可能含路径）。
    return `小黑盒工具 ${tool} 的本地媒体路径校验失败，已拒绝。`
  }
  return undefined
}
