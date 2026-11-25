/**
 * 零外部依赖离线文件解析器：
 * - 智能文本编码识别（UTF-8 / UTF-16LE / UTF-16BE / GB18030）
 * - 原生 ZIP / OOXML 容器解包（优先使用 preload 的 Node zlib，降级使用浏览器 DecompressionStream）
 * - Word (.docx)、Excel (.xlsx / .csv / .tsv)、PPT (.pptx)、PDF (.pdf) 结构化文本提取
 */

import { preloadApi } from './tabdo-bridge.js'

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'vue', 'svelte', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'svg', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'log', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'py', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'sql',
  'swift', 'dart', 'lua', 'gitignore', 'dockerfile', 'makefile'
])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'jpe', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const EXCEL_EXTS = new Set(['xlsx', 'csv', 'tsv'])

export function getExtension(filename) {
  const base = String(filename || '').split(/[\\/]/).pop() || ''
  const idx = base.lastIndexOf('.')
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : ''
}

export function detectFileKind(filename) {
  const ext = getExtension(filename)
  if (!ext) return 'unknown'
  if (ext === 'docx') return 'docx'
  if (EXCEL_EXTS.has(ext)) return 'excel'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'pptx') return 'pptx'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'unknown'
}

export function isLikelyBinary(bytes) {
  const len = Math.min(bytes.length, 4096)
  let nul = 0
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) nul++
  }
  return nul > 2
}

/**
 * 智能解码字节为字符串，兼容 UTF-8 / UTF-16 BOM 与常见中文 GB18030 文本。
 */
export function decodeTextBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}

// ── 通用解压缩（preload zlib 优先，浏览器 DecompressionStream 兜底）──

async function inflateBytes(compressed, raw = true) {
  if (preloadApi && typeof preloadApi.inflateData === 'function') {
    return new Uint8Array(preloadApi.inflateData(compressed, raw))
  }
  if (typeof DecompressionStream !== 'undefined') {
    const format = raw ? 'deflate-raw' : 'deflate'
    const ds = new DecompressionStream(format)
    const stream = new Blob([compressed]).stream().pipeThrough(ds)
    const ab = await new Response(stream).arrayBuffer()
    return new Uint8Array(ab)
  }
  throw new Error('当前运行环境不支持 DEFLATE 解压')
}

/**
 * 解析 ZIP 容器，返回 Map<entryName, () => Promise<Uint8Array>>。
 */
export function openZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const min = Math.max(0, bytes.length - 65558)
  let eocd = -1
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('文件不是有效的 ZIP / Office Open XML 格式')

  const total = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder('utf-8')
  const entries = new Map()

  for (let i = 0; i < total; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen))
    entries.set(name, { name, method, compressedSize, localOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }

  async function readBytes(name) {
    const entry = entries.get(name)
    if (!entry) return null
    const head = entry.localOffset
    if (head + 30 > bytes.length || view.getUint32(head, true) !== 0x04034b50) {
      throw new Error(`ZIP 内部条目损坏：${name}`)
    }
    const nameLen = view.getUint16(head + 26, true)
    const extraLen = view.getUint16(head + 28, true)
    const start = head + 30 + nameLen + extraLen
    const slice = bytes.subarray(start, start + entry.compressedSize)
    if (entry.method === 0) return slice
    if (entry.method === 8) return await inflateBytes(slice, true)
    throw new Error(`不支持的 ZIP 压缩算法：${entry.method}`)
  }

  async function readText(name) {
    const raw = await readBytes(name)
    return raw ? new TextDecoder('utf-8').decode(raw) : null
  }

  return { names: Array.from(entries.keys()), has: (n) => entries.has(n), readBytes, readText }
}

function parseXml(xmlText) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, 'application/xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw new Error('XML 结构解析失败')
  return doc
}

function getElementsByLocalName(root, localName) {
  const result = []
  const all = root.getElementsByTagName('*')
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) result.push(all[i])
  }
  return result
}

function directChildrenByLocalName(node, localName) {
  const out = []
  for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === localName) out.push(c)
  }
  return out
}

// ── Word (.docx) 解析 ──

