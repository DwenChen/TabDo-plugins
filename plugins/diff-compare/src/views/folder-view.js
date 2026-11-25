/**
 * 文件夹对比视图。
 * 特性：
 * - 基于 preload 白名单授权的安全本地递归扫描（支持取消与代际替换）
 * - 后台受控并发（4）SHA-256 及文本/OOXML 规范化内容指纹比对
 * - 目录逐级钻取 + 面包屑导航 + 仅差异/关键词过滤
 * - 点击任意两侧同名文件可在底部预览区查看文本差异，或一键跳转对应专用对比页
 * - 导出 HTML / CSV 差异报告（走 scope.runTask）
 */

import { diffLines, escapeHtml, buildHtmlReport, buildCsvReport } from '../diff-engine.js'
import { detectFileKind, decodeTextBytes, isLikelyBinary } from '../parsers.js'
import { scope, preloadApi, addManagedListener, saveExportTask } from '../tabdo-bridge.js'

const MAX_HASH_PAIRS = 3000
const HASH_CONCURRENCY = 4

const STATUS_LABEL = {
  same: '一致',
  metaDiff: '仅时间/大小不同',
  changed: '内容不同',
  leftOnly: '仅左侧',
  rightOnly: '仅右侧',
  typeDiff: '类型不同'
}

