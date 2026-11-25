/**
 * 图片对比视图。
 * 支持四种模式：左右对比、滑动对比、淡化对比、差异高亮（像素级差分）。
 * 严格遵守 TabDo 资源规范：
 * - 图像差分画布限制最大边长 4096px；
 * - 所有 ObjectURL 与 Canvas 缓冲在切换图片和退出会话时立即释放；
 * - 差异计算支持请求代际取消，不回填过期结果；
 * - 另存为 PNG 走 scope.runTask 有限必要任务。
 */

import {
  scope,
  preloadApi,
  addManagedListener,
  createManagedObjectUrl,
  saveExportTask
} from '../tabdo-bridge.js'

const MAX_CANVAS_EDGE = 4096

export function createImageView(container, { showToast, askReplaceSide }) {
  const state = {
    left: null, // { name, url, releaseUrl, img, width, height }
    right: null,
    mode: 'slider', // 'split' | 'slider' | 'fade' | 'diff'
    sliderPos: 50,
    fadeAlpha: 50,
    threshold: 24,
    zoom: 1,
    panX: 0,
    panY: 0,
    diffCanvas: null,
    diffPercent: null,
    diffToken: 0,
    computingDiff: false
  }

  let draggingPan = false
  let draggingSlider = false
  let dragStartX = 0
  let dragStartY = 0
  let panStartX = 0
  let panStartY = 0

  container.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-group">
        <button type="button" class="btn btn-active" data-imode="slider">滑动对比</button>
        <button type="button" class="btn" data-imode="fade">淡化对比</button>
        <button type="button" class="btn" data-imode="split">左右对比</button>
        <button type="button" class="btn" data-imode="diff">差异高亮</button>
      </div>
      <div class="toolbar-group hidden" data-el="fade-ctrl">
        <span style="font-size:12px;color:var(--text-secondary)">透明度</span>
        <input type="range" min="0" max="100" value="50" data-el="fade-range" style="width:90px" />
        <span data-el="fade-val" style="font-size:11.5px;width:32px">50%</span>
      </div>
      <div class="toolbar-group hidden" data-el="thresh-ctrl">
        <span style="font-size:12px;color:var(--text-secondary)">容差</span>
        <input type="range" min="0" max="80" value="24" data-el="thresh-range" style="width:80px" />
        <span data-el="thresh-val" style="font-size:11.5px;width:24px">24</span>
      </div>
      <div class="toolbar-group">
        <button type="button" class="btn" data-act="zoom-out" title="缩小">−</button>
        <button type="button" class="btn" data-act="zoom-reset" data-el="zoom-label" title="点击恢复 100%">100%</button>
        <button type="button" class="btn" data-act="zoom-in" title="放大">+</button>
        <button type="button" class="btn" data-act="fit" title="适应窗口">适应</button>
      </div>
      <div class="toolbar-spacer"></div>
      <span class="stat-pill" data-el="stat">请选择两张图片</span>
      <div class="toolbar-group">
        <button type="button" class="btn" data-act="pick-left">选左图</button>
        <button type="button" class="btn" data-act="pick-right">选右图</button>
        <button type="button" class="btn" data-act="swap">互换</button>
        <button type="button" class="btn" data-act="save-png">另存 PNG</button>
        <button type="button" class="btn" data-act="clear">清空</button>
      </div>
    </div>
    <div class="split-panes" data-el="empty-panes">
      <div class="drop-card" data-idrop="left">
        <div class="drop-card__title">左图</div>
        <div class="drop-card__hint">拖拽图片到此处、Ctrl+V 粘贴截图，或点击选择本地图片</div>
        <div class="drop-card__file" data-el="empty-left-name"></div>
        <button type="button" class="btn btn-primary" data-act="pick-left">选择左侧图片</button>
      </div>
      <div class="drop-card" data-idrop="right">
        <div class="drop-card__title">右图</div>
        <div class="drop-card__hint">拖拽图片到此处、Ctrl+V 粘贴截图，或点击选择本地图片</div>
        <div class="drop-card__file" data-el="empty-right-name"></div>
        <button type="button" class="btn btn-primary" data-act="pick-right">选择右侧图片</button>
      </div>
    </div>
    <div class="image-stage-wrap hidden" data-el="stage-wrap">
      <div class="image-viewport" data-el="viewport"></div>
    </div>
  `

  const elEmptyPanes = container.querySelector('[data-el="empty-panes"]')
  const elStageWrap = container.querySelector('[data-el="stage-wrap"]')
  const elViewport = container.querySelector('[data-el="viewport"]')
  const elStat = container.querySelector('[data-el="stat"]')
  const elZoomLabel = container.querySelector('[data-el="zoom-label"]')
  const elFadeCtrl = container.querySelector('[data-el="fade-ctrl"]')
  const elFadeRange = container.querySelector('[data-el="fade-range"]')
  const elFadeVal = container.querySelector('[data-el="fade-val"]')
  const elThreshCtrl = container.querySelector('[data-el="thresh-ctrl"]')
  const elThreshRange = container.querySelector('[data-el="thresh-range"]')
  const elThreshVal = container.querySelector('[data-el="thresh-val"]')
  const elEmptyLeftName = container.querySelector('[data-el="empty-left-name"]')
  const elEmptyRightName = container.querySelector('[data-el="empty-right-name"]')

  function releaseSide(side) {
    const slot = state[side]
    if (!slot) return
    if (slot.releaseUrl) slot.releaseUrl()
    state[side] = null
  }

  function releaseDiffCanvas() {
    if (state.diffCanvas) {
      state.diffCanvas.width = 0
      state.diffCanvas.height = 0
      state.diffCanvas = null
    }
    state.diffPercent = null
  }

  // 会话退出时显式清空画布像素缓冲
  scope.addCleanup(() => {
    releaseSide('left')
    releaseSide('right')
    releaseDiffCanvas()
  })

  function loadImageFromBlob(blob, name) {
    return new Promise((resolve, reject) => {
      const { url, release } = createManagedObjectUrl(blob)
      const img = new Image()
      img.onload = () => {
        if (scope.signal.aborted) {
          release()
          reject(new Error('会话已结束'))
          return
        }
        resolve({
          name: name || '未命名图片',
          url,
          releaseUrl: release,
          img,
          width: img.naturalWidth,
          height: img.naturalHeight
        })
      }
      img.onerror = () => {
        release()
        reject(new Error('图片解码失败'))
      }
      img.src = url
    })
  }

  function getAlignedDims() {
    if (!state.left || !state.right) return { w: 0, h: 0 }
    let w = Math.max(state.left.width, state.right.width)
    let h = Math.max(state.left.height, state.right.height)
    const maxEdge = Math.max(w, h)
    if (maxEdge > MAX_CANVAS_EDGE) {
      const scale = MAX_CANVAS_EDGE / maxEdge
      w = Math.max(1, Math.round(w * scale))
      h = Math.max(1, Math.round(h * scale))
    }
    return { w, h }
  }

  function updateStatBadge() {
    if (!state.left && !state.right) {
      elStat.className = 'stat-pill'
      elStat.textContent = '请选择两张图片'
      return
    }
    if (!state.left || !state.right) {
      const one = state.left || state.right
      elStat.className = 'stat-pill'
      elStat.textContent = `已载入 1 张（${one.width}×${one.height}），等待另一张`
      return
    }
    const sizeSame = state.left.width === state.right.width && state.left.height === state.right.height
    const sizeText = sizeSame
      ? `${state.left.width}×${state.left.height}`
      : `${state.left.width}×${state.left.height} vs ${state.right.width}×${state.right.height}`

    if (state.mode === 'diff') {
      if (state.computingDiff) {
        elStat.className = 'stat-pill'
        elStat.textContent = '正在计算像素差异…'
      } else if (state.diffPercent !== null) {
        elStat.className = state.diffPercent === 0 ? 'stat-pill same' : 'stat-pill mod'
        elStat.textContent =
          state.diffPercent === 0
            ? `像素一致 · ${sizeText}`
            : `差异 ${state.diffPercent.toFixed(2)}% · ${sizeText}`
      }
      return
    }
    elStat.className = sizeSame ? 'stat-pill same' : 'stat-pill mod'
    elStat.textContent = sizeSame ? `尺寸一致 · ${sizeText}` : `尺寸不同 · ${sizeText}`
  }

  async function computePixelDiff() {
    if (!state.left || !state.right) return
    const token = ++state.diffToken
    state.computingDiff = true
    updateStatBadge()

    await new Promise((r) => requestAnimationFrame(r))
    if (scope.signal.aborted || token !== state.diffToken) return

    const { w, h } = getAlignedDims()
    const c1 = document.createElement('canvas')
    const c2 = document.createElement('canvas')
    const out = document.createElement('canvas')
    c1.width = c2.width = out.width = w
    c1.height = c2.height = out.height = h

    try {
      const ctx1 = c1.getContext('2d', { willReadFrequently: true })
      const ctx2 = c2.getContext('2d', { willReadFrequently: true })
      const ctxOut = out.getContext('2d')
      if (!ctx1 || !ctx2 || !ctxOut) throw new Error('画布初始化失败')

      ctx1.drawImage(state.left.img, 0, 0, w, h)
      ctx2.drawImage(state.right.img, 0, 0, w, h)
      const d1 = ctx1.getImageData(0, 0, w, h).data
      const d2 = ctx2.getImageData(0, 0, w, h).data
      const res = ctxOut.createImageData(w, h)
      const dst = res.data
      const thresh = state.threshold
      let diffPixels = 0
      const total = w * h

      for (let i = 0; i < d1.length; i += 4) {
        const dr = Math.abs(d1[i] - d2[i])
        const dg = Math.abs(d1[i + 1] - d2[i + 1])
        const db = Math.abs(d1[i + 2] - d2[i + 2])
        const da = Math.abs(d1[i + 3] - d2[i + 3])
        const maxDelta = Math.max(dr, dg, db, da)

        if (maxDelta > thresh) {
          diffPixels++
          // 品红高亮差异像素，对比度清晰
          dst[i] = 239
          dst[i + 1] = 45
          dst[i + 2] = 108
          dst[i + 3] = 245
        } else {
          // 未变化区域按低亮度灰度保留轮廓，方便定位
          const lum = Math.round((d1[i] * 0.299 + d1[i + 1] * 0.587 + d1[i + 2] * 0.114) * 0.35 + 165)
          dst[i] = lum
          dst[i + 1] = lum
          dst[i + 2] = lum
          dst[i + 3] = Math.max(d1[i + 3], d2[i + 3])
        }
      }

      ctxOut.putImageData(res, 0, 0)
      if (scope.signal.aborted || token !== state.diffToken) {
        out.width = 0
        out.height = 0
        return
      }

      releaseDiffCanvas()
      state.diffCanvas = out
      state.diffPercent = total > 0 ? (diffPixels / total) * 100 : 0
      state.computingDiff = false
      renderStage()
      updateStatBadge()
    } catch (e) {
      state.computingDiff = false
      if (!scope.signal.aborted) showToast(`差异图计算失败：${e.message || e}`)
    } finally {
      c1.width = c1.height = 0
      c2.width = c2.height = 0
    }
  }

  function fitToViewport() {
    if (!state.left || !state.right) return
    const rect = elViewport.getBoundingClientRect()
    const { w, h } = getAlignedDims()
    if (!rect.width || !rect.height || !w || !h) return
    const availW = state.mode === 'split' ? rect.width / 2 - 24 : rect.width - 24
    const availH = rect.height - 24
    state.zoom = Math.max(0.05, Math.min(4, Math.min(availW / w, availH / h, 1)))
    state.panX = 0
    state.panY = 0
    applyTransform()
  }

  function applyTransform() {
    elZoomLabel.textContent = `${Math.round(state.zoom * 100)}%`
    for (const el of elViewport.querySelectorAll('[data-zoom-target]')) {
      el.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`
    }
  }

  function renderStage() {
    elEmptyLeftName.textContent = state.left ? `${state.left.name} (${state.left.width}×${state.left.height})` : ''
    elEmptyRightName.textContent = state.right ? `${state.right.name} (${state.right.width}×${state.right.height})` : ''

    const ready = Boolean(state.left && state.right)
    elEmptyPanes.classList.toggle('hidden', ready)
    elStageWrap.classList.toggle('hidden', !ready)
    elFadeCtrl.classList.toggle('hidden', state.mode !== 'fade')
    elThreshCtrl.classList.toggle('hidden', state.mode !== 'diff')

    updateStatBadge()
    if (!ready) {
      elViewport.innerHTML = ''
      return
    }

    const { w, h } = getAlignedDims()
    elViewport.innerHTML = ''

    if (state.mode === 'split') {
      const grid = document.createElement('div')
      grid.className = 'image-split-grid'
      grid.innerHTML = `
        <div class="image-split-cell">
          <span class="image-tag">左图 · ${state.left.width}×${state.left.height}</span>
          <img src="${state.left.url}" data-zoom-target width="${w}" height="${h}" alt="左图" />
        </div>
        <div class="image-split-cell">
          <span class="image-tag">右图 · ${state.right.width}×${state.right.height}</span>
          <img src="${state.right.url}" data-zoom-target width="${w}" height="${h}" alt="右图" />
        </div>`
      elViewport.appendChild(grid)
    } else if (state.mode === 'slider') {
      const stack = document.createElement('div')
      stack.className = 'image-layer-stack'
      stack.innerHTML = `
        <span class="image-tag">左图 ⇄ 右图（拖动分割线）</span>
        <div class="image-overlay-box" data-zoom-target style="width:${w}px;height:${h}px">
          <img src="${state.right.url}" width="${w}" height="${h}" alt="右图" />
          <div class="image-overlay-top" data-el="slider-clip" style="clip-path:inset(0 ${100 - state.sliderPos}% 0 0)">
            <img src="${state.left.url}" width="${w}" height="${h}" alt="左图" />
          </div>
          <div class="slider-divider" data-el="slider-line" style="left:${state.sliderPos}%">
            <div class="slider-handle">⇄</div>
          </div>
        </div>`
      elViewport.appendChild(stack)
    } else if (state.mode === 'fade') {
      const stack = document.createElement('div')
      stack.className = 'image-layer-stack'
      stack.innerHTML = `
        <span class="image-tag">右图透明度 ${state.fadeAlpha}%</span>
        <div class="image-overlay-box" data-zoom-target style="width:${w}px;height:${h}px">
          <img src="${state.left.url}" width="${w}" height="${h}" alt="左图" />
          <img src="${state.right.url}" width="${w}" height="${h}" alt="右图"
               data-el="fade-top" style="position:absolute;inset:0;opacity:${state.fadeAlpha / 100}" />
        </div>`
      elViewport.appendChild(stack)
    } else if (state.mode === 'diff') {
      const stack = document.createElement('div')
      stack.className = 'image-layer-stack'
      const tag = document.createElement('span')
      tag.className = 'image-tag'
      tag.textContent = state.computingDiff ? '正在计算像素差异…' : '像素差异高亮'
      stack.appendChild(tag)

      if (state.diffCanvas) {
        const box = document.createElement('div')
        box.className = 'image-overlay-box'
        box.dataset.zoomTarget = '1'
        box.style.width = `${w}px`
        box.style.height = `${h}px`
        box.appendChild(state.diffCanvas)
        stack.appendChild(box)
      }
      elViewport.appendChild(stack)
    }

    applyTransform()
  }

  async function saveComparisonPng() {
    if (!state.left || !state.right) {
      showToast('请先载入两张图片')
      return
    }
    if (state.mode === 'diff' && state.computingDiff) {
      showToast('差异图仍在计算中，请稍候')
      return
    }

    const { w, h } = getAlignedDims()
    const canvas = document.createElement('canvas')
    try {
      if (state.mode === 'split') {
        const gap = 8
        canvas.width = w * 2 + gap
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(state.left.img, 0, 0, w, h)
        ctx.drawImage(state.right.img, w + gap, 0, w, h)
      } else {
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (state.mode === 'slider') {
          ctx.drawImage(state.right.img, 0, 0, w, h)
          const cutX = Math.round((w * state.sliderPos) / 100)
          ctx.save()
          ctx.beginPath()
          ctx.rect(0, 0, cutX, h)
          ctx.clip()
          ctx.drawImage(state.left.img, 0, 0, w, h)
          ctx.restore()
          ctx.fillStyle = '#059669'
          ctx.fillRect(cutX - 1, 0, 2, h)
        } else if (state.mode === 'fade') {
          ctx.drawImage(state.left.img, 0, 0, w, h)
          ctx.globalAlpha = state.fadeAlpha / 100
          ctx.drawImage(state.right.img, 0, 0, w, h)
          ctx.globalAlpha = 1
        } else if (state.diffCanvas) {
          ctx.drawImage(state.diffCanvas, 0, 0, w, h)
        }
      }

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('生成 PNG 失败')
      const ab = await blob.arrayBuffer()
      const saved = await saveExportTask({
        data: new Uint8Array(ab),
        defaultName: `图片差异对比-${Date.now()}.png`,
        title: '保存对比图片',
        buttonLabel: '保存',
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        mimeType: 'image/png'
      })
      if (scope.signal.aborted) return
      if (saved.ok) showToast(saved.downloaded ? '图片已开始下载' : `图片已保存：${saved.path}`)
      else if (!saved.canceled) showToast(saved.error || '保存失败')
    } catch (e) {
      if (!scope.signal.aborted) showToast(`保存失败：${e.message || e}`)
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }

  async function setSideFromBlob(side, blob, name) {
    try {
      const loaded = await loadImageFromBlob(blob, name)
      if (scope.signal.aborted) {
        loaded.releaseUrl()
        return
      }
      releaseSide(side)
      releaseDiffCanvas()
      state[side] = loaded
      renderStage()
      if (state.left && state.right) {
        requestAnimationFrame(() => {
          if (!scope.signal.aborted) fitToViewport()
        })
        if (state.mode === 'diff') computePixelDiff()
      }
    } catch (e) {
      if (!scope.signal.aborted) showToast(e.message || '图片加载失败')
    }
  }

  async function pickImageFile(side) {
    if (preloadApi && typeof preloadApi.pickFiles === 'function') {
      const res = await preloadApi.pickFiles({
        title: side === 'left' ? '选择左侧图片' : '选择右侧图片',
        filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'avif', 'svg'] }]
      })
      if (scope.signal.aborted || !res.ok || res.canceled || !res.files.length) return
      const read = await preloadApi.readFileAt(res.files[0].path)
      if (scope.signal.aborted) return
      if (!read.ok) {
        showToast(read.error || '读取图片失败')
        return
      }
      await setSideFromBlob(side, new Blob([read.data]), read.name)
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files && input.files[0]
      if (!file) return
      await setSideFromBlob(side, file, file.name)
    }
    input.click()
  }

  // 事件绑定
  addManagedListener(container, 'click', async (ev) => {
    const modeBtn = ev.target.closest('[data-imode]')
    if (modeBtn) {
      state.mode = modeBtn.dataset.imode
      for (const b of container.querySelectorAll('[data-imode]')) {
        b.classList.toggle('btn-active', b === modeBtn)
      }
      renderStage()
      if (state.left && state.right) {
        fitToViewport()
        if (state.mode === 'diff' && !state.diffCanvas) computePixelDiff()
      }
      return
    }
    const actBtn = ev.target.closest('[data-act]')
    if (!actBtn) return
    switch (actBtn.dataset.act) {
      case 'pick-left':
        await pickImageFile('left')
        break
      case 'pick-right':
        await pickImageFile('right')
        break
      case 'zoom-in':
        state.zoom = Math.min(8, state.zoom * 1.25)
        applyTransform()
        break
      case 'zoom-out':
        state.zoom = Math.max(0.05, state.zoom / 1.25)
        applyTransform()
        break
      case 'zoom-reset':
        state.zoom = 1
        state.panX = 0
        state.panY = 0
        applyTransform()
        break
      case 'fit':
        fitToViewport()
        break
      case 'swap':
        ;[state.left, state.right] = [state.right, state.left]
        releaseDiffCanvas()
        renderStage()
        if (state.mode === 'diff' && state.left && state.right) computePixelDiff()
        break
      case 'save-png':
        await saveComparisonPng()
        break
      case 'clear':
        releaseSide('left')
        releaseSide('right')
        releaseDiffCanvas()
        renderStage()
        break
    }
  })

  addManagedListener(elFadeRange, 'input', () => {
    state.fadeAlpha = Number(elFadeRange.value)
    elFadeVal.textContent = `${state.fadeAlpha}%`
    const top = elViewport.querySelector('[data-el="fade-top"]')
    if (top) top.style.opacity = String(state.fadeAlpha / 100)
    const tag = elViewport.querySelector('.image-tag')
    if (tag) tag.textContent = `右图透明度 ${state.fadeAlpha}%`
  })

  addManagedListener(elThreshRange, 'input', () => {
    state.threshold = Number(elThreshRange.value)
    elThreshVal.textContent = String(state.threshold)
    if (state.mode === 'diff' && state.left && state.right) computePixelDiff()
  })

  // 画布缩放、平移与滑动条拖动
  addManagedListener(elViewport, 'wheel', (ev) => {
    if (!state.left || !state.right) return
    ev.preventDefault()
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12
    state.zoom = Math.max(0.05, Math.min(8, state.zoom * factor))
    applyTransform()
  }, { passive: false })

  addManagedListener(elViewport, 'dblclick', () => fitToViewport())

  addManagedListener(elViewport, 'mousedown', (ev) => {
    if (!state.left || !state.right) return
    if (state.mode === 'slider' && !ev.shiftKey) {
      const box = elViewport.querySelector('.image-overlay-box')
      if (box) {
        const rect = box.getBoundingClientRect()
        if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          draggingSlider = true
          updateSliderFromPointer(ev.clientX, rect)
          return
        }
      }
    }
    draggingPan = true
    dragStartX = ev.clientX
    dragStartY = ev.clientY
    panStartX = state.panX
    panStartY = state.panY
    elViewport.classList.add('grabbing')
  })

  function updateSliderFromPointer(clientX, rect) {
    const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))
    state.sliderPos = pct
    const clip = elViewport.querySelector('[data-el="slider-clip"]')
    const line = elViewport.querySelector('[data-el="slider-line"]')
    if (clip) clip.style.clipPath = `inset(0 ${100 - pct}% 0 0)`
    if (line) line.style.left = `${pct}%`
  }

  addManagedListener(window, 'mousemove', (ev) => {
    if (draggingSlider) {
      const box = elViewport.querySelector('.image-overlay-box')
      if (box) updateSliderFromPointer(ev.clientX, box.getBoundingClientRect())
      return
    }
    if (!draggingPan) return
    state.panX = panStartX + (ev.clientX - dragStartX)
    state.panY = panStartY + (ev.clientY - dragStartY)
    applyTransform()
  })

  addManagedListener(window, 'mouseup', () => {
    draggingPan = false
    draggingSlider = false
    elViewport.classList.remove('grabbing')
  })

  // 拖放图片支持
  for (const dropEl of container.querySelectorAll('[data-idrop]')) {
    const side = dropEl.dataset.idrop
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
        await setSideFromBlob('left', files[0], files[0].name)
        await setSideFromBlob('right', files[1], files[1].name)
      } else {
        await setSideFromBlob(side, files[0], files[0].name)
      }
    })
  }

  return {
    async loadFiles(items) {
      if (!items.length) return
      if (items.length >= 2) {
        await setSideFromBlob('left', new Blob([items[0].buffer]), items[0].name)
        await setSideFromBlob('right', new Blob([items[1].buffer]), items[1].name)
        return
      }
      const one = items[0]
      const side = !state.left ? 'left' : !state.right ? 'right' : await askReplaceSide(one.name)
      if (!side || scope.signal.aborted) return
      await setSideFromBlob(side, new Blob([one.buffer]), one.name)
    },
    async loadDataUrl(dataUrl, name = '粘贴图片.png') {
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      if (scope.signal.aborted) return
      const side = !state.left ? 'left' : !state.right ? 'right' : await askReplaceSide(name)
      if (!side || scope.signal.aborted) return
      await setSideFromBlob(side, blob, name)
    }
  }
}
