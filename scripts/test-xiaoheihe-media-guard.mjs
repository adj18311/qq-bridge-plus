// 小黑盒媒体路径守卫（qq-xiaoheihe-guard.mjs）的离线回归测试。
//
// 覆盖：
//   1. 名称路由：非小黑盒名称/未知名称/无路径工具一律不参与校验（授权由
//      qq-tool-restrict.mjs 的 12 个精确白名单负责）；
//   2. publish_content / post_comment 的 images：专用目录内已有普通图片放行；
//      相对/盘符相对/单斜杠/UNC/URL/file://、越界、不存在、目录、符号链接、
//      错误后缀、类型错误一律拒绝；
//   3. publish_video 的 videoPath/coverImagePath：图/视频后缀混用必须拒绝；
//      缺省或空字符串视为"没有路径可读"（服务端会自行报参数错误）；
//   4. publish_article 的 content：对照上游 ArticlePublishService.ParseContentWithImages
//      的 winPattern/posixPattern 行为，合法反斜杠盘符路径（含空格/中文）放行；
//      正斜杠盘符、单斜杠开头、UNC、file://、越界、不存在一律拒绝；
//      普通 https 链接不得被误伤；
//   5. 默认素材根：XIAOHEIHE_MEDIA_ROOT → DSH_HOME/xiaoheihe-media → ~/.dsh/...，
//      options.root 可注入；目录不存在时拒绝且**不自动创建**；
//   6. 拒绝原因只含静态中文 + schema 字段名，不回显原始路径/文件内容/凭据；
//      guard 绝不读取文件内容、绝不发起网络请求。
//
// 全程离线：只使用系统临时目录里的假素材（内容为 fixture 字符串），
// 不连接小黑盒/DSH/QQ，不碰工作区 config/state，不启动任何服务。
// 符号链接用例在系统不允许创建链接时（Windows 无 Developer Mode/管理员）
// 用 t.skip 标记跳过，而不是失败。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { guardXiaoheiheArguments } from '../plugins/qq-agent-presets/qq-xiaoheihe-guard.mjs'

const PREFIX = 'mcp__xiaoheihe__'
const SECRET_MARK = 'TOPSECRET-FIXTURE-CONTENT'

/** 创建一套临时素材夹具：root 内是"合法素材"，outside 是越界目标。 */
function makeFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-media-guard-'))
  t.after(() => {
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
  })

  const root = path.join(base, 'media')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, '子 目录'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })

  const files = {
    // 合法图片（含空格与中文目录，上游 winPattern 允许空格）
    imageWithSpaces: path.join(root, '子 目录', 'a b.png'),
    imageUpperExt: path.join(root, 'pic.JPG'),
    cover: path.join(root, 'cover.webp'),
    video: path.join(root, 'clip.mp4'),
    text: path.join(root, 'notes.txt'),
    // 名字像图片、实际是目录
    imageDirectory: path.join(root, 'dir.png'),
    // 越界素材（都在 outside 里，真实存在，用来证明"存在但越界"也会被拒）
    outsideImage: path.join(outside, 'secret-token-do-not-leak.png'),
    outsideVideo: path.join(outside, 'outside.mp4'),
  }

  fs.writeFileSync(files.imageWithSpaces, 'fixture-image-bytes')
  fs.writeFileSync(files.imageUpperExt, 'fixture-image-bytes')
  fs.writeFileSync(files.cover, 'fixture-cover-bytes')
  fs.writeFileSync(files.video, 'fixture-video-bytes')
  fs.writeFileSync(files.text, 'fixture-text-bytes')
  fs.mkdirSync(files.imageDirectory)
  fs.writeFileSync(files.outsideImage, SECRET_MARK)
  fs.writeFileSync(files.outsideVideo, SECRET_MARK)

  return { base, root, outside, files }
}

/** 以真实工具名调用守卫。 */
function call(tool, args, options) {
  return guardXiaoheiheArguments({ name: `${PREFIX}${tool}`, arguments: args }, options)
}

