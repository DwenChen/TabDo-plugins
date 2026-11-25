/**
 * 本地离线差异比对引擎与报告生成器。
 * 支持：
 * 1. Myers O(ND) 序列差分 + 前后缀裁剪（大文本快速收敛）
 * 2. 中英文友好词/字符级内联差异高亮
 * 3. Excel 二维表格比对与列顺序调整识别
 * 4. 独立可离线浏览的 HTML 报告与 UTF-8 BOM CSV 报告生成
 */

const MAX_EXACT_DIFF_STEPS = 8000

/**
 * 对两个字符串数组执行 Myers 差分，返回操作序列：
 * { type: 'equal' | 'del' | 'add', leftIndex, rightIndex, value }
 */
export function diffSequence(leftItems, rightItems, compareFn) {
  const eq = compareFn || ((a, b) => a === b)
  const nTotal = leftItems.length
  const mTotal = rightItems.length

  // 前后缀裁剪，显著减少常见编辑场景的搜索空间
  let prefix = 0
  while (prefix < nTotal && prefix < mTotal && eq(leftItems[prefix], rightItems[prefix])) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < nTotal - prefix &&
    suffix < mTotal - prefix &&
    eq(leftItems[nTotal - 1 - suffix], rightItems[mTotal - 1 - suffix])
  ) {
    suffix++
  }

  const a = leftItems.slice(prefix, nTotal - suffix)
  const b = rightItems.slice(prefix, mTotal - suffix)
  const ops = []

  for (let i = 0; i < prefix; i++) {
    ops.push({ type: 'equal', leftIndex: i, rightIndex: i, value: leftItems[i] })
  }

  const midOps = myersCore(a, b, eq)
  for (const op of midOps) {
    ops.push({
      type: op.type,
      leftIndex: op.leftIndex >= 0 ? op.leftIndex + prefix : -1,
      rightIndex: op.rightIndex >= 0 ? op.rightIndex + prefix : -1,
      value: op.value
    })
  }

  for (let i = 0; i < suffix; i++) {
    const li = nTotal - suffix + i
    const ri = mTotal - suffix + i
    ops.push({ type: 'equal', leftIndex: li, rightIndex: ri, value: leftItems[li] })
  }

  return ops
}

function myersCore(a, b, eq) {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return b.map((value, idx) => ({ type: 'add', leftIndex: -1, rightIndex: idx, value }))
  if (m === 0) return a.map((value, idx) => ({ type: 'del', leftIndex: idx, rightIndex: -1, value }))

  const maxD = Math.min(n + m, MAX_EXACT_DIFF_STEPS)
  const offset = maxD
  const v = new Int32Array(2 * maxD + 1)
  v.fill(-1)
  v[offset + 1] = 0
  const trace = []

  let foundD = -1
  for (let d = 0; d <= maxD; d++) {
    const snapshot = new Int32Array(2 * d + 1)
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]
      } else {
        x = v[offset + k - 1] + 1
      }
      let y = x - k
      while (x < n && y < m && eq(a[x], b[y])) {
        x++
        y++
      }
      v[offset + k] = x
      snapshot[k + d] = x
      if (x >= n && y >= m) {
        trace.push(snapshot)
        foundD = d
        break
      }
    }
    if (foundD >= 0) break
    trace.push(snapshot)
  }

  if (foundD < 0) {
    // 差异量超大时回退为按索引配对，避免卡顿或内存飙升
    return fallbackLinearDiff(a, b, eq)
  }

  const rev = []
  let x = n
  let y = m
  for (let d = foundD; d > 0; d--) {
    const prev = trace[d - 1]
    const k = x - y
    const prevK =
      k === -d || (k !== d && prev[k - 1 + (d - 1)] < prev[k + 1 + (d - 1)]) ? k + 1 : k - 1
    const prevX = prev[prevK + (d - 1)]
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      rev.push({ type: 'equal', leftIndex: x - 1, rightIndex: y - 1, value: a[x - 1] })
      x--
      y--
    }
    if (x === prevX) {
      rev.push({ type: 'add', leftIndex: -1, rightIndex: y - 1, value: b[y - 1] })
      y--
    } else {
      rev.push({ type: 'del', leftIndex: x - 1, rightIndex: -1, value: a[x - 1] })
      x--
    }
  }
  while (x > 0 && y > 0) {
    rev.push({ type: 'equal', leftIndex: x - 1, rightIndex: y - 1, value: a[x - 1] })
    x--
    y--
  }
  rev.reverse()
  return rev
}

