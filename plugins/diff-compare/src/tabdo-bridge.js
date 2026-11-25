/**
 * TabDo session-v1 宿主能力桥接层。
 * 统一封装 window.tabdo、window.tabdo.lifecycle 与 window.diffPreload，
 * 所有前台监听、定时器与对象 URL 自动登记清理器，写入/导出动作统一走 runTask。
 */

function createFallbackScope() {
  const controller = new AbortController()
  const cleanups = new Set()
  const activeTasks = new Set()

  return {
    get signal() {
      return controller.signal
    },
    addCleanup(fn) {
      if (typeof fn !== 'function') throw new TypeError('cleanup must be a function')
      if (controller.signal.aborted) {
        Promise.resolve().then(() => fn()).catch(() => {})
        return async () => {}
      }
      let released = false
      const entry = async () => {
        if (released) return
        released = true
        cleanups.delete(entry)
        await fn()
      }
      cleanups.add(entry)
      return entry
    },
    async runTask(operation, timeoutMs = 60000) {
      if (controller.signal.aborted) throw new Error('会话已结束，拒绝新任务')
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) {
        throw new RangeError('无效的任务超时时间')
      }
      const taskController = new AbortController()
      const taskCleanups = new Set()
      const taskScope = {
        get signal() {
          return taskController.signal
        },
        addCleanup(fn) {
          if (typeof fn !== 'function') throw new TypeError('cleanup must be a function')
          if (taskController.signal.aborted) {
            Promise.resolve().then(() => fn()).catch(() => {})
            return async () => {}
          }
          let done = false
          const run = async () => {
            if (done) return
            done = true
            taskCleanups.delete(run)
            await fn()
          }
          taskCleanups.add(run)
          return run
        },
        runTask() {
          throw new Error('不支持嵌套任务')
        },
        async dispose() {
          taskController.abort()
          for (const fn of Array.from(taskCleanups)) {
            try {
              await fn()
            } catch {
              /* ignore */
            }
          }
        }
      }
      const timer = setTimeout(() => taskController.abort(new Error('任务超时')), timeoutMs)
      const p = Promise.resolve()
        .then(() => operation(taskScope))
        .finally(async () => {
          clearTimeout(timer)
          await taskScope.dispose()
          activeTasks.delete(p)
        })
      activeTasks.add(p)
      return await p
    },
    async dispose() {
      if (!controller.signal.aborted) controller.abort()
      for (const fn of Array.from(cleanups)) {
        try {
          await fn()
        } catch {
          /* ignore */
        }
      }
      await Promise.allSettled(Array.from(activeTasks))
    }
  }
}

export const hostApi = typeof window !== 'undefined' && window.tabdo ? window.tabdo : null
export const preloadApi = typeof window !== 'undefined' && window.diffPreload ? window.diffPreload : null
export const scope = hostApi && hostApi.lifecycle ? hostApi.lifecycle : createFallbackScope()

/**
 * 登记事件监听并在会话退出时自动解除。
 */
export function addManagedListener(target, type, listener, options) {
  if (!target || typeof target.addEventListener !== 'function') return () => {}
  target.addEventListener(type, listener, options)
  return scope.addCleanup(() => {
    try {
      target.removeEventListener(type, listener, options)
    } catch {
      /* ignore */
    }
  })
}

/**
 * 登记受控计时器。
 */
export function addManagedTimeout(fn, delayMs) {
  const id = setTimeout(() => {
    release()
    if (!scope.signal.aborted) fn()
  }, delayMs)
  const release = scope.addCleanup(() => clearTimeout(id))
  return () => {
    clearTimeout(id)
    release()
  }
}

/**
 * 创建受会话生命周期托管的 Object URL。
 */
export function createManagedObjectUrl(blob) {
  const url = URL.createObjectURL(blob)
  const release = scope.addCleanup(() => {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* ignore */
    }
  })
  return { url, release }
}

/**
 * 读取插件私有持久化存储（只读，退出会话不会清理）。
 */