function assertAllowed(reason) {
  assert.equal(reason, undefined, `预期放行，实际被拒：${reason}`)
}

function assertRejected(reason, fragments = []) {
  assert.equal(typeof reason, 'string', `预期返回中文拒绝原因，实际：${String(reason)}`)
  assert.ok(reason.length > 0, '拒绝原因不能是空串')
  assert.match(reason, /[\u4e00-\u9fff]/u, `拒绝原因必须是中文：${reason}`)
  for (const fragment of fragments) {
    assert.ok(reason.includes(fragment), `拒绝原因应包含「${fragment}」，实际：${reason}`)
  }
}

const ALL_PATHLESS = [
  'check_login_status',
  'interactive_login',
  'get_login_qr_code',
  'get_user_profile',
  'get_home_content',
  'search_content',
  'get_post_detail',
  'reply_comment',
]

// ── 1. 名称路由 ──────────────────────────────────────────────────────────────

test('非小黑盒名称一律返回 undefined（不接管其它守卫的职责）', () => {
  const cases = [
    { name: 'read', arguments: { file_path: 'C:\\Windows\\win.ini' } },
    { name: 'pwsh', arguments: { command: 'whoami' } },
    { name: 'mcp__snowluma__qq_send_image', arguments: { url: 'https://x/a.png' } },
    { name: 'mcp__xiaoheihe_host__publish_video', arguments: {} },
    { name: 'xiaoheihe__publish_content', arguments: {} },
    { name: '', arguments: {} },
    { name: 'XIAOHEIHE', arguments: {} },
    {},
    null,
    undefined,
  ]
  for (const exec of cases) {
    assert.equal(guardXiaoheiheArguments(exec), undefined, `不应接管：${JSON.stringify(exec)}`)
  }
})

test('未知小黑盒工具名返回 undefined，交由 qq-tool-restrict 白名单拒绝', () => {
  assert.equal(
    guardXiaoheiheArguments({ name: `${PREFIX}unknown_new_tool`, arguments: { images: ['C:\\x.png'] } }),
    undefined,
  )
  assert.equal(guardXiaoheiheArguments({ name: PREFIX, arguments: {} }), undefined)
})

test('只读/登录/文本互动工具不做路径校验', () => {
  for (const tool of ALL_PATHLESS) {
    const args = {
      // 故意塞入路径样子的无关字段：这些工具的上游实现不会读本地文件
      images: ['C:\\Windows\\System32\\config\\SAM'],
      videoPath: 'C:\\secret.mp4',
      content: '/etc/passwd',
      postId: '123',
      keyword: 'x',
    }
    assertAllowed(call(tool, args, undefined))
  }
})

// ── 2. publish_content / post_comment 的 images ─────────────────────────────

test('publish_content：images 缺省、null、空数组均视为无路径', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  assertAllowed(call('publish_content', { title: 't', content: '纯文字' }, options))
  assertAllowed(call('publish_content', { title: 't', content: '纯文字', images: null }, options))
  assertAllowed(call('publish_content', { title: 't', content: '纯文字', images: [] }, options))
})

test('publish_content：专用目录内的已有图片放行（含空格/中文路径）', (t) => {
  const fx = makeFixture(t)
  assertAllowed(call('publish_content', {
    title: 't',
    content: 'c',
    images: [fx.files.imageWithSpaces, fx.files.cover],
  }, { root: fx.root }))
})

test('publish_content：正斜杠形式的盘符绝对路径参数也被 Win32/Playwright 认，放行', (t) => {
  const fx = makeFixture(t)
  const forward = fx.files.cover.split(path.sep).join('/')
  assertAllowed(call('publish_content', { title: 't', content: 'c', images: [forward] }, { root: fx.root }))
})

