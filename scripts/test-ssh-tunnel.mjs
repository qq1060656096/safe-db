/* SSH 会话断开后，本地转发必须停止且不得把 ssh2 异常泄漏到主进程。 */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { rmSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import ssh2 from 'ssh2'

const { Server } = ssh2
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(root, 'node_modules', '.cache', `safe-db-ssh-tunnel.${process.pid}.mjs`)

buildSync({
  entryPoints: [join(root, 'src/main/ssh/tunnel.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  external: ['ssh2'],
  logLevel: 'silent'
})

const { establishTunnel } = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
})

let serverClient
const sshServer = new Server({ hostKeys: [privateKey] }, (client) => {
  serverClient = client
  client.on('authentication', (context) => context.accept())
})

let handle
let uncaught
const onUncaughtException = (error) => { uncaught = error }
process.once('uncaughtException', onUncaughtException)

try {
  await new Promise((resolve, reject) => {
    sshServer.once('error', reject)
    sshServer.listen(0, '127.0.0.1', resolve)
  })
  const address = sshServer.address()
  assert.ok(address && typeof address !== 'string')

  handle = await establishTunnel({
    id: 'ssh-regression',
    name: 'SSH regression',
    type: 'mysql',
    host: '127.0.0.1',
    port: 65534,
    permissionMode: 'readonly',
    ssh: {
      enabled: true,
      host: '127.0.0.1',
      port: address.port,
      user: 'test',
      authType: 'password',
      password: 'test'
    }
  })
  assert.equal(handle.isActive(), true)
  assert.ok(serverClient)

  await new Promise((resolve) => {
    serverClient.once('close', resolve)
    serverClient.end()
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(handle.isActive(), false)

  await new Promise((resolve) => {
    const socket = net.connect(handle.localPort, '127.0.0.1')
    socket.once('error', resolve)
    socket.once('close', resolve)
    setTimeout(() => {
      socket.destroy()
      resolve()
    }, 500)
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(uncaught, undefined)

  console.log('✔ SSH 断线后本地转发安全停止')
} finally {
  process.removeListener('uncaughtException', onUncaughtException)
  await handle?.close().catch(() => {})
  await new Promise((resolve) => sshServer.close(resolve))
  rmSync(outfile, { force: true })
}
