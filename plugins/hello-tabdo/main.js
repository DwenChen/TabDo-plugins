const scope = window.tabdo.lifecycle
const input = document.querySelector('textarea')
const status = document.querySelector('[role=status]')
const button = document.querySelector('button')
input.value = window.tabdo.dbStorage.getItem('text') || ''
let seconds = 0
const timer = setInterval(() => { document.querySelector('#seconds').textContent = String(++seconds) }, 1000)
scope.addCleanup(() => clearInterval(timer))
/**
 * 登记完整写入链，退出后不捕获页面或更新旧正文。
 * @returns {Promise<void>} 保存完成后的 Promise。
 */
async function save() {
  const value = input.value
  button.disabled = true
  try {
    await scope.runTask(async task => {
      task.signal.throwIfAborted()
      window.tabdo.dbStorage.setItem('text', value)
    }, 10000)
    if (!scope.signal.aborted) status.textContent = '已保存'
  } finally {
    if (!scope.signal.aborted) button.disabled = false
  }
}
button.addEventListener('click', save)
scope.addCleanup(() => button.removeEventListener('click', save))
