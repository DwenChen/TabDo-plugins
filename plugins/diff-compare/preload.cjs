'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const zlib = require('node:zlib')

/**
 * TabDo 差异比较插件安全 Preload 模块。
 *
 * 安全边界：
 * 1. 所有文件读取、目录扫描和哈希计算都受限于用户真实交互授权的路径白名单：
 *    - pickDirectory / pickFiles（原生文件对话框）
 *    - preload 捕获阶段监听到的可信 drop 事件
 *    - 宿主 onPluginEnter 传入的文件/目录 payload
 * 2. 不向渲染层暴露“传任意字符串路径即可加入白名单”的写接口。
 * 3. 使用 realpath 防止目录内符号链接逃逸到授权范围之外。
 * 4. 所有长期监听和内存白名单在 session-v1 退出时通过 tabdo.lifecycle.addCleanup 自动回收。
 */

const MAX_AUTHORIZED = 64
const MAX_SCAN_ENTRIES = 60000
const MAX_SCAN_DEPTH = 32
const SCAN_CONCURRENCY = 32
const MAX_READ_BYTES = 64 * 1024 * 1024
const HASH_MAX_BYTES = 256 * 1024 * 1024
const HASH_TEXT_MAX_BYTES = 8 * 1024 * 1024
const HASH_ZIP_MAX_BYTES = 48 * 1024 * 1024
const HASH_HEX_LEN = 32
const SAVE_MAX_BYTES = 256 * 1024 * 1024
const SAVE_ALLOWED_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'html',
  'htm',
  'txt',
  'md',
  'csv',
  'json',
  'xlsx',
  'pdf',
  'docx',
  'pptx'
])

const authorizedRoots = new Set()
const authorizedFiles = new Set()
const trustedDropPaths = new Set()
let pendingDropAuth = Promise.resolve()
let sessionDisposed = false
let scanSeq = 0
const activeScanAbortIds = new Set()

function getHostApi() {
  if (typeof window !== 'undefined' && window.tabdo) return window.tabdo
  return null
}

function addRoot(abs) {
  if (sessionDisposed) return
  if (authorizedRoots.size >= MAX_AUTHORIZED) authorizedRoots.clear()
  authorizedRoots.add(abs)
}

function addFile(abs) {
  if (sessionDisposed) return
  if (authorizedFiles.size >= MAX_AUTHORIZED) authorizedFiles.clear()
  authorizedFiles.add(abs)
}

const NATIVE_EVENT_TRUSTED_GETTER = (() => {
  try {
    const desc = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted')
    return desc && typeof desc.get === 'function' ? desc.get : null
  } catch {
    return null
  }
})()

const NATIVE_FILE_PATH_GETTER = (() => {
  try {
    const desc = Object.getOwnPropertyDescriptor(File.prototype, 'path')
    return desc && typeof desc.get === 'function' ? desc.get : null
  } catch {
    return null
  }
})()

function isTrustedEvent(event) {
  if (!event) return false
  if (NATIVE_EVENT_TRUSTED_GETTER) {
    try {
      return NATIVE_EVENT_TRUSTED_GETTER.call(event) === true
    } catch {
      return false
    }
  }
  return event.isTrusted === true
}

function resolveNativeFilePath(file) {
  if (!file) return ''
  const host = getHostApi()
  if (host && typeof host.getPathForFile === 'function') {
    try {
      const p = host.getPathForFile(file)
      if (typeof p === 'string' && p) return p
    } catch {
      /* fallback below */
    }
  }
  if (NATIVE_FILE_PATH_GETTER) {
    try {
      const p = NATIVE_FILE_PATH_GETTER.call(file)
      if (typeof p === 'string' && p) return p
    } catch {
      /* ignore */
    }
  }
  return typeof file.path === 'string' ? file.path : ''
}