test('publish_content：越界文件（存在但不在专用目录）被拒', (t) => {
  const fx = makeFixture(t)
  const reason = call('publish_content', {
    title: 't',
    content: 'c',
    images: [fx.files.outsideImage],
  }, { root: fx.root })
  assertRejected(reason, ['images', '专用素材目录'])
})

test('publish_content：.. 穿越到目录外被拒', (t) => {
  const fx = makeFixture(t)
  const traversal = path.join(fx.root, '..', 'outside', path.basename(fx.files.outsideImage))
  const reason = call('publish_content', { title: 't', content: 'c', images: [traversal] }, { root: fx.root })
  assertRejected(reason, ['images', '专用素材目录'])
})

test('publish_content：不存在的文件被拒', (t) => {
  const fx = makeFixture(t)
  const missing = path.join(fx.root, 'missing.png')
  const reason = call('publish_content', { title: 't', content: 'c', images: [missing] }, { root: fx.root })
  assertRejected(reason, ['images', '不存在'])
})

test('publish_content：指向目录的 .png 被拒', (t) => {
  const fx = makeFixture(t)
  const reason = call('publish_content', {
    title: 't',
    content: 'c',
    images: [fx.files.imageDirectory],
  }, { root: fx.root })
  assertRejected(reason, ['images', '普通文件'])
})

test('publish_content：相对路径/盘符相对路径/单斜杠开头一律拒绝', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  for (const bad of ['images/a.png', 'C:a.png', '\\a.png', '/a.png']) {
    const reason = call('publish_content', { title: 't', content: 'c', images: [bad] }, options)
    assertRejected(reason, ['images'])
  }
})

test('publish_content：UNC/网络路径与设备路径被拒', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  for (const bad of ['\\\\server\\share\\a.png', '//server/share/a.png', '\\\\?\\C:\\media\\a.png']) {
    const reason = call('publish_content', { title: 't', content: 'c', images: [bad] }, options)
    assertRejected(reason, ['images', 'UNC'])
  }
})

test('publish_content：URL / file:// / data: 伪造路径被拒', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  const urlReason = call('publish_content', {
    title: 't', content: 'c', images: ['https://example.com/a.png'],
  }, options)
  assertRejected(urlReason, ['images', 'URL'])

  const fileReason = call('publish_content', {
    title: 't', content: 'c', images: [`file:///${fx.files.cover.split(path.sep).join('/')}`],
  }, options)
  assertRejected(fileReason, ['images', 'file://'])

  const dataReason = call('publish_content', {
    title: 't', content: 'c', images: ['data:image/png;base64,AAAA'],
  }, options)
  assertRejected(dataReason, ['images'])
})

test('publish_content：错误后缀（.txt/视频）被拒，图/视频不混用', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  assertRejected(call('publish_content', { title: 't', content: 'c', images: [fx.files.text] }, options), ['图片后缀'])
  assertRejected(call('publish_content', { title: 't', content: 'c', images: [fx.files.video] }, options), ['图片后缀'])
})

test('publish_content：images 类型错误直接拒绝', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  for (const images of ['C:\\media\\a.png', 123, { path: 'C:\\media\\a.png' }, [123], [null], [{}]]) {
    assertRejected(call('publish_content', { title: 't', content: 'c', images }, options), ['images'])
  }
})

test('publish_content：content 文本里的路径不参与校验（上游只当普通文本键入）', (t) => {
  const fx = makeFixture(t)
  assertAllowed(call('publish_content', {
    title: 't',
    content: '正文里提到 C:\\Windows\\win.ini 只是文字，不会读文件',
    images: [fx.files.cover],
  }, { root: fx.root }))
})

test('post_comment：images 同样受控（合法放行/越界拒绝）', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  assertAllowed(call('post_comment', { postId: '1', content: 'c', images: [fx.files.cover] }, options))
  assertRejected(call('post_comment', { postId: '1', content: 'c', images: [fx.files.outsideImage] }, options), ['images'])
  assertAllowed(call('post_comment', { postId: '1', content: 'c' }, options))
})

