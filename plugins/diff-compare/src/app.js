/**
 * TabDo「差异比较」插件主入口。
 * 协调 7 大本地对比模式、宿主 session-v1 生命周期、主题同步与 onPluginEnter 自动分流。
 */

import {
  scope,
  preloadApi,
  addManagedListener,
  addManagedTimeout,
  initThemeSync,
  initTemporaryResidentSupport,
  registerPluginEnter
} from './tabdo-bridge.js'
import { detectFileKind } from './parsers.js'
import { createTextView } from './views/text-view.js'
import { createImageView } from './views/image-view.js'
import { createFolderView } from './views/folder-view.js'
import { createDocView } from './views/doc-view.js'

const toastHost = document.getElementById('toast-host')
const replaceModal = document.getElementById('replace-modal')
const replaceDesc = document.getElementById('replace-desc')

function showToast(message) {
  if (scope.signal.aborted || !message) return
  const el = document.createElement('div')
  el.className = 'toast-item'
  el.textContent = String(message)
  toastHost.appendChild(el)
  addManagedTimeout(() => el.remove(), 2600)
}

function askReplaceSide(filename) {
  return new Promise((resolve) => {
    if (scope.signal.aborted) {
      resolve(null)
      return
    }
    replaceDesc.textContent = `检测到文件「${filename || '未命名'}」，请选择要替换哪一侧：`
    replaceModal.classList.remove('hidden')

    const cleanup = () => {
      replaceModal.classList.add('hidden')
      replaceModal.removeEventListener('click', onClick)
      scope.signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      resolve(null)
    }
    const onClick = (ev) => {
      if (ev.target === replaceModal) {
        cleanup()
        resolve(null)
        return
      }
      const btn = ev.target.closest('[data-replace]')
      if (!btn) return
      const choice = btn.dataset.replace
      cleanup()
      resolve(choice === 'left' || choice === 'right' ? choice : null)
    }
    replaceModal.addEventListener('click', onClick)
    scope.signal.addEventListener('abort', onAbort, { once: true })
  })
}

let activeMode = 'text'

function switchMode(mode) {
  if (!views[mode]) return
  activeMode = mode
  for (const tab of document.querySelectorAll('.mode-tab')) {
    const isAct = tab.dataset.mode === mode
    tab.classList.toggle('active', isAct)
    tab.setAttribute('aria-selected', String(isAct))
  }
  for (const panel of document.querySelectorAll('.view-panel')) {
    panel.classList.toggle('active', panel.dataset.view === mode)
  }
}

const sharedCtx = {
  showToast,
  askReplaceSide,
  async openPairInTab(targetMode, items) {
    switchMode(targetMode)
    const view = views[targetMode]
    if (view && typeof view.loadFiles === 'function') {
      await view.loadFiles(items)
    }
  }
}

const views = {
  text: createTextView(document.getElementById('view-text'), sharedCtx),
  image: createImageView(document.getElementById('view-image'), sharedCtx),
  folder: createFolderView(document.getElementById('view-folder'), sharedCtx),
  docx: createDocView(document.getElementById('view-docx'), 'docx', sharedCtx),
  excel: createDocView(document.getElementById('view-excel'), 'excel', sharedCtx),
  pdf: createDocView(document.getElementById('view-pdf'), 'pdf', sharedCtx),
  pptx: createDocView(document.getElementById('view-pptx'), 'pptx', sharedCtx)
}

// 顶栏标签切换
for (const tab of document.querySelectorAll('.mode-tab')) {
  addManagedListener(tab, 'click', () => switchMode(tab.dataset.mode))
}

// 全局粘贴事件：在图片/文档页面支持 Ctrl+V 直接粘贴图片或文件
addManagedListener(window, 'paste', async (ev) => {
  if (scope.signal.aborted) return
  const activeEl = document.activeElement
  if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
    // 文本输入焦点中且粘贴纯文字时保持原生粘贴
    const hasFiles = ev.clipboardData && ev.clipboardData.files && ev.clipboardData.files.length > 0
    if (!hasFiles) return
  }

  const dt = ev.clipboardData
  if (!dt || !dt.files || !dt.files.length) return
  ev.preventDefault()

  const files = Array.from(dt.files)
  const items = []
  for (const f of files.slice(0, 2)) {
    const ab = await f.arrayBuffer()
    if (scope.signal.aborted) return
    items.push({ name: f.name || '粘贴文件.png', buffer: ab, type: f.type })
  }
  if (!items.length) return

  const first = items[0]
  const kind = first.type && first.type.startsWith('image/') ? 'image' : detectFileKind(first.name)
  const target = views[kind] ? kind : activeMode === 'folder' ? 'text' : activeMode
  switchMode(target)
  if (views[target] && typeof views[target].loadFiles === 'function') {
    await views[target].loadFiles(items)
  }
})

// 宿主 onPluginEnter 进入参数自动路由（文件 / 文件夹 / 图片）
registerPluginEnter(async (action) => {
  if (scope.signal.aborted || !action) return

  if (action.type === 'img' && typeof action.payload === 'string') {
    switchMode('image')
    await views.image.loadDataUrl(action.payload, '传入图片.png')
    return
  }

  if (action.type === 'files' && Array.isArray(action.payload) && action.payload.length) {
    const entries = action.payload.filter((item) => item && typeof item.path === 'string').slice(0, 2)
    if (!entries.length || !preloadApi) return

    const stats = []
    for (const item of entries) {
      const st = await preloadApi.statAuthorizedPath(item.path)
      if (scope.signal.aborted) return
      if (st.ok) stats.push(st)
    }
    if (!stats.length) return

    if (stats.every((s) => s.isDir)) {
      switchMode('folder')
      await views.folder.loadDirectories(stats.map((s) => s.path))
      return
    }

    const fileStats = stats.filter((s) => s.isFile)
    if (!fileStats.length) return
    const loaded = []
    for (const fsItem of fileStats) {
      const read = await preloadApi.readFileAt(fsItem.path)
      if (scope.signal.aborted) return
      if (read.ok) loaded.push({ name: read.name, buffer: read.data })
    }
    if (!loaded.length) return

    const kind = detectFileKind(loaded[0].name)
    const target = views[kind] ? kind : 'text'
    switchMode(target)
    await views[target].loadFiles(loaded)
  }
})

// 初始化主题同步与用户可控的标题栏「临时常驻」开关声明
initThemeSync()
initTemporaryResidentSupport()