function fallbackLinearDiff(a, b, eq) {
  const ops = []
  const maxLen = Math.max(a.length, b.length)
  for (let i = 0; i < maxLen; i++) {
    if (i < a.length && i < b.length && eq(a[i], b[i])) {
      ops.push({ type: 'equal', leftIndex: i, rightIndex: i, value: a[i] })
    } else {
      if (i < a.length) ops.push({ type: 'del', leftIndex: i, rightIndex: -1, value: a[i] })
      if (i < b.length) ops.push({ type: 'add', leftIndex: -1, rightIndex: i, value: b[i] })
    }
  }
  return ops
}

/**
 * 规范化单行以支持忽略空白/忽略大小写选项。
 */
function normalizeLine(line, { ignoreWhitespace = false, ignoreCase = false } = {}) {
  let out = line
  if (ignoreWhitespace) out = out.replace(/\s+/g, ' ').trim()
  if (ignoreCase) out = out.toLowerCase()
  return out
}

/**
 * 按行比对两段文本，返回对齐后的双栏行列表、差异块索引和统计信息。
 */
export function diffLines(leftText, rightText, options = {}) {
  const leftRaw = leftText ? leftText.replace(/\r\n?/g, '\n').split('\n') : []
  const rightRaw = rightText ? rightText.replace(/\r\n?/g, '\n').split('\n') : []
  const normLeft = leftRaw.map((l) => normalizeLine(l, options))
  const normRight = rightRaw.map((l) => normalizeLine(l, options))

  const ops = diffSequence(normLeft, normRight)
  const rows = []
  const hunks = []
  let added = 0
  let removed = 0
  let modified = 0

  let i = 0
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      const li = ops[i].leftIndex
      const ri = ops[i].rightIndex
      rows.push({
        type: 'equal',
        leftNum: li + 1,
        rightNum: ri + 1,
        leftText: leftRaw[li],
        rightText: rightRaw[ri],
        hunkIndex: -1
      })
      i++
      continue
    }

    const delGroup = []
    const addGroup = []
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'del') delGroup.push(ops[i].leftIndex)
      else addGroup.push(ops[i].rightIndex)
      i++
    }

    const hunkIdx = hunks.length
    hunks.push({ index: hunkIdx, startRow: rows.length })

    const pairCount = Math.min(delGroup.length, addGroup.length)
    for (let p = 0; p < pairCount; p++) {
      const lt = leftRaw[delGroup[p]]
      const rt = rightRaw[addGroup[p]]
      modified++
      rows.push({
        type: 'modified',
        leftNum: delGroup[p] + 1,
        rightNum: addGroup[p] + 1,
        leftText: lt,
        rightText: rt,
        inline: lt.length + rt.length <= 4000 ? diffInlineTokens(lt, rt) : null,
        hunkIndex: hunkIdx
      })
    }
    for (let p = pairCount; p < delGroup.length; p++) {
      removed++
      rows.push({
        type: 'removed',
        leftNum: delGroup[p] + 1,
        rightNum: null,
        leftText: leftRaw[delGroup[p]],
        rightText: '',
        hunkIndex: hunkIdx
      })
    }
    for (let p = pairCount; p < addGroup.length; p++) {
      added++
      rows.push({
        type: 'added',
        leftNum: null,
        rightNum: addGroup[p] + 1,
        leftText: '',
        rightText: rightRaw[addGroup[p]],
        hunkIndex: hunkIdx
      })
    }
  }

  return {
    rows,
    hunks,
    stats: {
      hunkCount: hunks.length,
      added,
      removed,
      modified,
      totalChanges: added + removed + modified,
      leftLines: leftRaw.length,
      rightLines: rightRaw.length,
      identical: hunks.length === 0
    }
  }
}

/**
 * 中英文分词：英文标识符/数字保持词组，中文逐字切分，使内联差异既清晰又精细。
 */