function isInside(root, target) {
  if (target === root) return true
  const sep = path.sep
  if (process.platform === 'win32') {
    const r = (root.endsWith(sep) ? root : root + sep).toLowerCase()
    const t = target.toLowerCase()
    return t === root.toLowerCase() || t.startsWith(r)
  }
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function registerRoot(rawPath) {
  if (sessionDisposed || !rawPath || typeof rawPath !== 'string') return
  let abs
  try {
    abs = path.resolve(rawPath)
  } catch {
    return
  }
  try {
    const real = await fsPromises.realpath(abs)
    addRoot(real)
  } catch {
    addRoot(abs)
  }
}

async function registerFile(rawPath) {
  if (sessionDisposed || !rawPath || typeof rawPath !== 'string') return
  let abs
  try {
    abs = path.resolve(rawPath)
  } catch {
    return
  }
  try {
    const real = await fsPromises.realpath(abs)
    addFile(real)
  } catch {
    addFile(abs)
  }
}

function noteTrustedPath(rawPath) {
  if (sessionDisposed || typeof rawPath !== 'string' || !rawPath) return
  let abs
  try {
    abs = path.resolve(rawPath)
  } catch {
    return
  }
  if (!path.isAbsolute(abs) || trustedDropPaths.has(abs)) return
  trustedDropPaths.add(abs)
  pendingDropAuth = pendingDropAuth
    .then(async () => {
      if (sessionDisposed) return
      try {
        const stat = await fsPromises.stat(abs)
        if (stat.isDirectory()) await registerRoot(abs)
        else await registerFile(abs)
      } catch {
        trustedDropPaths.delete(abs)
      }
    })
    .catch(() => {})
}

function onTrustedDrop(event) {
  if (sessionDisposed || !isTrustedEvent(event)) return
  const dt = event.dataTransfer
  if (!dt || !dt.files || !dt.files.length) return
  for (let i = 0; i < dt.files.length; i++) {
    const filePath = resolveNativeFilePath(dt.files[i])
    if (filePath) noteTrustedPath(filePath)
  }
}

function authorizeEnterPayload(action) {
  if (!action || !action.payload || !Array.isArray(action.payload)) return
  for (const item of action.payload) {
    if (item && typeof item.path === 'string') {
      noteTrustedPath(item.path)
    }
  }
}

function installPluginEnterAuthorization() {
  const host = getHostApi()
  if (!host || typeof host.onPluginEnter !== 'function') return
  try {
    const nativeEnter = host.onPluginEnter
    const wrapped = function (callback) {
      if (typeof callback !== 'function') return nativeEnter.call(host, callback)
      return nativeEnter.call(host, function (action) {
        try {
          authorizeEnterPayload(action)
        } catch {
          /* ignore */
        }
        return callback(action)
      })
    }
    Object.defineProperty(host, 'onPluginEnter', {
      value: wrapped,
      writable: true,
      configurable: true
    })
  } catch {
    /* ignore if host API is frozen */
  }
}

async function authorizeTarget(rawPath) {
  if (sessionDisposed || !rawPath || typeof rawPath !== 'string') return null
  let abs
  try {
    abs = path.resolve(rawPath)
  } catch {
    return null
  }
  let real
  try {
    real = await fsPromises.realpath(abs)
  } catch {
    real = abs
  }
  if (authorizedFiles.has(real)) return real
  if (process.platform === 'win32') {
    const lower = real.toLowerCase()
    for (const f of authorizedFiles) {
      if (f.toLowerCase() === lower) return real
    }
  }
  for (const root of authorizedRoots) {
    if (isInside(root, real)) return real
  }
  return null
}

async function getAuthorizedDrops() {
  await pendingDropAuth
  return Array.from(trustedDropPaths)
}

async function statAuthorizedPath(rawPath) {
  await pendingDropAuth
  const abs = await authorizeTarget(rawPath)
  if (!abs) return { ok: false, error: '没有访问该路径的授权' }
  try {
    const stat = await fsPromises.stat(abs)
    return {
      ok: true,
      path: abs,
      name: path.basename(abs),
      isDir: stat.isDirectory(),
      isFile: stat.isFile(),
      size: stat.size,
      mtime: stat.mtimeMs
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

async function pickDirectory(options) {
  options = options || {}
  const host = getHostApi()
  if (!host || typeof host.showOpenDialog !== 'function') {
    return ''
  }
  let paths
  try {
    paths = host.showOpenDialog({
      title: options.title || '选择文件夹',
      defaultPath: options.defaultPath || undefined,
      buttonLabel: options.buttonLabel || undefined,
      properties: ['openDirectory']
    })
  } catch {
    return ''
  }
  if (!paths || !paths.length) return ''
  const dir = paths[0]
  await registerRoot(dir)
  return dir
}

async function pickFiles(options) {
  options = options || {}
  const host = getHostApi()
  if (!host || typeof host.showOpenDialog !== 'function') {
    return { ok: false, canceled: false, files: [], error: '当前环境不支持原生文件对话框' }
  }
  const properties = ['openFile']
  if (options.multiple) properties.push('multiSelections')
  let paths
  try {
    paths = host.showOpenDialog({
      title: options.title || '选择文件',
      defaultPath: options.defaultPath || undefined,
      buttonLabel: options.buttonLabel || undefined,
      filters: options.filters || undefined,
      properties
    })
  } catch (e) {
    return { ok: false, canceled: false, files: [], error: '打开文件对话框失败：' + e.message }
  }
  if (!paths || !paths.length) return { ok: true, canceled: true, files: [] }
  const files = []
  for (const filePath of paths) {
    await registerFile(filePath)
    let size = 0
    try {
      size = (await fsPromises.stat(filePath)).size
    } catch {
      size = 0
    }
    files.push({ path: filePath, name: path.basename(filePath), size })
  }
  return { ok: true, canceled: false, files }
}

function createLimiter(max) {
  let active = 0
  const queue = []
  function next() {
    if (active >= max || !queue.length) return
    const job = queue.shift()
    active += 1
    job
      .fn()
      .then(
        (value) => {
          active -= 1
          job.resolve(value)
          next()
        },
        (error) => {
          active -= 1
          job.reject(error)
          next()
        }
      )
  }
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
  }
}

async function walkDirectory(dir, rel, ctx, depth) {
  if (sessionDisposed || ctx.isAborted()) {
    ctx.aborted = true
    return []
  }
  const remaining = ctx.maxEntries - ctx.count
  if (remaining <= 0) {
    ctx.truncated = true
    return []
  }
  let dirents
  try {
    dirents = await ctx.limit(() => fsPromises.readdir(dir, { withFileTypes: true }))
  } catch {
    ctx.errors += 1
    return []
  }
  if (sessionDisposed || ctx.isAborted()) {
    ctx.aborted = true
    return []
  }
  if (dirents.length > remaining) {
    dirents = dirents.slice(0, remaining)
    ctx.truncated = true
  }
  ctx.count += dirents.length

  const stats = await Promise.all(
    dirents.map((dirent) => {
      const abs = path.join(dir, dirent.name)
      return ctx.limit(() => {
        if (sessionDisposed || ctx.isAborted()) return Promise.resolve(null)
        return fsPromises.lstat(abs).catch(() => null)
      })
    })
  )

  if (sessionDisposed || ctx.isAborted()) {
    ctx.aborted = true
    return []
  }

  const nodes = dirents.map((dirent, idx) => {
    const info = stats[idx]
    const isLink = dirent.isSymbolicLink()
    const isDir = info ? info.isDirectory() : dirent.isDirectory()
    return {
      name: dirent.name,
      rel: rel ? `${rel}/${dirent.name}` : dirent.name,
      isDir,
      link: isLink,
      mtime: info ? info.mtimeMs : 0,
      size: info && !isDir ? info.size : 0,
      abs: path.join(dir, dirent.name)
    }
  })

  await Promise.all(
    nodes.map((node) => {
      if (!node.isDir) return null
      if (node.link || depth + 1 > MAX_SCAN_DEPTH) {
        node.children = []
        return null
      }
      return walkDirectory(node.abs, node.rel, ctx, depth + 1).then((children) => {
        node.children = children
      })
    })
  )

  for (const node of nodes) delete node.abs
  return nodes
}

async function scanDirectory(rootPath, options) {
  options = options || {}
  await pendingDropAuth
  const fail = (message, root) => ({
    ok: false,
    aborted: false,
    error: message,
    root: root || '',
    name: '',
    tree: [],
    count: 0,
    truncated: false,
    errors: 0
  })

  if (sessionDisposed) return { ...fail('会话已结束'), aborted: true }
  if (!rootPath || typeof rootPath !== 'string') return fail('路径为空')

  const authorized = await authorizeTarget(rootPath)
  if (!authorized) return fail('没有访问该目录的授权')

  try {
    const stat = await fsPromises.stat(authorized)
    if (!stat.isDirectory()) return fail('所选路径不是文件夹', authorized)
  } catch (e) {
    return fail('无法读取该文件夹：' + e.message, authorized)
  }

  const scanId = typeof options.scanId === 'number' ? options.scanId : ++scanSeq
  const ctx = {
    count: 0,
    truncated: false,
    errors: 0,
    aborted: false,
    maxEntries: options.maxEntries > 0 ? Math.min(options.maxEntries, MAX_SCAN_ENTRIES) : MAX_SCAN_ENTRIES,
    limit: createLimiter(SCAN_CONCURRENCY),
    isAborted: () => sessionDisposed || activeScanAbortIds.has(scanId)
  }

  try {
    const tree = await walkDirectory(authorized, '', ctx, 0)
    if (ctx.aborted) {
      return { ...fail('扫描已取消', authorized), aborted: true }
    }
    return {
      ok: true,
      aborted: false,
      root: authorized,
      name: path.basename(authorized) || authorized,
      tree,
      count: ctx.count,
      truncated: ctx.truncated,
      errors: ctx.errors
    }
  } finally {
    activeScanAbortIds.delete(scanId)
  }
}

function cancelScan(scanId) {
  if (typeof scanId === 'number') activeScanAbortIds.add(scanId)
}

async function readFileAt(filePath, options) {
  options = options || {}
  await pendingDropAuth
  const fail = (message) => ({
    ok: false,
    error: message,
    path: filePath || '',
    name: '',
    size: 0,
    mtime: 0
  })

  if (sessionDisposed) return fail('会话已结束')
  if (!filePath || typeof filePath !== 'string') return fail('路径为空')

  const abs = await authorizeTarget(filePath)
  if (!abs) return fail('没有访问该文件的授权')

  const maxBytes = options.maxBytes > 0 ? Math.min(options.maxBytes, MAX_READ_BYTES) : MAX_READ_BYTES
  try {
    const stat = await fsPromises.stat(abs)
    if (!stat.isFile()) return fail('不是一个文件')
    if (stat.size > maxBytes) {
      return fail(`文件过大（${(stat.size / 1048576).toFixed(1)} MB），已跳过`)
    }
    const buf = await fsPromises.readFile(abs)
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return {
      ok: true,
      path: abs,
      name: path.basename(abs),
      size: stat.size,
      mtime: stat.mtimeMs,
      data
    }
  } catch (e) {
    return fail('读取失败：' + e.message)
  }
}

// ── ZIP / 内容指纹 ──

const ZIP_CONTENT_PARTS = {
  docx: [
    /^word\/document\.xml$/,
    /^word\/(header|footer)\d*\.xml$/,
    /^word\/(footnotes|endnotes|comments)\.xml$/
  ],
  excel: [/^xl\/workbook\.xml$/, /^xl\/sharedStrings\.xml$/, /^xl\/worksheets\/[^/]+\.xml$/],
  pptx: [/^ppt\/slides\/[^/]+\.xml$/, /^ppt\/notesSlides\/[^/]+\.xml$/]
}

const ZIP_EOCD_SIG = 0x06054b50
const ZIP_CD_SIG = 0x02014b50
const ZIP_LOCAL_SIG = 0x04034b50

function findZipEOCD(buf) {
  const min = Math.max(0, buf.length - 65558)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) return i
  }
  return -1
}

function readZipEntries(buf) {
  const eocd = findZipEOCD(buf)
  if (eocd < 0) throw new Error('不是有效的 ZIP 容器')
  const total = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < total; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== ZIP_CD_SIG) break
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    entries.push({
      name: buf.toString('utf8', offset + 46, offset + 46 + nameLength),
      method,
      compressedSize,
      localOffset
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntryData(buf, entry) {
  const head = entry.localOffset
  if (head + 30 > buf.length || buf.readUInt32LE(head) !== ZIP_LOCAL_SIG) {
    throw new Error('ZIP 局部头损坏')
  }
  const nameLength = buf.readUInt16LE(head + 26)
  const extraLength = buf.readUInt16LE(head + 28)
  const start = head + 30 + nameLength + extraLength
  const raw = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw new Error('不支持的 ZIP 压缩方式')
}

function scrubXml(text) {
  return text
    .replace(/\s+w:rsid[A-Za-z]*="[0-9A-Fa-f]+"/g, '')
    .replace(/\s+w:(paraId|textId)="[0-9A-Fa-f]+"/g, '')
    .replace(/<w:lastRenderedPageBreak\s*\/>/g, '')
    .replace(/(<sst\b[^>]*?)\s+count="\d+"\s+uniqueCount="\d+"/g, '$1')
}

function hashZipContent(buf, kind) {
  const parts = ZIP_CONTENT_PARTS[kind]
  if (!Array.isArray(parts)) throw new Error('不支持规范化指纹')
  const wanted = readZipEntries(buf)
    .filter((entry) => parts.some((pattern) => pattern.test(entry.name)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (!wanted.length) throw new Error('未找到内容部件')
  const hash = crypto.createHash('sha256')
  for (const entry of wanted) {
    const xml = readZipEntryData(buf, entry)
    hash.update(entry.name)
    hash.update('\0')
    hash.update(scrubXml(xml.toString('utf8')))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, HASH_HEX_LEN)
}

function normalizeTextBuffer(buf) {
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return Buffer.from(text.replace(/\r\n?/g, '\n'), 'utf8')
}

function hashFileStream(abs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(abs)
    stream.on('data', (chunk) => {
      if (sessionDisposed) {
        stream.destroy(new Error('会话已结束'))
        return
      }
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex').slice(0, HASH_HEX_LEN)))
  })
}

async function hashFileAt(filePath, options) {
  options = options || {}
  await pendingDropAuth
  const fail = (message) => ({
    ok: false,
    error: message,
    path: filePath || '',
    name: '',
    size: 0,
    mtime: 0
  })

  if (sessionDisposed) return fail('会话已结束')
  if (!filePath || typeof filePath !== 'string') return fail('路径为空')
  const abs = await authorizeTarget(filePath)
  if (!abs) return fail('没有访问该文件的授权')

  const maxBytes = options.maxBytes > 0 ? Math.min(options.maxBytes, HASH_MAX_BYTES) : HASH_MAX_BYTES
  const kind = options.kind || ''
  try {
    const stat = await fsPromises.stat(abs)
    if (!stat.isFile()) return fail('不是一个文件')
    if (stat.size > maxBytes) return fail('文件过大，未参与内容校验')

    let hash
    let normalized = false
    if (Object.prototype.hasOwnProperty.call(ZIP_CONTENT_PARTS, kind) && stat.size <= HASH_ZIP_MAX_BYTES) {
      const buf = await fsPromises.readFile(abs)
      try {
        hash = 'z' + hashZipContent(buf, kind)
        normalized = true
      } catch {
        hash = 'r' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, HASH_HEX_LEN)
      }
    } else if (kind === 'text' && stat.size <= HASH_TEXT_MAX_BYTES) {
      const buf = await fsPromises.readFile(abs)
      hash = 't' + crypto.createHash('sha256').update(normalizeTextBuffer(buf)).digest('hex').slice(0, HASH_HEX_LEN)
      normalized = true
    } else {
      hash = 'r' + (await hashFileStream(abs))
    }

    return {
      ok: true,
      path: abs,
      name: path.basename(abs),
      size: stat.size,
      mtime: stat.mtimeMs,
      hash,
      normalized
    }
  } catch (e) {
    return fail('读取失败：' + e.message)
  }
}

/**
 * 提供给渲染层的安全 zlib 解压工具，仅处理内存字节，不涉及文件系统。
 * 用于离线解析 OOXML（docx/xlsx/pptx）与 PDF FlateDecode 流。
 */
function inflateData(input, raw = true) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input)
  const out = raw ? zlib.inflateRawSync(buf) : zlib.inflateSync(buf)
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
}

/**
 * 另存为：通过临时文件写入再重命名，保证失败或中断时不破坏已有目标文件。
 */
async function saveFileAs(options) {
  options = options || {}
  const data = options.data
  if (!data) return { ok: false, path: '', error: '没有要保存的内容' }

  const buf = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
  if (buf.length > SAVE_MAX_BYTES) {
    return { ok: false, path: '', error: '内容过大，无法保存' }
  }

  const rawName = options.defaultName || '差异报告.html'
  const ext = (rawName.split('.').pop() || '').toLowerCase()
  if (!SAVE_ALLOWED_EXT.has(ext)) {
    return { ok: false, path: '', error: '不支持保存该文件类型' }
  }

  const host = getHostApi()
  if (!host || typeof host.showSaveDialog !== 'function') {
    return { ok: false, path: '', error: '当前环境不支持原生保存对话框' }
  }

  let filePath
  try {
    filePath = host.showSaveDialog({
      title: options.title || '另存为',
      defaultPath: path.basename(rawName),
      buttonLabel: options.buttonLabel || '保存',
      filters: options.filters || [{ name: '所有文件', extensions: ['*'] }]
    })
  } catch (e) {
    return { ok: false, path: '', error: '打开保存对话框失败：' + e.message }
  }

  if (!filePath) return { ok: false, canceled: true, path: '' }

  // 采用同目录临时文件 + 原子替换，写入失败立即回滚删除临时文件
  const tmpPath = `${filePath}.tabdo-tmp-${process.pid}-${Date.now()}`
  try {
    await fsPromises.writeFile(tmpPath, buf)
    await fsPromises.rename(tmpPath, filePath)
    return { ok: true, path: filePath, size: buf.length }
  } catch (e) {
    try {
      await fsPromises.rm(tmpPath, { force: true })
    } catch {
      /* ignore rollback error */
    }
    return { ok: false, path: filePath, error: '写入失败：' + e.message }
  }
}

window.diffPreload = Object.freeze({
  pickFiles,
  pickDirectory,
  getAuthorizedDrops,
  statAuthorizedPath,
  scanDirectory,
  cancelScan,
  readFileAt,
  hashFileAt,
  inflateData,
  saveFileAs
})

try {
  document.addEventListener('drop', onTrustedDrop, true)
} catch {
  /* ignore */
}
installPluginEnterAuthorization()

// 登记 session-v1 清理器：退出时清空内存白名单、撤销捕获监听并取消在途扫描
try {
  const host = getHostApi()
  if (host && host.lifecycle && typeof host.lifecycle.addCleanup === 'function') {
    host.lifecycle.addCleanup(() => {
      sessionDisposed = true
      authorizedRoots.clear()
      authorizedFiles.clear()
      trustedDropPaths.clear()
      activeScanAbortIds.clear()
      try {
        document.removeEventListener('drop', onTrustedDrop, true)
      } catch {
        /* ignore */
      }
    })
  }
} catch {
  /* ignore */
}
