/**
 * 通用文档对比视图工厂：支持 Word (.docx)、Excel (.xlsx/.csv/.tsv)、PDF (.pdf)、PPT (.pptx)。
 * 所有解析均在本地离线完成，通过请求代际令牌与 scope.signal 防止过期结果回填。
 */

import {
  diffLines,
  diffSheetGrid,
  colIndexToLetter,
  escapeHtml,
  buildHtmlReport
} from '../diff-engine.js'
import { parseDocx, parseExcel, parsePdf, parsePptx } from '../parsers.js'
import { scope, preloadApi, addManagedListener, saveExportTask } from '../tabdo-bridge.js'

const KIND_META = {
  docx: {
    label: 'Word',
    accept: '.docx',
    extensions: ['docx'],
    hint: '支持 .docx 文档的段落、表格、页眉页脚与批注离线对比'
  },
  excel: {
    label: 'Excel',
    accept: '.xlsx,.csv,.tsv',
    extensions: ['xlsx', 'csv', 'tsv'],
    hint: '支持 .xlsx 工作簿及 .csv / .tsv 表格的多工作表与单元格级差异对比'
  },
  pdf: {
    label: 'PDF',
    accept: '.pdf',
    extensions: ['pdf'],
    hint: '支持 .pdf 文本层分页提取与逐页差异对比（加密或纯扫描件将给出提示）'
  },
  pptx: {
    label: 'PPT',
    accept: '.pptx',
    extensions: ['pptx'],
    hint: '支持 .pptx 演示文稿按真实顺序逐页提取正文与备注并对比差异'
  }
}

