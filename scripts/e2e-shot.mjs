/* 截图验证:打开 users 表 → 显示筛选栏 → 抓 DataGrid。确认新工具栏按钮与筛选 UI 正常渲染。 */
import { writeFileSync } from 'node:fs'
async function getPageWs() {
  const res = await fetch('http://localhost:9222/json/list')
  const page = (await res.json()).find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'))
  if (!page) throw new Error('找不到页面')
  return page.webSocketDebuggerUrl
}
let msgId = 0
const pending = new Map()
let ws
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MYSQL = { host: '127.0.0.1', port: 23306, user: 'root', password: 'jjtest123', database: 'jjdemo' }
const J = JSON.stringify

async function main() {
  ws = new WebSocket(await getPageWs())
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) }
  }

  // 连接 + 打开 users 表
  const conn = await evalJs(`window.__store.getState().saveConnection({ id:'', name:'shot', type:'mysql', permissionMode:'approval', host:${J(MYSQL.host)}, port:${MYSQL.port}, user:${J(MYSQL.user)}, password:${J(MYSQL.password)}, database:${J(MYSQL.database)} }).then(()=>window.__store.getState().connections.find(c=>c.name==='shot'))`)
  await evalJs(`window.api.connect(${J(conn.id)})`)
  await evalJs(`window.__store.getState().openTab({ type:'table', title:'users', connectionId:${J(conn.id)}, database:'jjdemo', table:'users' })`)
  await sleep(1500)
  // 显示筛选栏(点「筛选」按钮)
  await evalJs(`([...document.querySelectorAll('button')].find(b=>b.textContent.includes('筛选')))?.click()`)
  await sleep(500)
  // 在一个筛选框里输入条件,展示效果
  await evalJs(`(() => {
    const bar = document.querySelector('.workspace-main')
    const inputs = [...document.querySelectorAll('input')].filter(i=>i.closest('div')?.textContent)
  })()`)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/jj-datagrid.png', Buffer.from(shot.data, 'base64'))
  console.log('截图已存 /tmp/jj-datagrid.png')

  await evalJs(`window.api.deleteConnection(${J(conn.id)})`)
  ws.close()
  process.exit(0)
}
main().catch((e) => { console.error('错误:', e); process.exit(1) })
