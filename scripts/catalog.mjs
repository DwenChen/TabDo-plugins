import fs from 'node:fs/promises'
import path from 'node:path'
import { createBrotliCompress } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import * as asar from '@electron/asar'

const root = path.resolve(import.meta.dirname, '..')
const catalog = JSON.parse((await fs.readFile(path.join(root, 'index.json'), 'utf8')).replace(/^\uFEFF/, ''))
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)) throw new Error('Invalid catalog schema')
const names = new Set()
for (const plugin of catalog.plugins) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin.name) || names.has(plugin.name)) throw new Error('Invalid or duplicate plugin name')
  names.add(plugin.name)
  if (!/^\d+\.\d+\.\d+$/.test(plugin.version) || plugin.lifecycle !== 'session-v1') throw new Error('Invalid plugin version or lifecycle')
  if (!Array.isArray(plugin.platform) || plugin.platform.some(item => !['win32', 'darwin', 'linux'].includes(item))) throw new Error('Invalid platforms')
  if (new URL(plugin.downloadUrl).origin !== 'https://github.com' || !plugin.downloadUrl.startsWith('https://github.com/DwenChen/TabDo-plugins/releases/')) throw new Error('Invalid release source')
  const directory = path.join(root, 'plugins', plugin.name)
  const manifest = JSON.parse((await fs.readFile(path.join(directory, 'plugin.json'), 'utf8')).replace(/^\uFEFF/, ''))
  for (const key of ['name', 'version', 'lifecycle']) if (manifest[key] !== plugin[key]) throw new Error('Manifest mismatch: ' + key)
  for (const file of [manifest.main, manifest.logo, 'LICENSE', 'README.md']) {
    if (!file || path.isAbsolute(file) || file.includes('..')) throw new Error('Unsafe entry path')
    await fs.access(path.join(directory, file))
  }
  if (process.argv[2] === 'build') {
    const output = path.join(root, 'dist')
    await fs.mkdir(output, { recursive: true })
    const archive = path.join(output, plugin.name + '.asar')
    await asar.createPackage(directory, archive)
    await pipeline(createReadStream(archive), createBrotliCompress(), createWriteStream(path.join(output, `${plugin.name}-${plugin.version}.zpx`)))
    await fs.unlink(archive)
  }
}
console.log(`Validated ${names.size} session-v1 plugin(s)`)