export function readStorage(key) {
  try {
    if (hostApi && hostApi.dbStorage && typeof hostApi.dbStorage.getItem === 'function') {
      return hostApi.dbStorage.getItem(key)
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(`tabdo_diff_${key}`)
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 通过有限必要任务持久化写入插件私有存储（仅捕获纯字符串值，不捕获页面引用）。
 */
export async function writeStorageTask(key, serializedValue) {
  const pureKey = String(key)
  const pureValue = String(serializedValue)
  return await scope.runTask(async (task) => {
    task.signal.throwIfAborted()
    if (hostApi && hostApi.dbStorage && typeof hostApi.dbStorage.setItem === 'function') {
      hostApi.dbStorage.setItem(pureKey, pureValue)
      return true
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`tabdo_diff_${pureKey}`, pureValue)
      return true
    }
    return false
  }, 15000)
}

/**
 * 通过有限必要任务移除指定存储键。
 */
export async function removeStorageTask(key) {
  const pureKey = String(key)
  return await scope.runTask(async (task) => {
    task.signal.throwIfAborted()
    if (hostApi && hostApi.dbStorage && typeof hostApi.dbStorage.removeItem === 'function') {
      hostApi.dbStorage.removeItem(pureKey)
      return true
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`tabdo_diff_${pureKey}`)
      return true
    }
    return false
  }, 15000)
}

/**
 * 通过有限必要任务保存导出的文件（报告/PNG），只捕获纯字节与参数。
 */
export async function saveExportTask({ data, defaultName, title, buttonLabel, filters, mimeType }) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const pureOptions = {
    data: bytes,
    defaultName: String(defaultName || '差异报告.html'),
    title: String(title || '另存为'),
    buttonLabel: String(buttonLabel || '保存'),
    filters: Array.isArray(filters) ? filters.map((f) => ({ name: String(f.name), extensions: [...f.extensions] })) : undefined
  }
  const pureMime = String(mimeType || 'application/octet-stream')

  return await scope.runTask(async (task) => {
    task.signal.throwIfAborted()
    if (preloadApi && typeof preloadApi.saveFileAs === 'function') {
      return await preloadApi.saveFileAs(pureOptions)
    }
    // 非 TabDo 预览环境降级为浏览器下载
    const blob = new Blob([pureOptions.data], { type: pureMime })
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = pureOptions.defaultName
      document.body.appendChild(a)
      a.click()
      a.remove()
      return { ok: true, path: pureOptions.defaultName, downloaded: true }
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  }, 30000)
}

/**
 * 声明支持宿主标题栏的「临时常驻」用户开关（不会自动开启常驻）。
 */
export function initTemporaryResidentSupport() {
  if (!hostApi || typeof hostApi.enableTemporaryResident !== 'function') return
  Promise.resolve(hostApi.enableTemporaryResident(true)).catch(() => {})
  scope.addCleanup(() => {
    try {
      Promise.resolve(hostApi.enableTemporaryResident(false)).catch(() => {})
    } catch {
      /* ignore */
    }
  })
}

/**
 * 同步宿主明暗主题并响应主题切换事件。
 */
export function initThemeSync(onChange) {
  const apply = (isDark) => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
    if (typeof onChange === 'function') onChange(isDark)
  }

  let initialDark = false
  try {
    if (hostApi && typeof hostApi.isDarkColors === 'function') {
      initialDark = Boolean(hostApi.isDarkColors())
    } else if (typeof matchMedia === 'function') {
      initialDark = matchMedia('(prefers-color-scheme: dark)').matches
    }
  } catch {
    initialDark = false
  }
  apply(initialDark)

  if (hostApi && typeof hostApi.onThemeChange === 'function') {
    try {
      hostApi.onThemeChange((info) => {
        if (scope.signal.aborted) return
        if (info && typeof info.isDark === 'boolean') apply(info.isDark)
      })
    } catch {
      /* ignore */
    }
  }

  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const listener = (ev) => {
      if (!scope.signal.aborted) apply(Boolean(ev.matches))
    }
    mq.addEventListener('change', listener)
    scope.addCleanup(() => mq.removeEventListener('change', listener))
  }
}

/**
 * 注册宿主 onPluginEnter 进入回调。
 */
export function registerPluginEnter(callback) {
  if (!hostApi || typeof hostApi.onPluginEnter !== 'function') return
  hostApi.onPluginEnter((action) => {
    if (scope.signal.aborted) return
    callback(action)
  })
}

/**
 * 复制文本到剪贴板。
 */
export async function copyPlainText(text) {
  if (hostApi && typeof hostApi.copyText === 'function') {
    hostApi.copyText(String(text))
    return true
  }
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(String(text))
    return true
  }
  return false
}