function extractDocxParagraphText(pNode) {
  let text = ''
  const walk = (node) => {
    for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
      const ln = c.localName
      if (ln === 't' || ln === 'delText') {
        text += c.textContent || ''
      } else if (ln === 'tab') {
        text += '\t'
      } else if (ln === 'br' || ln === 'cr') {
        text += '\n'
      } else if (ln === 'drawing' || ln === 'pict') {
        text += '[图片]'
      } else if (ln !== 'pPr' && ln !== 'rPr' && ln !== 'instrText') {
        walk(c)
      }
    }
  }
  walk(pNode)
  return text.trimEnd()
}

export async function parseDocx(buffer) {
  const zip = openZip(buffer)
  const docXml = await zip.readText('word/document.xml')
  if (!docXml) throw new Error('未在 DOCX 中找到 word/document.xml')

  const doc = parseXml(docXml)
  const body = getElementsByLocalName(doc, 'body')[0]
  if (!body) throw new Error('DOCX 正文为空')

  const lines = []
  for (let child = body.firstElementChild; child; child = child.nextElementSibling) {
    if (child.localName === 'p') {
      const pText = extractDocxParagraphText(child)
      if (pText) lines.push(pText)
    } else if (child.localName === 'tbl') {
      const trs = directChildrenByLocalName(child, 'tr')
      for (const tr of trs) {
        const tcs = directChildrenByLocalName(tr, 'tc')
        const cellTexts = tcs.map((tc) => {
          const ps = getElementsByLocalName(tc, 'p')
          return ps.map(extractDocxParagraphText).filter(Boolean).join(' / ')
        })
        lines.push('| ' + cellTexts.join(' | ') + ' |')
      }
    }
  }

  // 附加页眉、页脚与批注内容（如有）
  const extraParts = zip.names
    .filter((n) => /^word\/(header\d+|footer\d+|footnotes|comments)\.xml$/.test(n))
    .sort()
  for (const part of extraParts) {
    const xml = await zip.readText(part)
    if (!xml) continue
    const xdoc = parseXml(xml)
    const ps = getElementsByLocalName(xdoc, 'p')
    const partLines = ps.map(extractDocxParagraphText).filter(Boolean)
    if (partLines.length) {
      const label = part.includes('header')
        ? '页眉'
        : part.includes('footer')
          ? '页脚'
          : part.includes('comments')
            ? '批注'
            : '脚注'
      lines.push(`── ${label} ──`)
      lines.push(...partLines)
    }
  }

  return {
    kind: 'docx',
    text: lines.join('\n'),
    paragraphCount: lines.length
  }
}

// ── Excel (.xlsx / .csv / .tsv) 解析 ──

function colRefToIndex(ref) {
  const letters = (ref || '').replace(/[0-9]+$/g, '').toUpperCase()
  let idx = 0
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64)
  }
  return Math.max(0, idx - 1)
}