function tokenizeInline(str) {
  if (!str) return []
  return str.match(/[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]/g) || [str]
}

export function diffInlineTokens(leftStr, rightStr) {
  const a = tokenizeInline(leftStr)
  const b = tokenizeInline(rightStr)
  const ops = diffSequence(a, b)
  const leftSegs = []
  const rightSegs = []

  const pushSeg = (arr, kind, text) => {
    if (!text) return
    if (arr.length && arr[arr.length - 1].kind === kind) {
      arr[arr.length - 1].text += text
    } else {
      arr.push({ kind, text })
    }
  }

  for (const op of ops) {
    if (op.type === 'equal') {
      pushSeg(leftSegs, 'eq', op.value)
      pushSeg(rightSegs, 'eq', op.value)
    } else if (op.type === 'del') {
      pushSeg(leftSegs, 'del', op.value)
    } else {
      pushSeg(rightSegs, 'add', op.value)
    }
  }
  return { leftSegs, rightSegs }
}

/**
 * 列号转 Excel 列字母（0 -> A, 25 -> Z, 26 -> AA）。
 */
export function colIndexToLetter(col) {
  let n = col + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/**
 * 对比两张二维工作表，识别列顺序调整与单元格级增删改。
 */
export function diffSheetGrid(leftRows = [], rightRows = []) {
  const maxCols = Math.max(
    leftRows.reduce((m, r) => Math.max(m, r.length), 0),
    rightRows.reduce((m, r) => Math.max(m, r.length), 0)
  )
  const maxRows = Math.max(leftRows.length, rightRows.length)

  // 检测表头列顺序是否整体调整（第 1 行存在非空唯一表头集合完全一致但顺序不同）
  let reorderedColumns = []
  if (leftRows.length > 0 && rightRows.length > 0) {
    const lh = leftRows[0].map((v) => String(v ?? '').trim())
    const rh = rightRows[0].map((v) => String(v ?? '').trim())
    if (lh.length >= 2 && lh.length === rh.length) {
      const nonEmpty = lh.every(Boolean)
      const uniqL = new Set(lh)
      const uniqR = new Set(rh)
      if (nonEmpty && uniqL.size === lh.length && uniqR.size === rh.length) {
        const sameSet = lh.every((h) => uniqR.has(h))
        if (sameSet) {
          for (let c = 0; c < lh.length; c++) {
            const newIdx = rh.indexOf(lh[c])
            if (newIdx !== c) {
              reorderedColumns.push({
                header: lh[c],
                fromCol: colIndexToLetter(c),
                toCol: colIndexToLetter(newIdx)
              })
            }
          }
        }
      }
    }
  }

  const diffRows = []
  let added = 0
  let removed = 0
  let modified = 0
  const changes = []

  for (let r = 0; r < maxRows; r++) {
    const lr = leftRows[r] || null
    const rr = rightRows[r] || null
    const cells = []
    let rowStatus = 'equal'

    for (let c = 0; c < maxCols; c++) {
      const lv = lr && c < lr.length ? String(lr[c] ?? '') : ''
      const rv = rr && c < rr.length ? String(rr[c] ?? '') : ''
      let status = 'equal'
      if (lv !== rv) {
        if (!lv && rv) {
          status = 'added'
          added++
        } else if (lv && !rv) {
          status = 'removed'
          removed++
        } else {
          status = 'modified'
          modified++
        }
        rowStatus = status === 'equal' ? rowStatus : 'changed'
        changes.push({
          row: r + 1,
          col: c + 1,
          pos: `${colIndexToLetter(c)}${r + 1}`,
          type: status,
          left: lv,
          right: rv
        })
      }
      cells.push({ col: c, left: lv, right: rv, status })
    }

    if (!lr && rr) rowStatus = 'added'
    else if (lr && !rr) rowStatus = 'removed'

    diffRows.push({ rowNum: r + 1, status: rowStatus, cells })
  }

  return {
    maxRows,
    maxCols,
    rows: diffRows,
    changes,
    reorderedColumns,
    stats: {
      added,
      removed,
      modified,
      totalChanges: added + removed + modified,
      identical: added + removed + modified === 0
    }
  }
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 生成可独立离线打开的 HTML 差异报告。
 */
export function buildHtmlReport({
  title,
  kindLabel,
  leftName,
  rightName,
  summary = [],
  note = '',
  entries = []
}) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const typeBadge = {
    added: '<span class="badge add">新增</span>',
    removed: '<span class="badge del">删除</span>',
    modified: '<span class="badge mod">修改</span>',
    changed: '<span class="badge mod">不同</span>',
    leftOnly: '<span class="badge del">仅左侧</span>',
    rightOnly: '<span class="badge add">仅右侧</span>',
    typeDiff: '<span class="badge mod">类型不同</span>',
    metaDiff: '<span class="badge meta">仅时间/大小不同</span>'
  }

  const summaryHtml = summary
    .map(
      (item) =>
        `<div class="stat"><div class="stat-label">${escapeHtml(item.label)}</div><div class="stat-val">${escapeHtml(item.value)}</div></div>`
    )
    .join('')

  const rowsHtml = entries.length
    ? entries
        .map(
          (item, idx) => `<tr>
            <td class="num">${idx + 1}</td>
            <td class="pos">${escapeHtml(item.position || '-')}</td>
            <td class="type">${typeBadge[item.type] || escapeHtml(item.type)}</td>
            <td class="code">${escapeHtml(truncateText(item.left, 2000))}</td>
            <td class="code">${escapeHtml(truncateText(item.right, 2000))}</td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="empty">没有发现差异。</td></tr>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f8fafc; --card: #ffffff; --fg: #1e293b; --muted: #64748b; --border: #e2e8f0; --accent: #059669; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f172a; --card: #1e293b; --fg: #e2e8f0; --muted: #94a3b8; --border: #334155; --accent: #34d399; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg); font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1200px; margin: 0 auto; }
  .head { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  h1 { margin: 0 0 6px; font-size: 18px; }
  .meta { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 14px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .stat { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; min-width: 110px; }
  .stat-label { font-size: 11px; color: var(--muted); }
  .stat-val { font-size: 16px; font-weight: 600; color: var(--accent); }
  .note { margin-top: 10px; font-size: 12px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; table-layout: fixed; }
  th, td { border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; word-break: break-word; }
  th { background: var(--bg); font-weight: 600; font-size: 12px; color: var(--muted); }
  td.num { width: 46px; color: var(--muted); }
  td.pos { width: 140px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  td.type { width: 88px; }
  td.code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre-wrap; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .badge.add { background: rgba(16, 185, 129, 0.16); color: #059669; }
  .badge.del { background: rgba(239, 68, 68, 0.16); color: #dc2626; }
  .badge.mod { background: rgba(245, 158, 11, 0.18); color: #d97706; }
  .badge.meta { background: rgba(100, 116, 139, 0.16); color: #64748b; }
  .empty { text-align: center; padding: 28px; color: var(--muted); }
  footer { margin-top: 16px; color: var(--muted); font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      <span>类型：${escapeHtml(kindLabel)}</span>
      <span>左侧：${escapeHtml(leftName || '未命名')}</span>
      <span>右侧：${escapeHtml(rightName || '未命名')}</span>
      <span>生成时间：${escapeHtml(now)}</span>
    </div>
    ${summaryHtml ? `<div class="stats">${summaryHtml}</div>` : ''}
    ${note ? `<div class="note">${escapeHtml(note)}</div>` : ''}
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:46px">#</th>
        <th style="width:140px">位置</th>
        <th style="width:88px">类型</th>
        <th>左侧内容</th>
        <th>右侧内容</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <footer>由 TabDo「差异比较」本地生成，仅包含差异条目。</footer>
</div>
</body>
</html>`
}

function truncateText(text, maxLen) {
  const s = String(text ?? '')
  if (s.length <= maxLen) return s
  return `${s.slice(0, maxLen)}…（已截断，原文 ${s.length} 字符）`
}

/**
 * 生成带 UTF-8 BOM 的 CSV（Excel 打开不乱码）。
 */
export function buildCsvReport(headers, rows) {
  const esc = (cell) => {
    const s = String(cell ?? '')
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const lines = [headers.map(esc).join(',')]
  for (const row of rows) {
    lines.push(row.map(esc).join(','))
  }
  return '\uFEFF' + lines.join('\r\n')
}