// ── 3. publish_video 的 videoPath / coverImagePath ──────────────────────────

test('publish_video：合法视频+封面放行；封面缺省/空串也放行', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  assertAllowed(call('publish_video', {
    title: 't', content: 'c', videoPath: fx.files.video, coverImagePath: fx.files.cover,
  }, options))
  assertAllowed(call('publish_video', {
    title: 't', content: 'c', videoPath: fx.files.video, coverImagePath: '',
  }, options))
  assertAllowed(call('publish_video', {
    title: 't', content: 'c', videoPath: fx.files.video,
  }, options))
})

test('publish_video：图/视频后缀混用被拒', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  const videoAsImage = call('publish_video', {
    title: 't', content: 'c', videoPath: fx.files.cover, coverImagePath: fx.files.cover,
  }, options)
  assertRejected(videoAsImage, ['videoPath', '视频后缀'])

  const imageAsCover = call('publish_video', {
    title: 't', content: 'c', videoPath: fx.files.video, coverImagePath: fx.files.video,
  }, options)
  assertRejected(imageAsCover, ['coverImagePath', '图片后缀'])
})

test('publish_video：越界视频/封面被拒', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  assertRejected(call('publish_video', {
    title: 't', content: 'c', videoPath: fx.files.outsideVideo, coverImagePath: '',
  }, options), ['videoPath', '专用素材目录'])
  assertRejected(call('publish_video', {
    title: 't', content: 'c', videoPath: fx.files.video, coverImagePath: fx.files.outsideImage,
  }, options), ['coverImagePath', '专用素材目录'])
})

test('publish_video：目录与类型错误被拒', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  const dirVideo = path.join(fx.root, 'dir.mp4')
  fs.mkdirSync(dirVideo)
  assertRejected(call('publish_video', {
    title: 't', content: 'c', videoPath: dirVideo, coverImagePath: '',
  }, options), ['videoPath', '普通文件'])
  assertRejected(call('publish_video', {
    title: 't', content: 'c', videoPath: 123, coverImagePath: '',
  }, options), ['videoPath', '字符串'])
})

// ── 4. publish_article 的 content（上游正则行为） ───────────────────────────

test('publish_article：纯文字与普通非图片 https 链接不被误伤', (t) => {
  const fx = makeFixture(t)
  const content = [
    '这是一篇普通文章。',
    '参考 https://example.com/posts/123?from=share 和 http://cdn.example.com/album/456 。',
    'markdown 链接 [帖子](https://example.com/posts/789) 也不算本地路径。',
  ].join('\n')
  assertAllowed(call('publish_article', { title: 't', content, communities: ['c'] }, { root: fx.root }))
})

test('publish_article：http(s) 图片 URL 一律拒绝（上游 posixPattern 会按本地路径尝试）', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }

  // 队长给出的具体案例：上游 posixPattern 实测会从 URL 中截出 //Pictures/private.png
  // （Windows 按 UNC 解释；/Pictures/private.png 这种单斜杠片段会落到当前盘符根）。
  // 先核对该片段确实会被当成路径解析，再断言守卫拒绝 —— 不依赖"File.Exists 一定失败"。
  assert.equal(
    path.win32.resolve('/Pictures/private.png'),
    path.join(path.parse(process.cwd()).root, 'Pictures', 'private.png'),
    '根路径片段会按当前盘符根解析，因此"是 URL"不能当作安全理由',
  )

  for (const content of [
    '看图 https://Pictures/private.png',
    '![图](https://example.com/pics/a.png)',
    'https://cdn.example.com/pics/a.jpg?x=1',
    'https://example.com/a.webp#frag',
  ]) {
    const reason = call('publish_article', { title: 't', content, communities: ['c'] }, options)
    assertRejected(reason, ['content 中的图片路径', '图片 URL', '暂不支持'])
  }
})