export function parseCsvText(text, delimiter = ',') {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false
  const clean = text.replace(/^\uFEFF/, '')

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && clean[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

export async function parseExcel(buffer, filename = '') {
  const ext = getExtension(filename)
  if (ext === 'csv' || ext === 'tsv') {
    const text = decodeTextBytes(buffer)
    const rows = parseCsvText(text, ext === 'tsv' ? '\t' : ',')
    return {
      kind: 'excel',
      sheets: [{ name: filename || 'Sheet1', rows, merges: [] }]
    }
  }

  const zip = openZip(buffer)
  const wbXml = await zip.readText('xl/workbook.xml')
  if (!wbXml) throw new Error('未在 XLSX 中找到 xl/workbook.xml')

  // 读取 sharedStrings
  const sharedStrings = []
  const sstXml = await zip.readText('xl/sharedStrings.xml')
  if (sstXml) {
    const sstDoc = parseXml(sstXml)
    for (const si of getElementsByLocalName(sstDoc, 'si')) {
      const ts = getElementsByLocalName(si, 't')
      sharedStrings.push(ts.map((t) => t.textContent || '').join(''))
    }
  }

  // 解析关系表（rId -> target path）
  const relMap = new Map()
  const relsXml = await zip.readText('xl/_rels/workbook.xml.rels')
  if (relsXml) {
    const relDoc = parseXml(relsXml)
    for (const rel of getElementsByLocalName(relDoc, 'Relationship')) {
      const id = rel.getAttribute('Id')
      const target = rel.getAttribute('Target')
      if (id && target) {
        const normalized = target.startsWith('/')
          ? target.slice(1)
          : target.startsWith('xl/')
            ? target
            : `xl/${target.replace(/^\.\//, '')}`
        relMap.set(id, normalized)
      }
    }
  }

  const wbDoc = parseXml(wbXml)
  const sheetNodes = getElementsByLocalName(wbDoc, 'sheet')
  const sheets = []

  for (let idx = 0; idx < sheetNodes.length; idx++) {
    const node = sheetNodes[idx]
    const name = node.getAttribute('name') || `Sheet${idx + 1}`
    const rId =
      node.getAttribute('r:id') ||
      node.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    const sheetPath = (rId && relMap.get(rId)) || `xl/worksheets/sheet${idx + 1}.xml`
    const sheetXml = await zip.readText(sheetPath)
    if (!sheetXml) continue

    const sDoc = parseXml(sheetXml)
    const rows = []
    const rowNodes = getElementsByLocalName(sDoc, 'row')

    for (const rNode of rowNodes) {
      const rAttr = Number(rNode.getAttribute('r'))
      const rowIdx = Number.isFinite(rAttr) && rAttr > 0 ? rAttr - 1 : rows.length
      while (rows.length <= rowIdx) rows.push([])
      const rowArr = rows[rowIdx]

      const cNodes = directChildrenByLocalName(rNode, 'c')
      let fallbackCol = 0
      for (const cNode of cNodes) {
        const ref = cNode.getAttribute('r')
        const colIdx = ref ? colRefToIndex(ref) : fallbackCol
        fallbackCol = colIdx + 1
        while (rowArr.length <= colIdx) rowArr.push('')

        const type = cNode.getAttribute('t') || ''
        let val = ''
        if (type === 'inlineStr') {
          val = getElementsByLocalName(cNode, 't')
            .map((t) => t.textContent || '')
            .join('')
        } else {
          const vNode = directChildrenByLocalName(cNode, 'v')[0]
          const raw = vNode ? vNode.textContent || '' : ''
          if (type === 's') {
            val = sharedStrings[Number(raw)] ?? ''
          } else if (type === 'b') {
            val = raw === '1' ? 'TRUE' : 'FALSE'
          } else {
            val = raw
          }
        }
        rowArr[colIdx] = val
      }
    }

    const merges = getElementsByLocalName(sDoc, 'mergeCell')
      .map((m) => m.getAttribute('ref'))
      .filter(Boolean)

    sheets.push({ name, rows, merges })
  }

  return { kind: 'excel', sheets }
}

// ── PPT (.pptx) 解析 ──

export async function parsePptx(buffer) {
  const zip = openZip(buffer)

  // 从 presentation.xml 读取真实幻灯片顺序
  const presXml = await zip.readText('ppt/presentation.xml')
  const presRelsXml = await zip.readText('ppt/_rels/presentation.xml.rels')
  const slidePaths = []

  if (presXml && presRelsXml) {
    const relMap = new Map()
    const relDoc = parseXml(presRelsXml)
    for (const rel of getElementsByLocalName(relDoc, 'Relationship')) {
      const id = rel.getAttribute('Id')
      const target = rel.getAttribute('Target')
      if (id && target) {
        const normalized = target.startsWith('/')
          ? target.slice(1)
          : target.startsWith('ppt/')
            ? target
            : `ppt/${target.replace(/^\.\//, '')}`
        relMap.set(id, normalized)
      }
    }
    const presDoc = parseXml(presXml)
    for (const sldId of getElementsByLocalName(presDoc, 'sldId')) {
      const rId =
        sldId.getAttribute('r:id') ||
        sldId.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
      if (rId && relMap.has(rId)) slidePaths.push(relMap.get(rId))
    }
  }

  if (!slidePaths.length) {
    const fallback = zip.names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number((a.match(/(\d+)/) || [0, 0])[1])
        const nb = Number((b.match(/(\d+)/) || [0, 0])[1])
        return na - nb
      })
    slidePaths.push(...fallback)
  }

  if (!slidePaths.length) throw new Error('未在 PPTX 中找到幻灯片内容')

  const slides = []
  for (let i = 0; i < slidePaths.length; i++) {
    const sp = slidePaths[i]
    const xml = await zip.readText(sp)
    if (!xml) continue
    const doc = parseXml(xml)
    const lines = []

    for (const p of getElementsByLocalName(doc, 'p')) {
      const texts = getElementsByLocalName(p, 't').map((t) => t.textContent || '')
      const line = texts.join('').trim()
      if (line) lines.push(line)
    }

    const pics = getElementsByLocalName(doc, 'pic').length
    if (pics > 0) lines.push(`[包含 ${pics} 张图片]`)

    // 查找对应演讲者备注
    const slideNum = (sp.match(/slide(\d+)\.xml$/) || [])[1]
    if (slideNum) {
      const notesXml = await zip.readText(`ppt/notesSlides/notesSlide${slideNum}.xml`)
      if (notesXml) {
        const nDoc = parseXml(notesXml)
        const noteLines = getElementsByLocalName(nDoc, 'p')
          .map((p) => getElementsByLocalName(p, 't').map((t) => t.textContent || '').join('').trim())
          .filter(Boolean)
        if (noteLines.length) {
          lines.push('── 备注 ──')
          lines.push(...noteLines)
        }
      }
    }

    slides.push({
      index: i + 1,
      title: lines[0] ? lines[0].slice(0, 36) : `第 ${i + 1} 页`,
      text: lines.join('\n')
    })
  }

  return { kind: 'pptx', slides }
}