export function createDocView(container, kind, { showToast, askReplaceSide }) {
  const meta = KIND_META[kind]
  const state = {
    left: null, // { name, parsed }
    right: null,
    viewMode: 'split', // 'split' | 'unified'
    onlyDiff: false,
    activeIndex: 0, // sheet / slide / page index
    activeHunk: -1,
    parseToken: 0,
    computed: null
  }

  container.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-group">
        <button type="button" class="btn btn-active" data-dmode="split">并排对比</button>
        <button type="button" class="btn" data-dmode="unified">差异高亮</button>
      </div>
      <div class="toolbar-group">
        <button type="button" class="btn" data-act="prev">上一处</button>
        <button type="button" class="btn" data-act="next">下一处</button>
      </div>
      <label class="ctrl-check"><input type="checkbox" data-opt="onlyDiff" />仅差异</label>
      <div class="toolbar-spacer"></div>
      <span class="stat-pill" data-el="stat">请选择两份 ${meta.label} 文件</span>
      <div class="toolbar-group">
        <button type="button" class="btn" data-act="pick-left">选左侧</button>
        <button type="button" class="btn" data-act="pick-right">选右侧</button>
        <button type="button" class="btn" data-act="swap">互换</button>
        <button type="button" class="btn" data-act="export">导出报告</button>
        <button type="button" class="btn" data-act="clear">清空</button>
      </div>
    </div>
    <div class="split-panes" data-el="empty-panes">
      <div class="drop-card" data-ddrop="left">
        <div class="drop-card__title">左侧 ${meta.label} 文件</div>
        <div class="drop-card__hint">${meta.hint}</div>
        <div class="drop-card__file" data-el="empty-left-name"></div>
        <button type="button" class="btn btn-primary" data-act="pick-left">选择左侧文件</button>
      </div>
      <div class="drop-card" data-ddrop="right">
        <div class="drop-card__title">右侧 ${meta.label} 文件</div>
        <div class="drop-card__hint">${meta.hint}</div>
        <div class="drop-card__file" data-el="empty-right-name"></div>
        <button type="button" class="btn btn-primary" data-act="pick-right">选择右侧文件</button>
      </div>
    </div>
    <div class="doc-body hidden" data-el="doc-body">
      <div class="sheet-strip hidden" data-el="strip"></div>
      <div class="notice-bar hidden" data-el="notice"></div>
      <div class="diff-scroll-wrap" data-el="content" style="padding-top:8px"></div>
    </div>
  `

  const elEmptyPanes = container.querySelector('[data-el="empty-panes"]')
  const elDocBody = container.querySelector('[data-el="doc-body"]')
  const elStrip = container.querySelector('[data-el="strip"]')
  const elNotice = container.querySelector('[data-el="notice"]')
  const elContent = container.querySelector('[data-el="content"]')
  const elStat = container.querySelector('[data-el="stat"]')
  const elEmptyLeftName = container.querySelector('[data-el="empty-left-name"]')
  const elEmptyRightName = container.querySelector('[data-el="empty-right-name"]')

  async function parseBuffer(buffer, name) {
    if (kind === 'docx') return await parseDocx(buffer)
    if (kind === 'excel') return await parseExcel(buffer, name)
    if (kind === 'pdf') return await parsePdf(buffer)
    if (kind === 'pptx') return await parsePptx(buffer)
    throw new Error('未知文档类型')
  }

  function renderInline(segs, cls) {
    if (!segs) return ''
    return segs
      .map((s) => (s.kind === cls ? `<span class="hl-${cls}">${escapeHtml(s.text)}</span>` : escapeHtml(s.text)))
      .join('')
  }

  function buildTextDiffHtml(diffRes, leftLabel, rightLabel) {
    const rows = state.onlyDiff ? diffRes.rows.filter((r) => r.type !== 'equal') : diffRes.rows
    if (!rows.length) {
      return `<div class="empty-state">当前范围没有发现差异。</div>`
    }
    const parts = []
    if (state.viewMode === 'split') {
      parts.push(`<table class="diff-table wrap-lines"><thead><tr>
        <th class="diff-ln">#</th><th>${escapeHtml(leftLabel)}</th>
        <th class="diff-ln">#</th><th>${escapeHtml(rightLabel)}</th>
      </tr></thead><tbody>`)
      for (const r of rows) {
        const actCls = r.hunkIndex >= 0 && r.hunkIndex === state.activeHunk ? 'diff-row-active' : ''
        const hAttr = r.hunkIndex >= 0 ? `data-hunk="${r.hunkIndex}"` : ''
        const lt = r.type === 'modified' && r.inline ? renderInline(r.inline.leftSegs, 'del') : escapeHtml(r.leftText)
        const rt = r.type === 'modified' && r.inline ? renderInline(r.inline.rightSegs, 'add') : escapeHtml(r.rightText)
        parts.push(`<tr class="diff-row-${r.type} ${actCls}" ${hAttr}>
          <td class="diff-ln cell-left">${r.leftNum ?? ''}</td>
          <td class="diff-code cell-left">${lt}</td>
          <td class="diff-ln cell-right">${r.rightNum ?? ''}</td>
          <td class="diff-code cell-right">${rt}</td>
        </tr>`)
      }
      parts.push('</tbody></table>')
    } else {
      parts.push(`<table class="diff-table wrap-lines"><thead><tr>
        <th class="diff-ln">左</th><th class="diff-ln">右</th><th class="diff-sign">±</th><th>差异高亮</th>
      </tr></thead><tbody>`)
      for (const r of rows) {
        const actCls = r.hunkIndex >= 0 && r.hunkIndex === state.activeHunk ? 'diff-row-active' : ''
        const hAttr = r.hunkIndex >= 0 ? `data-hunk="${r.hunkIndex}"` : ''
        if (r.type === 'modified') {
          const lt = r.inline ? renderInline(r.inline.leftSegs, 'del') : escapeHtml(r.leftText)
          const rt = r.inline ? renderInline(r.inline.rightSegs, 'add') : escapeHtml(r.rightText)
          parts.push(`<tr class="diff-row-removed unified-row ${actCls}" ${hAttr}>
            <td class="diff-ln">${r.leftNum ?? ''}</td><td class="diff-ln"></td><td class="diff-sign">-</td>
            <td class="diff-code">${lt}</td>
          </tr>
          <tr class="diff-row-added unified-row ${actCls}">
            <td class="diff-ln"></td><td class="diff-ln">${r.rightNum ?? ''}</td><td class="diff-sign">+</td>
            <td class="diff-code">${rt}</td>
          </tr>`)
        } else {
          const sign = r.type === 'added' ? '+' : r.type === 'removed' ? '-' : ''
          const text = r.type === 'added' ? r.rightText : r.leftText
          parts.push(`<tr class="diff-row-${r.type} unified-row ${actCls}" ${hAttr}>
            <td class="diff-ln">${r.leftNum ?? ''}</td><td class="diff-ln">${r.rightNum ?? ''}</td>
            <td class="diff-sign">${sign}</td><td class="diff-code">${escapeHtml(text)}</td>
          </tr>`)
        }
      }
      parts.push('</tbody></table>')
    }
    return parts.join('')
  }

  function recomputeAndRender() {
    elEmptyLeftName.textContent = state.left ? state.left.name : ''
    elEmptyRightName.textContent = state.right ? state.right.name : ''
    const ready = Boolean(state.left && state.right)
    elEmptyPanes.classList.toggle('hidden', ready)
    elDocBody.classList.toggle('hidden', !ready)

    if (!ready) {
      state.computed = null
      elStat.className = 'stat-pill'
      elStat.textContent = state.left || state.right ? '已载入 1 份，等待另一份' : `请选择两份 ${meta.label} 文件`
      return
    }

    elNotice.classList.add('hidden')
    elNotice.textContent = ''

    if (kind === 'docx') {
      elStrip.classList.add('hidden')
      const diff = diffLines(state.left.parsed.text, state.right.parsed.text)
      state.computed = { type: 'docx', diff }
      elStat.className = diff.stats.identical ? 'stat-pill same' : 'stat-pill mod'
      elStat.textContent = diff.stats.identical
        ? '文档内容一致'
        : `${diff.stats.hunkCount} 处差异（+${diff.stats.added} / -${diff.stats.removed} / ~${diff.stats.modified}）`
      elContent.innerHTML = buildTextDiffHtml(diff, state.left.name, state.right.name)
      return
    }

    if (kind === 'excel') {
      const lMap = new Map(state.left.parsed.sheets.map((s) => [s.name, s]))
      const rMap = new Map(state.right.parsed.sheets.map((s) => [s.name, s]))
      const names = Array.from(new Set([...lMap.keys(), ...rMap.keys()]))
      const sheets = names.map((name) => {
        const ls = lMap.get(name)
        const rs = rMap.get(name)
        const grid = diffSheetGrid(ls ? ls.rows : [], rs ? rs.rows : [])
        const status = !ls ? 'add' : !rs ? 'del' : grid.stats.identical ? 'same' : 'mod'
        return { name, status, grid }
      })

      if (state.activeIndex >= sheets.length) state.activeIndex = 0
      state.computed = { type: 'excel', sheets }

      const changedSheets = sheets.filter((s) => s.status !== 'same').length
      const totalChanges = sheets.reduce((sum, s) => sum + s.grid.stats.totalChanges, 0)
      elStat.className = totalChanges === 0 ? 'stat-pill same' : 'stat-pill mod'
      elStat.textContent =
        totalChanges === 0
          ? `全部 ${sheets.length} 个工作表一致`
          : `${changedSheets}/${sheets.length} 个工作表有差异 · 共 ${totalChanges} 处单元格变动`

      elStrip.classList.remove('hidden')
      elStrip.innerHTML = sheets
        .map(
          (s, idx) =>
            `<button type="button" class="sheet-tab ${idx === state.activeIndex ? 'active' : ''}" data-sidx="${idx}">
              <span class="dot dot-${s.status}"></span>${escapeHtml(s.name)}
            </button>`
        )
        .join('')

      const cur = sheets[state.activeIndex]
      if (!cur) {
        elContent.innerHTML = `<div class="empty-state">工作簿为空。</div>`
        return
      }
      if (cur.grid.reorderedColumns.length) {
        const moves = cur.grid.reorderedColumns.map((c) => `${c.header}(${c.fromCol}→${c.toCol})`).join('、')
        elNotice.textContent = `检测到表头列顺序调整：${moves}`
        elNotice.classList.remove('hidden')
      }

      const displayRows = state.onlyDiff ? cur.grid.rows.filter((r) => r.status !== 'equal') : cur.grid.rows
      if (!displayRows.length) {
        elContent.innerHTML = `<div class="empty-state">工作表「${escapeHtml(cur.name)}」没有差异。</div>`
        return
      }

      const colHeaders = Array.from({ length: cur.grid.maxCols }, (_, c) => `<th>${colIndexToLetter(c)}</th>`).join('')
      const bodyHtml = displayRows
        .map((row) => {
          const cellsHtml = row.cells
            .map((cell) => {
              if (cell.status === 'added') return `<td class="excel-cell-add">${escapeHtml(cell.right)}</td>`
              if (cell.status === 'removed') return `<td class="excel-cell-del">${escapeHtml(cell.left)}</td>`
              if (cell.status === 'modified') {
                return `<td class="excel-cell-mod">
                  <span class="excel-mod-old">${escapeHtml(cell.left)}</span>
                  <span class="excel-mod-new">${escapeHtml(cell.right)}</span>
                </td>`
              }
              return `<td>${escapeHtml(cell.left)}</td>`
            })
            .join('')
          return `<tr><td class="diff-ln">${row.rowNum}</td>${cellsHtml}</tr>`
        })
        .join('')

      elContent.innerHTML = `<table class="excel-grid-table"><thead><tr><th style="width:44px">#</th>${colHeaders}</tr></thead><tbody>${bodyHtml}</tbody></table>`
      return
    }

    // PDF 或 PPTX（分页/分幻灯片对比）
    const leftUnits = kind === 'pdf' ? state.left.parsed.pages : state.left.parsed.slides
    const rightUnits = kind === 'pdf' ? state.right.parsed.pages : state.right.parsed.slides
    const maxCount = Math.max(leftUnits.length, rightUnits.length)
    const units = []

    for (let i = 0; i < maxCount; i++) {
      const lu = leftUnits[i]
      const ru = rightUnits[i]
      const diff = diffLines(lu ? lu.text : '', ru ? ru.text : '')
      const status = !lu ? 'add' : !ru ? 'del' : diff.stats.identical ? 'same' : 'mod'
      units.push({
        index: i + 1,
        label: kind === 'pdf' ? `第 ${i + 1} 页` : `幻灯片 ${i + 1}`,
        status,
        diff
      })
    }

    if (state.activeIndex >= units.length) state.activeIndex = 0
    state.computed = { type: kind, units }

    const changedCount = units.filter((u) => u.status !== 'same').length
    const totalHunks = units.reduce((sum, u) => sum + u.diff.stats.hunkCount, 0)
    elStat.className = changedCount === 0 ? 'stat-pill same' : 'stat-pill mod'
    elStat.textContent =
      changedCount === 0
        ? `共 ${units.length} 页，文本内容一致`
        : `${changedCount}/${units.length} 页有变化 · 共 ${totalHunks} 处差异`

    if (kind === 'pdf' && (state.left.parsed.scannedNotice || state.right.parsed.scannedNotice)) {
      elNotice.textContent = '提示：检测到至少一份 PDF 缺少可提取的文本层（可能为纯扫描图像 PDF），如需比对视觉画面可转为图片后使用「图片」对比。'
      elNotice.classList.remove('hidden')
    }

    elStrip.classList.remove('hidden')
    elStrip.innerHTML = units
      .map(
        (u, idx) =>
          `<button type="button" class="sheet-tab ${idx === state.activeIndex ? 'active' : ''}" data-sidx="${idx}">
            <span class="dot dot-${u.status}"></span>${escapeHtml(u.label)}
          </button>`
      )
      .join('')

    const cur = units[state.activeIndex]
    elContent.innerHTML = cur
      ? buildTextDiffHtml(cur.diff, `${state.left.name} · ${cur.label}`, `${state.right.name} · ${cur.label}`)
      : `<div class="empty-state">无内容</div>`
  }

  function jumpHunk(delta) {
    const hunks = elContent.querySelectorAll('[data-hunk]')
    if (!hunks.length) {
      showToast('当前页没有可跳转的差异')
      return
    }
    const ids = Array.from(new Set(Array.from(hunks).map((el) => Number(el.dataset.hunk))))
    const pos = ids.indexOf(state.activeHunk)
    const nextIdx = pos < 0 ? 0 : (pos + delta + ids.length) % ids.length
    state.activeHunk = ids[nextIdx]
    recomputeAndRender()
    const target = elContent.querySelector(`[data-hunk="${state.activeHunk}"]`)
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function exportReport() {
    if (!state.computed) {
      showToast('请先载入两份文件')
      return
    }

    const entries = []
    const summary = []
    let note = ''

    if (state.computed.type === 'docx') {
      const d = state.computed.diff
      summary.push(
        { label: '差异处数', value: d.stats.hunkCount },
        { label: '新增段', value: d.stats.added },
        { label: '删除段', value: d.stats.removed },
        { label: '修改段', value: d.stats.modified }
      )
      for (const r of d.rows) {
        if (r.type === 'equal') continue
        entries.push({
          position: `段 ${r.leftNum ?? '-'} / ${r.rightNum ?? '-'}`,
          type: r.type,
          left: r.leftText,
          right: r.rightText
        })
      }
    } else if (state.computed.type === 'excel') {
      const changedSheets = state.computed.sheets.filter((s) => s.status !== 'same')
      summary.push(
        { label: '工作表总数', value: state.computed.sheets.length },
        { label: '有差异工作表', value: changedSheets.length }
      )
      for (const s of state.computed.sheets) {
        for (const ch of s.grid.changes) {
          entries.push({
            position: `${s.name}!${ch.pos}`,
            type: ch.type,
            left: ch.left,
            right: ch.right
          })
        }
      }
      summary.push({ label: '单元格变动', value: entries.length })
      note = '位置列格式为「工作表名!列行号」，行列按原始工作表顺序编号。'
    } else {
      const units = state.computed.units
      const changed = units.filter((u) => u.status !== 'same').length
      summary.push(
        { label: kind === 'pdf' ? '总页数' : '总幻灯片数', value: units.length },
        { label: '有变化页数', value: changed }
      )
      for (const u of units) {
        for (const r of u.diff.rows) {
          if (r.type === 'equal') continue
          entries.push({
            position: `${u.label} 行 ${r.leftNum ?? '-'}/${r.rightNum ?? '-'}`,
            type: r.type,
            left: r.leftText,
            right: r.rightText
          })
        }
      }
      summary.push({ label: '差异明细', value: entries.length })
    }

    if (!entries.length) {
      showToast('没有发现差异，无需导出')
      return
    }

    const html = buildHtmlReport({
      title: `${meta.label} 差异比较报告`,
      kindLabel: meta.label,
      leftName: state.left.name,
      rightName: state.right.name,
      summary,
      note,
      entries
    })

    const saved = await saveExportTask({
      data: new TextEncoder().encode(html),
      defaultName: `${meta.label}差异报告-${Date.now()}.html`,
      title: `导出 ${meta.label} 差异报告`,
      buttonLabel: '保存',
      filters: [{ name: 'HTML 报告', extensions: ['html'] }],
      mimeType: 'text/html;charset=utf-8'
    })
    if (scope.signal.aborted) return
    if (saved.ok) showToast(saved.downloaded ? '报告已开始下载' : `报告已保存：${saved.path}`)
    else if (!saved.canceled) showToast(saved.error || '导出失败')
  }

  async function setSideFromBuffer(side, buffer, name) {
    const token = ++state.parseToken
    elStat.className = 'stat-pill'
    elStat.textContent = '正在解析文档…'
    try {
      const parsed = await parseBuffer(buffer, name)
      if (scope.signal.aborted || token !== state.parseToken) return
      state[side] = { name, parsed }
      state.activeIndex = 0
      state.activeHunk = -1
      recomputeAndRender()
    } catch (e) {
      if (scope.signal.aborted) return
      showToast(`解析失败：${e.message || e}`)
      recomputeAndRender()
    }
  }

  async function pickFile(side) {
    if (preloadApi && typeof preloadApi.pickFiles === 'function') {
      const res = await preloadApi.pickFiles({
        title: `选择${side === 'left' ? '左侧' : '右侧'} ${meta.label} 文件`,
        filters: [{ name: `${meta.label} 文件`, extensions: meta.extensions }]
      })
      if (scope.signal.aborted || !res.ok || res.canceled || !res.files.length) return
      const read = await preloadApi.readFileAt(res.files[0].path)
      if (scope.signal.aborted) return
      if (!read.ok) {
        showToast(read.error || '读取文件失败')
        return
      }
      await setSideFromBuffer(side, read.data, read.name)
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = meta.accept
    input.onchange = async () => {
      const file = input.files && input.files[0]
      if (!file) return
      const ab = await file.arrayBuffer()
      if (scope.signal.aborted) return
      await setSideFromBuffer(side, ab, file.name)
    }
    input.click()
  }

  addManagedListener(container, 'click', async (ev) => {
    const sTab = ev.target.closest('[data-sidx]')
    if (sTab) {
      state.activeIndex = Number(sTab.dataset.sidx)
      state.activeHunk = -1
      recomputeAndRender()
      return
    }
    const modeBtn = ev.target.closest('[data-dmode]')
    if (modeBtn) {
      state.viewMode = modeBtn.dataset.dmode
      for (const b of container.querySelectorAll('[data-dmode]')) {
        b.classList.toggle('btn-active', b === modeBtn)
      }
      recomputeAndRender()
      return
    }
    const actBtn = ev.target.closest('[data-act]')
    if (!actBtn) return
    switch (actBtn.dataset.act) {
      case 'pick-left':
        await pickFile('left')
        break
      case 'pick-right':
        await pickFile('right')
        break
      case 'prev':
        jumpHunk(-1)
        break
      case 'next':
        jumpHunk(1)
        break
      case 'swap':
        ;[state.left, state.right] = [state.right, state.left]
        state.activeHunk = -1
        recomputeAndRender()
        break
      case 'export':
        await exportReport()
        break
      case 'clear':
        state.left = null
        state.right = null
        state.computed = null
        state.activeIndex = 0
        state.activeHunk = -1
        recomputeAndRender()
        break
    }
  })

  addManagedListener(container, 'change', (ev) => {
    if (ev.target.dataset && ev.target.dataset.opt === 'onlyDiff') {
      state.onlyDiff = Boolean(ev.target.checked)
      recomputeAndRender()
    }
  })

  for (const dropEl of container.querySelectorAll('[data-ddrop]')) {
    const side = dropEl.dataset.ddrop
    addManagedListener(dropEl, 'dragover', (ev) => {
      ev.preventDefault()
      dropEl.classList.add('drag-over')
    })
    addManagedListener(dropEl, 'dragleave', () => dropEl.classList.remove('drag-over'))
    addManagedListener(dropEl, 'drop', async (ev) => {
      ev.preventDefault()
      dropEl.classList.remove('drag-over')
      const files = Array.from(ev.dataTransfer?.files || [])
      if (!files.length) return
      if (files.length >= 2) {
        await setSideFromBuffer('left', await files[0].arrayBuffer(), files[0].name)
        await setSideFromBuffer('right', await files[1].arrayBuffer(), files[1].name)
      } else {
        await setSideFromBuffer(side, await files[0].arrayBuffer(), files[0].name)
      }
    })
  }

  return {
    async loadFiles(items) {
      if (!items.length) return
      if (items.length >= 2) {
        await setSideFromBuffer('left', items[0].buffer, items[0].name)
        await setSideFromBuffer('right', items[1].buffer, items[1].name)
        return
      }
      const one = items[0]
      const side = !state.left ? 'left' : !state.right ? 'right' : await askReplaceSide(one.name)
      if (!side || scope.signal.aborted) return
      await setSideFromBuffer(side, one.buffer, one.name)
    }
  }
}