test('publish_article：正文里专用目录内的反斜杠盘符图片路径放行（含空格/中文）', (t) => {
  const fx = makeFixture(t)
  const content = [
    '开头文字',
    `![配图](${fx.files.imageWithSpaces})`,
    `再补一张合法图：${fx.files.cover}`,
    '参考 https://example.com/posts/42',
  ].join('\n')
  assertAllowed(call('publish_article', { title: 't', content, communities: ['c'] }, { root: fx.root }))
})

test('publish_article：https 链接里夹带的盘符反斜杠路径仍会被识别', (t) => {
  const fx = makeFixture(t)
  // 情况一：链接本身不是图片（无图片后缀），后面跟着独立的盘符反斜杠路径。
  const content = `配图 https://example.com/prefix ${fx.files.outsideImage}`
  const reason = call('publish_article', { title: 't', content, communities: ['c'] }, { root: fx.root })
  assertRejected(reason, ['content 中的图片路径', '专用素材目录'])

  // 情况二：链接文本里直接夹带 C:\...\x.png（winPattern 不区分 URL）。这类 URL
  // 文本本身含图片后缀，按"图片 URL 歧义"先被明确拒绝，同样不会放行。
  const inline = `https://example.com/redirect/${fx.files.outsideImage}`
  const inlineReason = call('publish_article', { title: 't', content: inline, communities: ['c'] }, { root: fx.root })
  assertRejected(inlineReason, ['content 中的图片路径', '图片 URL'])
})

test('publish_article：正文里越界但真实存在的图片路径被拒', (t) => {
  const fx = makeFixture(t)
  const content = `正文\n![x](${fx.files.outsideImage})\n结尾`
  const reason = call('publish_article', { title: 't', content, communities: ['c'] }, { root: fx.root })
  assertRejected(reason, ['content 中的图片路径', '专用素材目录'])
})

test('publish_article：正斜杠盘符路径被明确拒绝（服务端会截断盘符）', (t) => {
  const fx = makeFixture(t)
  const forward = fx.files.cover.split(path.sep).join('/')
  const reason = call('publish_article', {
    title: 't', content: `图片：${forward}`, communities: ['c'],
  }, { root: fx.root })
  assertRejected(reason, ['content 中的图片路径', '正斜杠'])
})

test('publish_article：/ 开头的路径被拒（服务端按当前盘符解释）', (t) => {
  const fx = makeFixture(t)
  for (const content of ['图片 /xiaoheihe-media/a.png', '相对写法 images/a.png']) {
    const reason = call('publish_article', { title: 't', content, communities: ['c'] }, { root: fx.root })
    assertRejected(reason, ['content 中的图片路径'])
  }
})

test('publish_article：UNC 与 file:// 被拒', (t) => {
  const fx = makeFixture(t)
  const uncReason = call('publish_article', {
    title: 't', content: '图 \\\\server\\share\\a.png', communities: ['c'],
  }, { root: fx.root })
  assertRejected(uncReason, ['content 中的图片路径', 'UNC'])

  const fileUrlReason = call('publish_article', {
    title: 't', content: '图 file:///C:/media/a.png', communities: ['c'],
  }, { root: fx.root })
  assertRejected(fileUrlReason, ['content 中的图片路径', 'file://'])
})

test('publish_article：正文里不存在的图片文件被拒', (t) => {
  const fx = makeFixture(t)
  const missing = path.join(fx.root, 'missing.png')
  const reason = call('publish_article', {
    title: 't', content: `图 ${missing}`, communities: ['c'],
  }, { root: fx.root })
  assertRejected(reason, ['content 中的图片路径', '不存在'])
})

test('publish_article：content 类型错误被拒', (t) => {
  const fx = makeFixture(t)
  const reason = call('publish_article', { title: 't', content: { path: 'C:\\x.png' }, communities: ['c'] }, { root: fx.root })
  assertRejected(reason, ['content', '字符串'])
})