// ── PDF (.pdf) 离线文本解析 ──

function decodePdfLiteralString(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\') {
      const next = raw[++i]
      if (next === 'n') out += '\n'
      else if (next === 'r') out += '\r'
      else if (next === 't') out += '\t'
      else if (next === 'b') out += '\b'
      else if (next === 'f') out += '\f'
      else if (next === '(' || next === ')' || next === '\\') out += next
      else if (next >= '0' && next <= '7') {
        let oct = next
        if (raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i]
        if (raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i]
        out += String.fromCharCode(parseInt(oct, 8))
      } else if (next === '\r' && raw[i + 1] === '\n') {
        i++
      } else if (next === '\n') {
        /* line continuation */
      } else if (next !== undefined) {
        out += next
      }
    } else {
      out += ch
    }
  }
  if (out.length >= 2 && out.charCodeAt(0) === 0xfe && out.charCodeAt(1) === 0xff) {
    let u16 = ''
    for (let i = 2; i + 1 < out.length; i += 2) {
      u16 += String.fromCharCode((out.charCodeAt(i) << 8) | out.charCodeAt(i + 1))
    }
    return u16
  }
  return out
}

function decodeHexToUnicode(hex, cmap) {
  const clean = hex.replace(/\s+/g, '')
  if (!clean) return ''
  if (cmap && cmap.size > 0) {
    // 先按 4 位十六进制（CID 常见）查 CMap，再按 2 位查
    let mapped = ''
    let matched = 0
    const step = clean.length % 4 === 0 ? 4 : 2
    for (let i = 0; i + step <= clean.length; i += step) {
      const code = clean.slice(i, i + step).toUpperCase()
      if (cmap.has(code)) {
        mapped += cmap.get(code)
        matched++
      } else if (step === 4 && cmap.has(code.slice(0, 2)) && cmap.has(code.slice(2, 4))) {
        mapped += cmap.get(code.slice(0, 2)) + cmap.get(code.slice(2, 4))
        matched++
      } else {
        const n = parseInt(code, 16)
        if (n >= 32 && n < 0xfff0) mapped += String.fromCharCode(n)
      }
    }
    if (matched > 0) return mapped
  }
  if (clean.startsWith('FEFF') || clean.startsWith('feff')) {
    let out = ''
    for (let i = 4; i + 3 < clean.length; i += 4) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16))
    }
    return out
  }
  let out = ''
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16)
    if (code >= 32 && code <= 126) out += String.fromCharCode(code)
    else if (code === 10 || code === 13 || code === 9) out += ' '
  }
  return out
}

