/**
 * 文本 / 代码对比视图。
 * 功能：双栏编辑与对比视图切换、并排/统一差异高亮、词/字符级内联差异、
 * 仅差异折叠、忽略空白/大小写、自动换行、上下差异跳转、左右互换、
 * 手动保存至插件私有 dbStorage 历史记录（受条数与字节上限保护）、HTML 报告导出。
 */

import { diffLines, escapeHtml, buildHtmlReport } from '../diff-engine.js'
import { decodeTextBytes } from '../parsers.js'
import {
  scope,
  preloadApi,
  addManagedListener,
  addManagedTimeout,
  readStorage,
  writeStorageTask,
  saveExportTask
} from '../tabdo-bridge.js'

const HISTORY_KEY = 'text-diff-history-v1'
const MAX_HISTORY_ITEMS = 50
const MAX_SIDE_CHARS = 200000
const MAX_STORAGE_BYTES = 2 * 1024 * 1024

export function createTextView(container, { showToast, askReplaceSide }) {
  const state = {
    leftName: '左侧文本',
    rightName: '右侧文本',
    leftText: '',
    rightText: '',
    editing: true,
    viewMode: 'split', // 'split' | 'unified'
    onlyDiff: false,
    ignoreWhitespace: false,
    ignoreCase: false,
    wrapLines: true,
    activeHunk: -1,
    diffResult: null,
    expandedFolds: new Set(),
    drawerOpen: false,
    history: loadHistory()
  }

  let debounceCancel = null

  container.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-group">
        <button type="button" class="btn btn-active" data-act="mode-edit">编辑输入</button>
        <button type="button" class="btn" data-act="mode-split">并排对比</button>
        <button type="button" class="btn" data-act="mode-unified">统一高亮</button>
      </div>
      <div class="toolbar-group">
        <button type="button" class="btn" data-act="prev" title="上一处差异 (Alt+↑)">上一处</button>
        <button type="button" class="btn" data-act="next" title="下一处差异 (Alt+↓)">下一处</button>
      </div>
      <label class="ctrl-check"><input type="checkbox" data-opt="onlyDiff" />仅差异</label>
      <label class="ctrl-check"><input type="checkbox" data-opt="ignoreWhitespace" />忽略空白</label>
      <label class="ctrl-check"><input type="checkbox" data-opt="ignoreCase" />忽略大小写</label>
      <label class="ctrl-check"><input type="checkbox" data-opt="wrapLines" checked />自动换行</label>
      <div class="toolbar-spacer"></div>
      <span class="stat-pill" data-el="stat">等待输入</span>
      <div class="toolbar-group">
        <button type="button" class="btn" data-act="swap" title="左右互换">互换</button>
        <button type="button" class="btn" data-act="save" title="保存到本机历史 (Ctrl+S)">保存</button>
        <button type="button" class="btn" data-act="history">历史</button>
        <button type="button" class="btn" data-act="export">导出报告</button>
        <button type="button" class="btn" data-act="clear">清空</button>
      </div>
    </div>
    <div class="text-workspace">
      <div class="text-edit-grid" data-el="edit-grid">
        <div class="pane-box" data-drop="left">
          <div class="pane-header">
            <span class="pane-header__name" data-el="left-name">左侧文本</span>
            <div class="pane-header__actions">
              <button type="button" class="btn" data-pick="left">打开文件</button>
            </div>
          </div>
          <textarea class="code-textarea" data-input="left" placeholder="粘贴、输入或拖入左侧文本文件…"></textarea>
        </div>
        <div class="pane-box" data-drop="right">
          <div class="pane-header">
            <span class="pane-header__name" data-el="right-name">右侧文本</span>
            <div class="pane-header__actions">
              <button type="button" class="btn" data-pick="right">打开文件</button>
            </div>
          </div>
          <textarea class="code-textarea" data-input="right" placeholder="粘贴、输入或拖入右侧文本文件…"></textarea>
        </div>
      </div>
      <div class="diff-scroll-wrap hidden" data-el="diff-wrap"></div>
    </div>
    <div class="drawer-backdrop hidden" data-el="drawer">
      <aside class="drawer-panel" aria-label="文本对比历史">
        <div class="drawer-head">
          <h3>对比历史</h3>
          <div class="toolbar-group">
            <button type="button" class="btn" data-act="clear-history">清空</button>
            <button type="button" class="btn" data-act="close-drawer">关闭</button>
          </div>
        </div>
        <div class="drawer-body" data-el="history-list"></div>
        <div class="drawer-foot">
          <span data-el="history-foot">仅存本机插件私有存储</span>
        </div>
      </aside>
    </div>
  `

  const elEditGrid = container.querySelector('[data-el="edit-grid"]')
  const elDiffWrap = container.querySelector('[data-el="diff-wrap"]')
  const elStat = container.querySelector('[data-el="stat"]')
  const elLeftName = container.querySelector('[data-el="left-name"]')
  const elRightName = container.querySelector('[data-el="right-name"]')
  const elLeftInput = container.querySelector('[data-input="left"]')
  const elRightInput = container.querySelector('[data-input="right"]')
  const elDrawer = container.querySelector('[data-el="drawer"]')
  const elHistoryList = container.querySelector('[data-el="history-list"]')
  const elHistoryFoot = container.querySelector('[data-el="history-foot"]')

  function loadHistory() {
    try {
      const raw = readStorage(HISTORY_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY_ITEMS) : []
    } catch {
      return []
    }
  }

  function scheduleCompute() {
    if (debounceCancel) debounceCancel()
    debounceCancel = addManagedTimeout(() => {
      recomputeDiff()
    }, 120)
  }

  function recomputeDiff() {
    if (scope.signal.aborted) return
    const hasContent = state.leftText.length > 0 || state.rightText.length > 0
    if (!hasContent) {
      state.diffResult = null
      state.activeHunk = -1
      elStat.className = 'stat-pill'
      elStat.textContent = '等待输入'
      if (!state.editing) renderDiffTable()
      return
    }

    const result = diffLines(state.leftText, state.rightText, {
      ignoreWhitespace: state.ignoreWhitespace,
      ignoreCase: state.ignoreCase
    })
    state.diffResult = result
    state.expandedFolds.clear()
    if (state.activeHunk >= result.hunks.length) {
      state.activeHunk = result.hunks.length ? 0 : -1
    }

    if (result.stats.identical) {
      elStat.className = 'stat-pill same'
      elStat.textContent = `内容一致 · ${result.stats.leftLines} 行`
    } else {
      elStat.className = 'stat-pill mod'
      elStat.textContent = `${result.stats.hunkCount} 处差异（+${result.stats.added} / -${result.stats.removed} / ~${result.stats.modified}）`
    }

    if (!state.editing) renderDiffTable()
  }

  function renderInlineHtml(segs, kind) {
    if (!segs) return ''
    return segs
      .map((s) => {
        const safe = escapeHtml(s.text)
        if (s.kind === kind) return `<span class="hl-${kind}">${safe}</span>`
        return safe
      })
      .join('')
  }

  function renderDiffTable() {
    const res = state.diffResult
    if (!res || !res.rows.length) {
      elDiffWrap.innerHTML = `<div class="empty-state">请先在「编辑输入」中输入、粘贴或打开两份文本。</div>`
      return
    }

    const wrapCls = state.wrapLines ? 'wrap-lines' : ''
    const rows = res.rows

    // 计算折叠区间（仅差异模式下，保留差异前后各 2 行上下文）
    const keep = new Uint8Array(rows.length)
    if (!state.onlyDiff) {
      keep.fill(1)
    } else {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].type !== 'equal') {
          for (let k = Math.max(0, i - 2); k <= Math.min(rows.length - 1, i + 2); k++) {
            keep[k] = 1
          }
        }
      }
    }

    const parts = []
    if (state.viewMode === 'split') {
      parts.push(`<table class="diff-table ${wrapCls}"><thead><tr>
        <th class="diff-ln">#</th>
        <th>${escapeHtml(state.leftName)}</th>
        <th class="diff-ln">#</th>
        <th>${escapeHtml(state.rightName)}</th>
      </tr></thead><tbody>`)
    } else {
      parts.push(`<table class="diff-table ${wrapCls}"><thead><tr>
        <th class="diff-ln">左</th>
        <th class="diff-ln">右</th>
        <th class="diff-sign">±</th>
        <th>差异高亮</th>
      </tr></thead><tbody>`)
    }

    let i = 0
    while (i < rows.length) {
      if (!keep[i]) {
        const start = i
        while (i < rows.length && !keep[i]) i++
        const foldId = `${start}-${i}`
        if (!state.expandedFolds.has(foldId)) {
          parts.push(
            `<tr class="diff-fold-row" data-fold="${foldId}"><td colspan="4">展开 ${i - start} 行未变更内容</td></tr>`
          )
          continue
        }
        for (let k = start; k < i; k++) parts.push(renderSingleRow(rows[k], k))
        continue
      }
      parts.push(renderSingleRow(rows[i], i))
      i++
    }

    parts.push('</tbody></table>')
    elDiffWrap.innerHTML = parts.join('')
  }

  function renderSingleRow(row, rowIdx) {
    const activeCls = row.hunkIndex >= 0 && row.hunkIndex === state.activeHunk ? 'diff-row-active' : ''
    const hunkAttr = row.hunkIndex >= 0 ? `data-hunk="${row.hunkIndex}"` : ''

    if (state.viewMode === 'split') {
      const leftHtml =
        row.type === 'modified' && row.inline
          ? renderInlineHtml(row.inline.leftSegs, 'del')
          : escapeHtml(row.leftText)
      const rightHtml =
        row.type === 'modified' && row.inline
          ? renderInlineHtml(row.inline.rightSegs, 'add')
          : escapeHtml(row.rightText)
      return `<tr class="diff-row-${row.type} ${activeCls}" ${hunkAttr} data-row="${rowIdx}">
        <td class="diff-ln cell-left">${row.leftNum ?? ''}</td>
        <td class="diff-code cell-left">${leftHtml}</td>
        <td class="diff-ln cell-right">${row.rightNum ?? ''}</td>
        <td class="diff-code cell-right">${rightHtml}</td>
      </tr>`
    }

    if (row.type === 'modified') {
      const leftHtml = row.inline ? renderInlineHtml(row.inline.leftSegs, 'del') : escapeHtml(row.leftText)
      const rightHtml = row.inline ? renderInlineHtml(row.inline.rightSegs, 'add') : escapeHtml(row.rightText)
      return `<tr class="diff-row-removed unified-row ${activeCls}" ${hunkAttr}>
          <td class="diff-ln">${row.leftNum ?? ''}</td>
          <td class="diff-ln"></td>
          <td class="diff-sign">-</td>
          <td class="diff-code">${leftHtml}</td>
        </tr>
        <tr class="diff-row-added unified-row ${activeCls}">
          <td class="diff-ln"></td>
          <td class="diff-ln">${row.rightNum ?? ''}</td>
          <td class="diff-sign">+</td>
          <td class="diff-code">${rightHtml}</td>
        </tr>`
    }

    const sign = row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ''
    const text = row.type === 'added' ? row.rightText : row.leftText
    return `<tr class="diff-row-${row.type} unified-row ${activeCls}" ${hunkAttr}>
      <td class="diff-ln">${row.leftNum ?? ''}</td>
      <td class="diff-ln">${row.rightNum ?? ''}</td>
      <td class="diff-sign">${sign}</td>
      <td class="diff-code">${escapeHtml(text)}</td>
    </tr>`
  }

  function setDisplayMode(mode) {
    state.editing = mode === 'edit'
    if (mode === 'split' || mode === 'unified') state.viewMode = mode

    container.querySelector('[data-act="mode-edit"]').classList.toggle('btn-active', state.editing)
    container.querySelector('[data-act="mode-split"]').classList.toggle('btn-active', !state.editing && state.viewMode === 'split')
    container.querySelector('[data-act="mode-unified"]').classList.toggle('btn-active', !state.editing && state.viewMode === 'unified')

    elEditGrid.classList.toggle('hidden', !state.editing)
    elDiffWrap.classList.toggle('hidden', state.editing)
    if (!state.editing) {
      recomputeDiff()
      renderDiffTable()
    }
  }

  function jumpHunk(delta) {
    if (state.editing) setDisplayMode(state.viewMode)
    const res = state.diffResult
    if (!res || !res.hunks.length) {
      showToast('当前没有差异可跳转')
      return
    }
    const total = res.hunks.length
    state.activeHunk = state.activeHunk < 0 ? 0 : (state.activeHunk + delta + total) % total
    renderDiffTable()
    const rowEl = elDiffWrap.querySelector(`[data-hunk="${state.activeHunk}"]`)
    if (rowEl) rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function saveToHistory() {
    if (!state.leftText && !state.rightText) {
      showToast('还没有可保存的文本内容')
      return
    }
    const leftClipped = state.leftText.slice(0, MAX_SIDE_CHARS)
    const rightClipped = state.rightText.slice(0, MAX_SIDE_CHARS)
    const truncated = state.leftText.length > MAX_SIDE_CHARS || state.rightText.length > MAX_SIDE_CHARS

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      savedAt: Date.now(),
      leftName: state.leftName,
      rightName: state.rightName,
      leftText: leftClipped,
      rightText: rightClipped,
      truncated,
      summary: state.diffResult ? `${state.diffResult.stats.hunkCount} 处差异` : '文本记录'
    }

    const next = [entry, ...state.history.filter((h) => !(h.leftText === leftClipped && h.rightText === rightClipped))]
      .slice(0, MAX_HISTORY_ITEMS)

    // 限制总字节数，超出时移除最早记录
    let serialized = JSON.stringify(next)
    while (serialized.length * 2 > MAX_STORAGE_BYTES && next.length > 1) {
      next.pop()
      serialized = JSON.stringify(next)
    }

    try {
      await writeStorageTask(HISTORY_KEY, serialized)
      if (scope.signal.aborted) return
      state.history = next
      renderHistoryDrawer()
      showToast(truncated ? '已保存到历史记录（单侧超 20 万字符已截断）' : '已保存到历史记录')
    } catch (e) {
      if (!scope.signal.aborted) showToast(`保存历史失败：${e.message || e}`)
    }
  }

  function renderHistoryDrawer() {
    if (!state.history.length) {
      elHistoryList.innerHTML = `<div class="empty-state">暂无记录，点击「保存」或按 Ctrl+S 即可将当前对比存入本机。</div>`
    } else {
      elHistoryList.innerHTML = state.history
        .map((item) => {
          const time = new Date(item.savedAt).toLocaleString('zh-CN', { hour12: false })
          const preview = (item.leftText || item.rightText || '（空）').split('\n')[0].slice(0, 80)
          return `<div class="history-item" data-hid="${escapeHtml(item.id)}">
            <div class="history-item__top">
              <span>${escapeHtml(time)} · ${escapeHtml(item.summary)}</span>
              <button type="button" class="btn btn-ghost" data-hdel="${escapeHtml(item.id)}" style="height:22px;padding:0 6px">删除</button>
            </div>
            <div class="history-item__preview">${escapeHtml(item.leftName)} ⇄ ${escapeHtml(item.rightName)}</div>
            <div class="history-item__preview" style="color:var(--text-secondary)">${escapeHtml(preview)}</div>
          </div>`
        })
        .join('')
    }
    elHistoryFoot.textContent = `已存 ${state.history.length} / ${MAX_HISTORY_ITEMS} 条 · 仅存本机`
  }

  async function exportReport() {
    recomputeDiff()
    const res = state.diffResult
    if (!res || res.stats.identical) {
      showToast('当前没有差异，无需导出报告')
      return
    }
    const entries = res.rows
      .filter((r) => r.type !== 'equal')
      .map((r) => ({
        position: `左 ${r.leftNum ?? '-'} / 右 ${r.rightNum ?? '-'}`,
        type: r.type,
        left: r.leftText,
        right: r.rightText
      }))

    const html = buildHtmlReport({
      title: '文本差异比较报告',
      kindLabel: '文本',
      leftName: state.leftName,
      rightName: state.rightName,
      summary: [
        { label: '差异处数', value: res.stats.hunkCount },
        { label: '新增行', value: res.stats.added },
        { label: '删除行', value: res.stats.removed },
        { label: '修改行', value: res.stats.modified },
        { label: '左侧行数', value: res.stats.leftLines },
        { label: '右侧行数', value: res.stats.rightLines }
      ],
      entries
    })

    const bytes = new TextEncoder().encode(html)
    const saved = await saveExportTask({
      data: bytes,
      defaultName: `文本差异报告-${Date.now()}.html`,
      title: '导出文本差异报告',
      buttonLabel: '保存',
      filters: [{ name: 'HTML 报告', extensions: ['html'] }],
      mimeType: 'text/html;charset=utf-8'
    })
    if (scope.signal.aborted) return
    if (saved.ok) showToast(saved.downloaded ? '报告已开始下载' : `报告已保存：${saved.path}`)
    else if (!saved.canceled) showToast(saved.error || '导出失败')
  }

  async function pickTextFile(side) {
    if (preloadApi && typeof preloadApi.pickFiles === 'function') {
      const res = await preloadApi.pickFiles({ title: side === 'left' ? '选择左侧文本文件' : '选择右侧文本文件' })
      if (scope.signal.aborted || !res.ok || res.canceled || !res.files.length) return
      const read = await preloadApi.readFileAt(res.files[0].path, { maxBytes: 8 * 1024 * 1024 })
      if (scope.signal.aborted) return
      if (!read.ok) {
        showToast(read.error || '读取文件失败')
        return
      }
      setSideText(side, decodeTextBytes(read.data), read.name)
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = async () => {
      const file = input.files && input.files[0]
      if (!file) return
      const ab = await file.arrayBuffer()
      if (scope.signal.aborted) return
      setSideText(side, decodeTextBytes(ab), file.name)
    }
    input.click()
  }

  function setSideText(side, text, name) {
    if (side === 'left') {
      state.leftText = text
      state.leftName = name || '左侧文本'
      elLeftInput.value = text
      elLeftName.textContent = state.leftName
    } else {
      state.rightText = text
      state.rightName = name || '右侧文本'
      elRightInput.value = text
      elRightName.textContent = state.rightName
    }
    recomputeDiff()
    if (state.leftText && state.rightText && state.editing) {
      setDisplayMode(state.viewMode)
    }
  }

  // 事件绑定（全部登记到 session-v1 清理器）
  addManagedListener(elLeftInput, 'input', () => {
    state.leftText = elLeftInput.value
    scheduleCompute()
  })
  addManagedListener(elRightInput, 'input', () => {
    state.rightText = elRightInput.value
    scheduleCompute()
  })

  addManagedListener(container, 'click', async (ev) => {
    const foldRow = ev.target.closest('[data-fold]')
    if (foldRow) {
      state.expandedFolds.add(foldRow.dataset.fold)
      renderDiffTable()
      return
    }
    const hdel = ev.target.closest('[data-hdel]')
    if (hdel) {
      ev.stopPropagation()
      const id = hdel.dataset.hdel
      const next = state.history.filter((h) => h.id !== id)
      await writeStorageTask(HISTORY_KEY, JSON.stringify(next))
      if (scope.signal.aborted) return
      state.history = next
      renderHistoryDrawer()
      return
    }
    const hitem = ev.target.closest('[data-hid]')
    if (hitem) {
      const target = state.history.find((h) => h.id === hitem.dataset.hid)
      if (!target) return
      state.leftText = target.leftText
      state.rightText = target.rightText
      state.leftName = target.leftName || '左侧文本'
      state.rightName = target.rightName || '右侧文本'
      elLeftInput.value = state.leftText
      elRightInput.value = state.rightText
      elLeftName.textContent = state.leftName
      elRightName.textContent = state.rightName
      elDrawer.classList.add('hidden')
      setDisplayMode(state.viewMode)
      showToast('已载入历史记录')
      return
    }
    const pickBtn = ev.target.closest('[data-pick]')
    if (pickBtn) {
      await pickTextFile(pickBtn.dataset.pick)
      return
    }
    const actBtn = ev.target.closest('[data-act]')
    if (!actBtn) return
    switch (actBtn.dataset.act) {
      case 'mode-edit':
        setDisplayMode('edit')
        break
      case 'mode-split':
        setDisplayMode('split')
        break
      case 'mode-unified':
        setDisplayMode('unified')
        break
      case 'prev':
        jumpHunk(-1)
        break
      case 'next':
        jumpHunk(1)
        break
      case 'swap':
        ;[state.leftText, state.rightText] = [state.rightText, state.leftText]
        ;[state.leftName, state.rightName] = [state.rightName, state.leftName]
        elLeftInput.value = state.leftText
        elRightInput.value = state.rightText
        elLeftName.textContent = state.leftName
        elRightName.textContent = state.rightName
        recomputeDiff()
        break
      case 'save':
        await saveToHistory()
        break
      case 'history':
        renderHistoryDrawer()
        elDrawer.classList.remove('hidden')
        break
      case 'close-drawer':
        elDrawer.classList.add('hidden')
        break
      case 'clear-history':
        await writeStorageTask(HISTORY_KEY, '[]')
        if (scope.signal.aborted) return
        state.history = []
        renderHistoryDrawer()
        showToast('已清空历史记录')
        break
      case 'export':
        await exportReport()
        break
      case 'clear':
        state.leftText = ''
        state.rightText = ''
        state.leftName = '左侧文本'
        state.rightName = '右侧文本'
        elLeftInput.value = ''
        elRightInput.value = ''
        elLeftName.textContent = state.leftName
        elRightName.textContent = state.rightName
        recomputeDiff()
        setDisplayMode('edit')
        break
    }
  })

  addManagedListener(elDrawer, 'click', (ev) => {
    if (ev.target === elDrawer) elDrawer.classList.add('hidden')
  })

  addManagedListener(container, 'change', (ev) => {
    const opt = ev.target.dataset && ev.target.dataset.opt
    if (!opt) return
    state[opt] = Boolean(ev.target.checked)
    recomputeDiff()
    if (!state.editing) renderDiffTable()
  })

  // 拖拽文件到左/右栏
  for (const box of container.querySelectorAll('[data-drop]')) {
    const side = box.dataset.drop
    addManagedListener(box, 'dragover', (ev) => {
      ev.preventDefault()
      box.classList.add('drag-over')
    })
    addManagedListener(box, 'dragleave', () => box.classList.remove('drag-over'))
    addManagedListener(box, 'drop', async (ev) => {
      ev.preventDefault()
      box.classList.remove('drag-over')
      const files = Array.from(ev.dataTransfer?.files || [])
      if (!files.length) return
      if (files.length >= 2) {
        const [a, b] = await Promise.all([files[0].arrayBuffer(), files[1].arrayBuffer()])
        if (scope.signal.aborted) return
        setSideText('left', decodeTextBytes(a), files[0].name)
        setSideText('right', decodeTextBytes(b), files[1].name)
      } else {
        const ab = await files[0].arrayBuffer()
        if (scope.signal.aborted) return
        setSideText(side, decodeTextBytes(ab), files[0].name)
      }
    })
  }

  // 快捷键（Ctrl+S 保存历史，Alt+Arrow 跳转差异）
  addManagedListener(window, 'keydown', (ev) => {
    if (!container.classList.contains('active')) return
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      saveToHistory()
    } else if (ev.altKey && ev.key === 'ArrowUp') {
      ev.preventDefault()
      jumpHunk(-1)
    } else if (ev.altKey && ev.key === 'ArrowDown') {
      ev.preventDefault()
      jumpHunk(1)
    }
  })

  return {
    async loadFiles(items) {
      if (!items.length) return
      if (items.length >= 2) {
        setSideText('left', decodeTextBytes(items[0].buffer), items[0].name)
        setSideText('right', decodeTextBytes(items[1].buffer), items[1].name)
        return
      }
      const one = items[0]
      let side = !state.leftText ? 'left' : !state.rightText ? 'right' : await askReplaceSide(one.name)
      if (!side || scope.signal.aborted) return
      setSideText(side, decodeTextBytes(one.buffer), one.name)
    },
    setPair(leftName, leftText, rightName, rightText) {
      state.leftName = leftName || '左侧文本'
      state.rightName = rightName || '右侧文本'
      state.leftText = leftText || ''
      state.rightText = rightText || ''
      elLeftInput.value = state.leftText
      elRightInput.value = state.rightText
      elLeftName.textContent = state.leftName
      elRightName.textContent = state.rightName
      setDisplayMode('split')
    }
  }
}