test('publish_article：防御性校验 images（服务层有该字段，HTTP schema 当前未声明）', (t) => {
  const fx = makeFixture(t)
  const options = { root: fx.root }
  assertAllowed(call('publish_article', {
    title: 't', content: '无图正文', communities: ['c'], images: [],
  }, options))
  assertRejected(call('publish_article', {
    title: 't', content: '无图正文', communities: ['c'], images: [fx.files.outsideImage],
  }, options), ['images', '专用素材目录'])
})

// ── 5. 素材根目录解析与环境 ─────────────────────────────────────────────────

test('素材目录不存在时拒绝，且绝不自动创建目录', (t) => {
  const fx = makeFixture(t)
  const missingRoot = path.join(fx.base, 'not-created-media-root')
  assert.equal(fs.existsSync(missingRoot), false)
  const reason = call('publish_content', {
    title: 't', content: 'c', images: [fx.files.cover],
  }, { root: missingRoot })
  assertRejected(reason, ['专用素材目录', '不存在'])
  assert.equal(fs.existsSync(missingRoot), false, '守卫不能自动创建素材目录')
})

test('XIAOHEIHE_MEDIA_ROOT 作为默认素材根生效', (t) => {
  const fx = makeFixture(t)
  const prev = process.env.XIAOHEIHE_MEDIA_ROOT
  process.env.XIAOHEIHE_MEDIA_ROOT = fx.root
  try {
    assertAllowed(call('publish_content', { title: 't', content: 'c', images: [fx.files.cover] }))
    assertRejected(call('publish_content', { title: 't', content: 'c', images: [fx.files.outsideImage] }), ['专用素材目录'])
  } finally {
    if (prev === undefined) delete process.env.XIAOHEIHE_MEDIA_ROOT
    else process.env.XIAOHEIHE_MEDIA_ROOT = prev
  }
})