const STATUS_PILL = {
  same: 'same',
  metaDiff: '',
  changed: 'mod',
  leftOnly: 'del',
  rightOnly: 'add',
  typeDiff: 'mod'
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function formatTime(ms) {
  if (!ms) return '-'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function joinChildPath(root, rel) {
  const sep = root.includes('\\') ? '\\' : '/'
  const cleanRoot = root.replace(/[\\/]+$/, '')
  return `${cleanRoot}${sep}${rel.split('/').join(sep)}`
}

export function createFolderView(container, { showToast, openPairInTab }) {
  const state = {
    leftRoot: '',
    rightRoot: '',
    leftName: '',
    rightName: '',
    leftMap: new Map(), // rel -> node
    rightMap: new Map(),
    entries: new Map(), // rel -> merged entry
    currentPrefix: '',
    onlyDiff: false,
    search: '',
    selectedRel: '',
    scanToken: 0,
    activeScanIds: [],
    hashingDone: 0,
    hashingTotal: 0,
    scanning: false
  }

  // 会话退出时取消所有在途扫描
  scope.addCleanup(() => {
    cancelActiveScans()
  })

  container.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-group">
        <button type="button" class="btn" data-act="pick-left">选左侧文件夹</button>
        <button type="button" class="btn" data-act="pick-right">选右侧文件夹</button>
        <button type="button" class="btn" data-act="rescan">重新扫描</button>
        <button type="button" class="btn" data-act="swap">互换</button>
      </div>
      <label class="ctrl-check"><input type="checkbox" data-opt="onlyDiff" />仅差异</label>
      <input type="search" class="ctrl-input" data-el="search" placeholder="筛选文件名或路径…" style="width:170px" />
      <div class="toolbar-spacer"></div>
      <span class="stat-pill" data-el="stat">请选择左右两个文件夹</span>
      <div class="toolbar-group">
        <button type="button" class="btn" data-act="export-html">导出 HTML</button>
        <button type="button" class="btn" data-act="export-csv">导出 CSV</button>
        <button type="button" class="btn" data-act="clear">清空</button>
      </div>
    </div>
    <div class="split-panes" data-el="empty-panes">
      <div class="drop-card" data-fdrop="left">
        <div class="drop-card__title">左侧文件夹</div>
        <div class="drop-card__hint">点击选择本地文件夹，或将文件夹直接拖入此处</div>
        <div class="drop-card__file" data-el="empty-left"></div>
        <button type="button" class="btn btn-primary" data-act="pick-left">选择左侧文件夹</button>
      </div>
      <div class="drop-card" data-fdrop="right">
        <div class="drop-card__title">右侧文件夹</div>
        <div class="drop-card__hint">点击选择本地文件夹，或将文件夹直接拖入此处</div>
        <div class="drop-card__file" data-el="empty-right"></div>
        <button type="button" class="btn btn-primary" data-act="pick-right">选择右侧文件夹</button>
      </div>
    </div>
    <div class="folder-body hidden" data-el="folder-body">
      <div class="folder-breadcrumb" data-el="breadcrumb"></div>
      <div class="folder-table-wrap">
        <table class="folder-table">
          <thead>
            <tr>
              <th style="width:34%">名称</th>
              <th style="width:14%">状态</th>
              <th style="width:13%">左侧大小</th>
              <th style="width:13%">右侧大小</th>
              <th style="width:13%">左侧时间</th>
              <th style="width:13%">右侧时间</th>
            </tr>
          </thead>
          <tbody data-el="tbody"></tbody>
        </table>
      </div>
      <div class="folder-preview-drawer hidden" data-el="preview">
        <div class="pane-header">
          <span class="pane-header__name" data-el="preview-title">文件差异预览</span>
          <div class="pane-header__actions">
            <button type="button" class="btn" data-act="open-in-tab">在专用页打开</button>
            <button type="button" class="btn" data-act="close-preview">关闭</button>
          </div>
        </div>
        <div class="diff-scroll-wrap" data-el="preview-body" style="padding:8px"></div>
      </div>
    </div>
  `

  const elEmptyPanes = container.querySelector('[data-el="empty-panes"]')
  const elFolderBody = container.querySelector('[data-el="folder-body"]')
  const elEmptyLeft = container.querySelector('[data-el="empty-left"]')
  const elEmptyRight = container.querySelector('[data-el="empty-right"]')
  const elStat = container.querySelector('[data-el="stat"]')
  const elBreadcrumb = container.querySelector('[data-el="breadcrumb"]')
  const elTbody = container.querySelector('[data-el="tbody"]')
  const elSearch = container.querySelector('[data-el="search"]')
  const elPreview = container.querySelector('[data-el="preview"]')
  const elPreviewTitle = container.querySelector('[data-el="preview-title"]')
  const elPreviewBody = container.querySelector('[data-el="preview-body"]')

  function cancelActiveScans() {
    if (preloadApi && typeof preloadApi.cancelScan === 'function') {
      for (const id of state.activeScanIds) preloadApi.cancelScan(id)
    }
    state.activeScanIds = []
  }

  function flattenTree(nodes, map) {
    for (const node of nodes || []) {
      map.set(node.rel, node)
      if (node.isDir && Array.isArray(node.children)) {
        flattenTree(node.children, map)
      }
    }
  }

  function rebuildMergedEntries() {
    state.entries.clear()
    const allRels = new Set([...state.leftMap.keys(), ...state.rightMap.keys()])
    for (const rel of allRels) {
      const left = state.leftMap.get(rel) || null
      const right = state.rightMap.get(rel) || null
      const parts = rel.split('/')
      const name = parts[parts.length - 1]
      const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
      const isDir = Boolean((left && left.isDir) || (right && right.isDir))

      let status = 'same'
      if (left && !right) status = 'leftOnly'
      else if (!left && right) status = 'rightOnly'
      else if (left.isDir !== right.isDir) status = 'typeDiff'
      else if (!left.isDir) {
        if (left.size !== right.size) status = 'changed'
        else if (Math.abs((left.mtime || 0) - (right.mtime || 0)) > 2000) status = 'metaDiff'
        else status = 'same'
      }

      state.entries.set(rel, {
        rel,
        name,
        parent,
        isDir,
        left,
        right,
        status,
        leftHash: '',
        rightHash: ''
      })
    }
    propagateDirStatus()
  }

  function propagateDirStatus() {
    // 目录状态由其子项聚合：只要后代存在任意非 same 差异，目录即标为 changed
    const dirs = Array.from(state.entries.values())
      .filter((e) => e.isDir && e.left && e.right && e.status !== 'typeDiff')
      .sort((a, b) => b.rel.split('/').length - a.rel.split('/').length)

    for (const dir of dirs) {
      let hasDiff = false
      const prefix = dir.rel + '/'
      for (const entry of state.entries.values()) {
        if (entry.rel.startsWith(prefix) && entry.status !== 'same' && entry.status !== 'metaDiff') {
          hasDiff = true
          break
        }
      }
      dir.status = hasDiff ? 'changed' : 'same'
    }
  }

  function updateSummaryStat() {
    if (!state.leftRoot || !state.rightRoot) {
      elStat.className = 'stat-pill'
      elStat.textContent = state.leftRoot || state.rightRoot ? '已选 1 个文件夹，等待另一侧' : '请选择左右两个文件夹'
      return
    }
    if (state.scanning) {
      elStat.className = 'stat-pill'
      elStat.textContent = '正在扫描文件夹…'
      return
    }

    let same = 0
    let changed = 0
    let leftOnly = 0
    let rightOnly = 0
    for (const e of state.entries.values()) {
      if (e.isDir && e.status === 'same') continue
      if (e.status === 'same' || e.status === 'metaDiff') same++
      else if (e.status === 'leftOnly') leftOnly++
      else if (e.status === 'rightOnly') rightOnly++
      else changed++
    }

    const hashNote =
      state.hashingTotal > 0 && state.hashingDone < state.hashingTotal
        ? ` · 指纹校验 ${state.hashingDone}/${state.hashingTotal}`
        : ''
    const totalDiff = changed + leftOnly + rightOnly
    elStat.className = totalDiff === 0 ? 'stat-pill same' : 'stat-pill mod'
    elStat.textContent =
      totalDiff === 0
        ? `两侧一致（${same} 个文件）${hashNote}`
        : `不同 ${changed} · 仅左 ${leftOnly} · 仅右 ${rightOnly} · 一致 ${same}${hashNote}`
  }

  function renderView() {
    elEmptyLeft.textContent = state.leftRoot || ''
    elEmptyRight.textContent = state.rightRoot || ''
    const ready = Boolean(state.leftRoot && state.rightRoot)
    elEmptyPanes.classList.toggle('hidden', ready)
    elFolderBody.classList.toggle('hidden', !ready)
    updateSummaryStat()
    if (!ready) return

    // 面包屑
    const segs = state.currentPrefix ? state.currentPrefix.split('/') : []
    const crumbs = [
      `<button type="button" class="btn btn-ghost" data-crumb="" style="height:24px;padding:0 6px">${escapeHtml(state.leftName)} ⇄ ${escapeHtml(state.rightName)}</button>`
    ]
    let acc = ''
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg
      crumbs.push(`<span>/</span><button type="button" class="btn btn-ghost" data-crumb="${escapeHtml(acc)}" style="height:24px;padding:0 6px">${escapeHtml(seg)}</button>`)
    }
    elBreadcrumb.innerHTML = crumbs.join('')

    // 过滤当前层级（搜索时全局展开，否则按当前目录）
    const q = state.search.trim().toLowerCase()
    const list = []
    for (const entry of state.entries.values()) {
      if (q) {
        if (!entry.rel.toLowerCase().includes(q)) continue
      } else if (entry.parent !== state.currentPrefix) {
        continue
      }
      if (state.onlyDiff && (entry.status === 'same' || entry.status === 'metaDiff')) continue
      list.push(entry)
    }

    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })

    const rows = []
    if (!q && state.currentPrefix) {
      const parent = state.currentPrefix.includes('/')
        ? state.currentPrefix.slice(0, state.currentPrefix.lastIndexOf('/'))
        : ''
      rows.push(`<tr class="folder-row" data-up="${escapeHtml(parent)}"><td colspan="6">↩ 返回上一级目录</td></tr>`)
    }

    if (!list.length) {
      rows.push(`<tr><td colspan="6" class="empty-state">${state.onlyDiff ? '当前目录没有差异项。' : '当前目录为空。'}</td></tr>`)
    } else {
      for (const e of list) {
        const icon = e.isDir ? '📁 ' : '📄 '
        const displayName = q ? e.rel : e.name
        const pillCls = STATUS_PILL[e.status] || ''
        const selCls = e.rel === state.selectedRel ? 'selected' : ''
        rows.push(`<tr class="folder-row ${selCls}" data-rel="${escapeHtml(e.rel)}">
          <td title="${escapeHtml(e.rel)}">${icon}${escapeHtml(displayName)}</td>
          <td><span class="stat-pill ${pillCls}">${STATUS_LABEL[e.status] || e.status}</span></td>
          <td>${e.left && !e.left.isDir ? formatBytes(e.left.size) : '-'}</td>
          <td>${e.right && !e.right.isDir ? formatBytes(e.right.size) : '-'}</td>
          <td>${e.left ? formatTime(e.left.mtime) : '-'}</td>
          <td>${e.right ? formatTime(e.right.mtime) : '-'}</td>
        </tr>`)
      }
    }
    elTbody.innerHTML = rows.join('')
  }

  async function runScanBoth() {
    if (!state.leftRoot || !state.rightRoot) {
      renderView()
      return
    }
    if (!preloadApi || typeof preloadApi.scanDirectory !== 'function') {
      showToast('当前环境不支持读取本地文件夹')
      return
    }

    cancelActiveScans()
    const token = ++state.scanToken
    const leftId = token * 2
    const rightId = token * 2 + 1
    state.activeScanIds = [leftId, rightId]
    state.scanning = true
    state.hashingDone = 0
    state.hashingTotal = 0
    state.currentPrefix = ''
    state.selectedRel = ''
    elPreview.classList.add('hidden')
    renderView()

    const [lRes, rRes] = await Promise.all([
      preloadApi.scanDirectory(state.leftRoot, { scanId: leftId }),
      preloadApi.scanDirectory(state.rightRoot, { scanId: rightId })
    ])

    if (scope.signal.aborted || token !== state.scanToken) return
    state.scanning = false
    state.activeScanIds = []

    if (!lRes.ok || !rRes.ok) {
      showToast(lRes.error || rRes.error || '扫描文件夹失败')
      renderView()
      return
    }

    state.leftName = lRes.name
    state.rightName = rRes.name
    state.leftMap = new Map()
    state.rightMap = new Map()
    flattenTree(lRes.tree, state.leftMap)
    flattenTree(rRes.tree, state.rightMap)
    rebuildMergedEntries()
    renderView()

    // 后台执行有界并发内容指纹校验，精准区分“内容一致仅时间不同”与“内容真正不同”
    const pairs = Array.from(state.entries.values())
      .filter((e) => !e.isDir && e.left && e.right && e.status !== 'typeDiff')
      .slice(0, MAX_HASH_PAIRS)

    if (!pairs.length) return
    state.hashingTotal = pairs.length
    state.hashingDone = 0
    updateSummaryStat()

    let cursor = 0
    const worker = async () => {
      while (cursor < pairs.length) {
        if (scope.signal.aborted || token !== state.scanToken) return
        const item = pairs[cursor++]
        const kind = detectFileKind(item.name)
        const leftPath = joinChildPath(state.leftRoot, item.rel)
        const rightPath = joinChildPath(state.rightRoot, item.rel)
        const [lh, rh] = await Promise.all([
          preloadApi.hashFileAt(leftPath, { kind }),
          preloadApi.hashFileAt(rightPath, { kind })
        ])
        if (scope.signal.aborted || token !== state.scanToken) return
        if (lh.ok && rh.ok) {
          item.leftHash = lh.hash
          item.rightHash = rh.hash
          if (lh.hash === rh.hash) {
            const metaSame =
              item.left.size === item.right.size &&
              Math.abs((item.left.mtime || 0) - (item.right.mtime || 0)) <= 2000
            item.status = metaSame ? 'same' : 'metaDiff'
          } else {
            item.status = 'changed'
          }
        }
        state.hashingDone++
        if (state.hashingDone % 12 === 0 || state.hashingDone === state.hashingTotal) {
          propagateDirStatus()
          renderView()
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, pairs.length) }, worker))
    if (!scope.signal.aborted && token === state.scanToken) {
      propagateDirStatus()
      renderView()
    }
  }

  async function previewFileEntry(entry) {
    if (!entry || entry.isDir || !entry.left || !entry.right) return
    if (!preloadApi || typeof preloadApi.readFileAt !== 'function') return

    state.selectedRel = entry.rel
    renderView()
    elPreview.classList.remove('hidden')
    elPreviewTitle.textContent = `${entry.rel}（${STATUS_LABEL[entry.status]}）`
    elPreviewBody.innerHTML = `<div class="empty-state">正在读取文件…</div>`

    const kind = detectFileKind(entry.name)
    const leftPath = joinChildPath(state.leftRoot, entry.rel)
    const rightPath = joinChildPath(state.rightRoot, entry.rel)
    const [lr, rr] = await Promise.all([
      preloadApi.readFileAt(leftPath, { maxBytes: 4 * 1024 * 1024 }),
      preloadApi.readFileAt(rightPath, { maxBytes: 4 * 1024 * 1024 })
    ])
    if (scope.signal.aborted || state.selectedRel !== entry.rel) return
    if (!lr.ok || !rr.ok) {
      elPreviewBody.innerHTML = `<div class="empty-state">${escapeHtml(lr.error || rr.error || '读取文件失败')}</div>`
      return
    }

    if (kind === 'text' || (kind === 'unknown' && !isLikelyBinary(new Uint8Array(lr.data)) && !isLikelyBinary(new Uint8Array(rr.data)))) {
      const lt = decodeTextBytes(lr.data)
      const rt = decodeTextBytes(rr.data)
      const diff = diffLines(lt, rt)
      if (diff.stats.identical) {
        elPreviewBody.innerHTML = `<div class="empty-state">文件内容完全一致（${diff.stats.leftLines} 行）。</div>`
        return
      }
      const rows = diff.rows
        .filter((r) => r.type !== 'equal')
        .slice(0, 400)
        .map(
          (r) => `<tr class="diff-row-${r.type}">
            <td class="diff-ln cell-left">${r.leftNum ?? ''}</td>
            <td class="diff-code cell-left">${escapeHtml(r.leftText)}</td>
            <td class="diff-ln cell-right">${r.rightNum ?? ''}</td>
            <td class="diff-code cell-right">${escapeHtml(r.rightText)}</td>
          </tr>`
        )
        .join('')
      elPreviewBody.innerHTML = `<table class="diff-table wrap-lines"><thead><tr>
        <th class="diff-ln">#</th><th>左侧</th><th class="diff-ln">#</th><th>右侧</th>
      </tr></thead><tbody>${rows}</tbody></table>`
      return
    }

    if (['image', 'docx', 'excel', 'pdf', 'pptx'].includes(kind)) {
      elPreviewBody.innerHTML = `<div class="empty-state">此文件为 ${kind.toUpperCase()} 类型，请点击右上角「在专用页打开」进行完整可视化对比。</div>`
      return
    }

    elPreviewBody.innerHTML = `<div class="empty-state">该二进制格式暂不支持内联文本预览（左 ${formatBytes(lr.size)} / 右 ${formatBytes(rr.size)}）。</div>`
  }

  async function openSelectedInDedicatedTab() {
    const entry = state.entries.get(state.selectedRel)
    if (!entry || entry.isDir || !entry.left || !entry.right || !preloadApi) return
    const kind = detectFileKind(entry.name)
    const targetTab = ['image', 'docx', 'excel', 'pdf', 'pptx'].includes(kind) ? kind : 'text'
    const leftPath = joinChildPath(state.leftRoot, entry.rel)
    const rightPath = joinChildPath(state.rightRoot, entry.rel)
    const [lr, rr] = await Promise.all([preloadApi.readFileAt(leftPath), preloadApi.readFileAt(rightPath)])
    if (scope.signal.aborted) return
    if (!lr.ok || !rr.ok) {
      showToast(lr.error || rr.error || '读取文件失败')
      return
    }
    await openPairInTab(targetTab, [
      { name: `${state.leftName}/${entry.rel}`, buffer: lr.data },
      { name: `${state.rightName}/${entry.rel}`, buffer: rr.data }
    ])
  }

  async function exportReport(format) {
    const diffList = Array.from(state.entries.values())
      .filter((e) => e.status !== 'same')
      .sort((a, b) => a.rel.localeCompare(b.rel))
    if (!diffList.length) {
      showToast('当前两侧目录没有差异，无需导出')
      return
    }

    if (format === 'csv') {
      const csv = buildCsvReport(
        ['路径', '类型', '状态', '左侧大小', '右侧大小', '左侧时间', '右侧时间', '左侧指纹', '右侧指纹'],
        diffList.map((e) => [
          e.rel,
          e.isDir ? '文件夹' : '文件',
          STATUS_LABEL[e.status] || e.status,
          e.left && !e.left.isDir ? e.left.size : '',
          e.right && !e.right.isDir ? e.right.size : '',
          e.left ? formatTime(e.left.mtime) : '',
          e.right ? formatTime(e.right.mtime) : '',
          e.leftHash || '',
          e.rightHash || ''
        ])
      )
      const saved = await saveExportTask({
        data: new TextEncoder().encode(csv),
        defaultName: `文件夹差异报告-${Date.now()}.csv`,
        title: '导出文件夹差异 CSV',
        buttonLabel: '保存',
        filters: [{ name: 'CSV 表格', extensions: ['csv'] }],
        mimeType: 'text/csv;charset=utf-8'
      })
      if (!scope.signal.aborted && saved.ok) showToast(saved.downloaded ? 'CSV 已开始下载' : `已保存：${saved.path}`)
      return
    }

    const html = buildHtmlReport({
      title: '文件夹差异比较报告',
      kindLabel: '文件夹',
      leftName: state.leftRoot,
      rightName: state.rightRoot,
      summary: [
        { label: '差异条目', value: diffList.length },
        { label: '内容不同', value: diffList.filter((e) => e.status === 'changed').length },
        { label: '仅左侧', value: diffList.filter((e) => e.status === 'leftOnly').length },
        { label: '仅右侧', value: diffList.filter((e) => e.status === 'rightOnly').length }
      ],
      note: '指纹采用 SHA-256 前缀（文本按统一换行符规范化，OOXML 按内容 XML 规范化）。',
      entries: diffList.map((e) => ({
        position: e.rel,
        type: e.status,
        left: e.left
          ? `${e.left.isDir ? '目录' : formatBytes(e.left.size)} · ${formatTime(e.left.mtime)}${e.leftHash ? ` · ${e.leftHash}` : ''}`
          : '—',
        right: e.right
          ? `${e.right.isDir ? '目录' : formatBytes(e.right.size)} · ${formatTime(e.right.mtime)}${e.rightHash ? ` · ${e.rightHash}` : ''}`
          : '—'
      }))
    })
    const saved = await saveExportTask({
      data: new TextEncoder().encode(html),
      defaultName: `文件夹差异报告-${Date.now()}.html`,
      title: '导出文件夹差异报告',
      buttonLabel: '保存',
      filters: [{ name: 'HTML 报告', extensions: ['html'] }],
      mimeType: 'text/html;charset=utf-8'
    })
    if (!scope.signal.aborted && saved.ok) showToast(saved.downloaded ? '报告已开始下载' : `已保存：${saved.path}`)
  }

  async function pickFolder(side) {
    if (!preloadApi || typeof preloadApi.pickDirectory !== 'function') {
      showToast('文件夹对比需在 TabDo 桌面端运行')
      return
    }
    const dir = await preloadApi.pickDirectory({ title: side === 'left' ? '选择左侧文件夹' : '选择右侧文件夹' })
    if (scope.signal.aborted || !dir) return
    if (side === 'left') state.leftRoot = dir
    else state.rightRoot = dir
    await runScanBoth()
  }

  addManagedListener(container, 'click', async (ev) => {
    const crumb = ev.target.closest('[data-crumb]')
    if (crumb) {
      state.currentPrefix = crumb.dataset.crumb
      renderView()
      return
    }
    const upRow = ev.target.closest('[data-up]')
    if (upRow) {
      state.currentPrefix = upRow.dataset.up
      renderView()
      return
    }
    const relRow = ev.target.closest('[data-rel]')
    if (relRow) {
      const entry = state.entries.get(relRow.dataset.rel)
      if (!entry) return
      if (entry.isDir) {
        state.currentPrefix = entry.rel
        renderView()
      } else if (entry.left && entry.right) {
        await previewFileEntry(entry)
      } else {
        showToast(entry.left ? '该文件仅存在于左侧目录' : '该文件仅存在于右侧目录')
      }
      return
    }
    const actBtn = ev.target.closest('[data-act]')
    if (!actBtn) return
    switch (actBtn.dataset.act) {
      case 'pick-left':
        await pickFolder('left')
        break
      case 'pick-right':
        await pickFolder('right')
        break
      case 'rescan':
        await runScanBoth()
        break
      case 'swap':
        ;[state.leftRoot, state.rightRoot] = [state.rightRoot, state.leftRoot]
        await runScanBoth()
        break
      case 'open-in-tab':
        await openSelectedInDedicatedTab()
        break
      case 'close-preview':
        elPreview.classList.add('hidden')
        break
      case 'export-html':
        await exportReport('html')
        break
      case 'export-csv':
        await exportReport('csv')
        break
      case 'clear':
        cancelActiveScans()
        state.leftRoot = ''
        state.rightRoot = ''
        state.leftMap.clear()
        state.rightMap.clear()
        state.entries.clear()
        state.currentPrefix = ''
        state.selectedRel = ''
        elPreview.classList.add('hidden')
        renderView()
        break
    }
  })

  addManagedListener(container, 'change', (ev) => {
    if (ev.target.dataset && ev.target.dataset.opt === 'onlyDiff') {
      state.onlyDiff = Boolean(ev.target.checked)
      renderView()
    }
  })

  addManagedListener(elSearch, 'input', () => {
    state.search = elSearch.value
    renderView()
  })

  // 支持从资源管理器拖入文件夹（通过 preload 可信 drop 白名单验证）
  for (const dropEl of container.querySelectorAll('[data-fdrop]')) {
    const side = dropEl.dataset.fdrop
    addManagedListener(dropEl, 'dragover', (ev) => {
      ev.preventDefault()
      dropEl.classList.add('drag-over')
    })
    addManagedListener(dropEl, 'dragleave', () => dropEl.classList.remove('drag-over'))
    addManagedListener(dropEl, 'drop', async (ev) => {
      ev.preventDefault()
      dropEl.classList.remove('drag-over')
      if (!preloadApi || typeof preloadApi.getAuthorizedDrops !== 'function') {
        showToast('请点击「选择文件夹」按钮选择本地目录')
        return
      }
      const authorized = await preloadApi.getAuthorizedDrops()
      if (scope.signal.aborted || !authorized.length) return
      const authSet = new Set(authorized.map((p) => p.toLowerCase()))
      const droppedFiles = Array.from(ev.dataTransfer?.files || [])
      const candidatePaths = []
      for (const f of droppedFiles) {
        let p = ''
        if (window.tabdo && typeof window.tabdo.getPathForFile === 'function') {
          try {
            p = window.tabdo.getPathForFile(f) || ''
          } catch {
            p = ''
          }
        }
        if (!p && typeof f.path === 'string') p = f.path
        if (p && authSet.has(p.toLowerCase())) candidatePaths.push(p)
      }
      const toCheck = candidatePaths.length ? candidatePaths.slice(0, 2) : authorized.slice(-1)
      const dirs = []
      for (const p of toCheck) {
        const st = await preloadApi.statAuthorizedPath(p)
        if (st.ok && st.isDir) dirs.push(st.path)
      }
      if (!dirs.length) {
        showToast('未识别到文件夹，请拖入文件夹或点击选择')
        return
      }
      if (dirs.length >= 2) {
        state.leftRoot = dirs[0]
        state.rightRoot = dirs[1]
      } else {
        if (side === 'left') state.leftRoot = dirs[0]
        else state.rightRoot = dirs[0]
      }
      await runScanBoth()
    })
  }

  return {
    async loadDirectories(paths) {
      if (!paths.length) return
      if (paths.length >= 2) {
        state.leftRoot = paths[0]
        state.rightRoot = paths[1]
      } else if (!state.leftRoot) {
        state.leftRoot = paths[0]
      } else {
        state.rightRoot = paths[0]
      }
      await runScanBoth()
    }
  }
}