function parseToUnicodeCMap(cmapText, cmap) {
  const bfCharBlocks = cmapText.match(/beginbfchar[\s\S]*?endbfchar/g) || []
  for (const block of bfCharBlocks) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const src = m[1].toUpperCase()
      const dstHex = m[2]
      let dst = ''
      for (let i = 0; i + 3 < dstHex.length; i += 4) {
        dst += String.fromCharCode(parseInt(dstHex.slice(i, i + 4), 16))
      }
      if (dst) cmap.set(src, dst)
    }
  }
  const bfRangeBlocks = cmapText.match(/beginbfrange[\s\S]*?endbfrange/g) || []
  for (const block of bfRangeBlocks) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(m[1], 16)
      const end = parseInt(m[2], 16)
      const pad = m[1].length
      let base = parseInt(m[3], 16)
      const limit = Math.min(end, start + 512)
      for (let c = start; c <= limit; c++) {
        const key = c.toString(16).toUpperCase().padStart(pad, '0')
        cmap.set(key, String.fromCharCode(base++))
      }
    }
  }
}

function extractTextFromPdfStream(streamStr, cmap) {
  const lines = []
  let current = ''
  const flush = () => {
    const trimmed = current.replace(/\s+/g, ' ').trim()
    if (trimmed) lines.push(trimmed)
    current = ''
  }

  // 解析 BT ... ET 块
  const btRegex = /BT\b([\s\S]*?)\bET/g
  let match
  while ((match = btRegex.exec(streamStr)) !== null) {
    const block = match[1]
    let i = 0
    while (i < block.length) {
      const ch = block[i]
      if (ch === '(') {
        // 读取括号字面量
        let depth = 1
        let j = i + 1
        while (j < block.length && depth > 0) {
          if (block[j] === '\\') {
            j += 2
            continue
          }
          if (block[j] === '(') depth++
          else if (block[j] === ')') depth--
          j++
        }
        const literal = block.slice(i + 1, j - 1)
        const after = block.slice(j, j + 8)
        if (/^\s*(Tj|'|")/.test(after)) {
          current += decodePdfLiteralString(literal)
          if (/^\s*['"]/.test(after)) flush()
        }
        i = j
        continue
      }
      if (ch === '<' && block[i + 1] !== '<') {
        const end = block.indexOf('>', i + 1)
        if (end > i) {
          const hex = block.slice(i + 1, end)
          const after = block.slice(end + 1, end + 9)
          if (/^\s*(Tj|'|")/.test(after)) {
            current += decodeHexToUnicode(hex, cmap)
          }
          i = end + 1
          continue
        }
      }
      if (ch === '[') {
        // TJ 数组
        let j = i + 1
        let arrText = ''
        while (j < block.length && block[j] !== ']') {
          if (block[j] === '(') {
            let depth = 1
            let k = j + 1
            while (k < block.length && depth > 0) {
              if (block[k] === '\\') {
                k += 2
                continue
              }
              if (block[k] === '(') depth++
              else if (block[k] === ')') depth--
              k++
            }
            arrText += decodePdfLiteralString(block.slice(j + 1, k - 1))
            j = k
          } else if (block[j] === '<' && block[j + 1] !== '<') {
            const k = block.indexOf('>', j + 1)
            if (k < 0) break
            arrText += decodeHexToUnicode(block.slice(j + 1, k), cmap)
            j = k + 1
          } else if (block[j] === '-' || (block[j] >= '0' && block[j] <= '9')) {
            let k = j + 1
            while (k < block.length && /[0-9.]/.test(block[k])) k++
            const num = Number(block.slice(j, k))
            if (num < -180) arrText += ' '
            j = k
          } else {
            j++
          }
        }
        const after = block.slice(j + 1, j + 8)
        if (/^\s*TJ/.test(after)) {
          current += arrText
        }
        i = j + 1
        continue
      }
      if (ch === 'T' && (block[i + 1] === '*' || block[i + 1] === 'd' || block[i + 1] === 'D')) {
        flush()
        i += 2
        continue
      }
      i++
    }
    flush()
  }
  return lines.join('\n')
}

function bytesToBinaryString(bytes) {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return out
}

export async function parsePdf(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  // 使用 1:1 字节映射，避免 WHATWG TextDecoder('latin1') 按 windows-1252 改写 0x80-0x9F 字节破坏 zlib 流
  const latin1 = bytesToBinaryString(bytes)
  if (!latin1.startsWith('%PDF-')) {
    throw new Error('文件不是有效的 PDF 文档')
  }
  if (/\/Encrypt\b/.test(latin1)) {
    throw new Error('该 PDF 受密码或权限加密保护，请解除保护后再比较')
  }

  // 解析所有间接对象及其流（保留精确字节偏移）
  const objects = new Map()
  const objRegex = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g
  let m
  while ((m = objRegex.exec(latin1)) !== null) {
    const bodyOffset = m.index + m[0].indexOf(m[3])
    objects.set(Number(m[1]), { body: m[3], offset: bodyOffset })
  }

  // 解压所有流，先收集 ToUnicode CMap，再收集内容流
  const decompressedStreams = new Map()
  const cmap = new Map()

  for (const [objId, { body, offset }] of objects.entries()) {
    const sIdx = body.indexOf('stream')
    const eIdx = body.lastIndexOf('endstream')
    if (sIdx < 0 || eIdx <= sIdx) continue
    const dict = body.slice(0, sIdx)
    let dataStart = sIdx + 6
    if (body[dataStart] === '\r' && body[dataStart + 1] === '\n') dataStart += 2
    else if (body[dataStart] === '\n' || body[dataStart] === '\r') dataStart += 1
    let dataEnd = eIdx
    if (dataEnd > dataStart && body[dataEnd - 1] === '\n') dataEnd--
    if (dataEnd > dataStart && body[dataEnd - 1] === '\r') dataEnd--

    const rawBytes = bytes.subarray(offset + dataStart, offset + dataEnd)

    let streamText = ''
    if (/\/FlateDecode\b/.test(dict)) {
      try {
        const inflated = await inflateBytes(rawBytes, false)
        streamText = bytesToBinaryString(inflated)
      } catch {
        try {
          const inflated = await inflateBytes(rawBytes, true)
          streamText = bytesToBinaryString(inflated)
        } catch {
          continue
        }
      }
    } else if (!/\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(dict)) {
      streamText = body.slice(dataStart, dataEnd)
    }

    if (!streamText) continue
    decompressedStreams.set(objId, streamText)
    if (streamText.includes('begincmap') || streamText.includes('beginbfchar') || streamText.includes('beginbfrange')) {
      parseToUnicodeCMap(streamText, cmap)
    }
  }

  // 按 /Type /Page 对象的 /Contents 引用分页组装文本
  const pages = []
  for (const [, { body }] of objects.entries()) {
    if (!/\/Type\s*\/Page\b(?!s)/.test(body)) continue
    const refs = []
    const arrMatch = body.match(/\/Contents\s*\[([\s\S]*?)\]/)
    if (arrMatch) {
      for (const r of arrMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(r[1]))
    } else {
      const single = body.match(/\/Contents\s+(\d+)\s+\d+\s+R/)
      if (single) refs.push(Number(single[1]))
    }
    const pageChunks = []
    for (const refId of refs) {
      const streamText = decompressedStreams.get(refId)
      if (!streamText) continue
      const extracted = extractTextFromPdfStream(streamText, cmap)
      if (extracted) pageChunks.push(extracted)
    }
    pages.push({
      index: pages.length + 1,
      text: pageChunks.join('\n')
    })
  }

  // 若未能通过 Page 字典映射（如对象流压缩），直接从含 BT..ET 的流提取
  if (!pages.length || pages.every((p) => !p.text)) {
    const fallbackPages = []
    for (const [, streamText] of decompressedStreams.entries()) {
      if (!streamText.includes('BT')) continue
      const extracted = extractTextFromPdfStream(streamText, cmap)
      if (extracted) {
        fallbackPages.push({ index: fallbackPages.length + 1, text: extracted })
      }
    }
    if (fallbackPages.length) {
      return { kind: 'pdf', pages: fallbackPages, scannedNotice: false }
    }
  }

  const hasText = pages.some((p) => p.text.trim().length > 0)
  return {
    kind: 'pdf',
    pages: pages.length ? pages : [{ index: 1, text: '' }],
    scannedNotice: !hasText
  }
}