test('未设置 XIAOHEIHE_MEDIA_ROOT 时回落到 DSH_HOME/xiaoheihe-media', (t) => {
  const fx = makeFixture(t)
  const prevRoot = process.env.XIAOHEIHE_MEDIA_ROOT
  const prevHome = process.env.DSH_HOME
  const dshHome = path.join(fx.base, 'dsh-home')
  const mediaRoot = path.join(dshHome, 'xiaoheihe-media')
  fs.mkdirSync(mediaRoot, { recursive: true })
  const image = path.join(mediaRoot, 'ok.png')
  fs.writeFileSync(image, 'fixture-bytes')
  delete process.env.XIAOHEIHE_MEDIA_ROOT
  process.env.DSH_HOME = dshHome
  try {
    assertAllowed(call('publish_content', { title: 't', content: 'c', images: [image] }))
    assertRejected(call('publish_content', { title: 't', content: 'c', images: [fx.files.outsideImage] }), ['专用素材目录'])
  } finally {
    if (prevRoot !== undefined) process.env.XIAOHEIHE_MEDIA_ROOT = prevRoot
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})

test('options.root 优先于环境变量（测试注入不被环境干扰）', (t) => {
  const fx = makeFixture(t)
  const prev = process.env.XIAOHEIHE_MEDIA_ROOT
  process.env.XIAOHEIHE_MEDIA_ROOT = fx.outside
  try {
    // 环境里指向 outside，但注入 root 指向合法素材目录 ⇒ 合法图放行
    assertAllowed(call('publish_content', {
      title: 't', content: 'c', images: [fx.files.cover],
    }, { root: fx.root }))
    // 越界目标在注入 root 之外 ⇒ 拒绝
    assertRejected(call('publish_content', {
      title: 't', content: 'c', images: [fx.files.outsideImage],
    }, { root: fx.root }), ['专用素材目录'])
  } finally {
    if (prev === undefined) delete process.env.XIAOHEIHE_MEDIA_ROOT
    else process.env.XIAOHEIHE_MEDIA_ROOT = prev
  }
})

// ── 6. 拒绝原因不泄露参数/内容，守卫无读取/无网络副作用 ─────────────────────

test('拒绝原因不回显原始路径、文件内容或凭据', (t) => {
  const fx = makeFixture(t)
  const secretPath = fx.files.outsideImage
  const reason = call('publish_content', {
    title: 't', content: 'c', images: [secretPath],
  }, { root: fx.root })
  assertRejected(reason)
  assert.ok(!reason.includes(secretPath), '拒绝原因不得包含原始路径')
  assert.ok(!reason.includes(path.basename(secretPath)), '拒绝原因不得包含文件名')
  assert.ok(!reason.includes(SECRET_MARK), '拒绝原因不得包含文件内容')
  assert.ok(!reason.includes(fx.root), '拒绝原因不得包含素材根路径')
  assert.ok(!reason.includes(fx.base), '拒绝原因不得包含临时目录')
})

test('守卫绝不读取文件内容、绝不发起网络请求', (t) => {
  const fx = makeFixture(t)
  const originalReadFileSync = fs.readFileSync
  const originalCreateReadStream = fs.createReadStream
  const originalFetch = globalThis.fetch
  let sideEffect = false

  fs.readFileSync = () => { sideEffect = true; throw new Error('guard 不应读取文件内容') }
  fs.createReadStream = () => { sideEffect = true; throw new Error('guard 不应读取文件内容') }
  globalThis.fetch = () => { sideEffect = true; throw new Error('guard 不应发起网络请求') }
  try {
    // 合法与非法各跑一次：两条路径都不能触发读取/网络
    assertAllowed(call('publish_content', { title: 't', content: 'c', images: [fx.files.cover] }, { root: fx.root }))
    assertRejected(call('publish_content', { title: 't', content: 'c', images: [fx.files.outsideImage] }, { root: fx.root }))
    assertAllowed(call('publish_article', {
      title: 't', content: `图 ${fx.files.imageWithSpaces}`, communities: ['c'],
    }, { root: fx.root }))
  } finally {
    fs.readFileSync = originalReadFileSync
    fs.createReadStream = originalCreateReadStream
    globalThis.fetch = originalFetch
  }
  assert.equal(sideEffect, false, 'guard 不应读取文件内容或联网')
})

// ── 7. 符号链接 / junction 逃逸（系统不支持时跳过） ─────────────────────────

test('父目录 junction 指向素材目录外：realpath 越界被拒', (t) => {
  const fx = makeFixture(t)
  const junction = path.join(fx.root, 'junction-out')
  try {
    fs.symlinkSync(fx.outside, junction, 'junction')
  } catch (error) {
    t.skip(`当前系统不允许创建 junction，跳过：${error?.code || error?.message}`)
    return
  }
  const escaped = path.join(junction, path.basename(fx.files.outsideImage))
  const reason = call('publish_content', { title: 't', content: 'c', images: [escaped] }, { root: fx.root })
  assertRejected(reason, ['images', '专用素材目录'])
})

test('素材目录内的文件符号链接被拒（不跟随链接）', (t) => {
  const fx = makeFixture(t)
  const link = path.join(fx.root, 'alias.png')
  try {
    fs.symlinkSync(fx.files.cover, link, 'file')
  } catch (error) {
    t.skip(`当前系统不允许创建文件符号链接，跳过：${error?.code || error?.message}`)
    return
  }
  const reason = call('publish_content', { title: 't', content: 'c', images: [link] }, { root: fx.root })
  assertRejected(reason, ['images', '符号链接'])
})

test('指向素材目录外文件的符号链接同样被拒', (t) => {
  const fx = makeFixture(t)
  const link = path.join(fx.root, 'alias-secret.png')
  try {
    fs.symlinkSync(fx.files.outsideImage, link, 'file')
  } catch (error) {
    t.skip(`当前系统不允许创建文件符号链接，跳过：${error?.code || error?.message}`)
    return
  }
  const reason = call('publish_content', { title: 't', content: 'c', images: [link] }, { root: fx.root })
  assertRejected(reason, ['images', '符号链接'])
})
