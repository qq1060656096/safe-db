/* UI 冒烟:侧边栏受控展开(懒加载)+ 搜索过滤。驱动真实 DOM,确认改动没弄坏树交互。 */
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
  for (let a = 0; a < 3; a++) {
    try {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result?.value
    } catch (e) {
      if (e.message === 'Promise was collected' && a < 2) { await new Promise((r) => setTimeout(r, 800)); continue }
      throw e
    }
  }
}
function check(name, cond, detail) {
  if (cond) console.log(`  ✔ ${name}`)
  else { console.log(`  ✘ ${name} ${detail !== undefined ? JSON.stringify(detail)?.slice(0, 300) : ''}`); process.exitCode = 1 }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MYSQL = { host: '127.0.0.1', port: 23306, user: 'root', password: 'jjtest123', database: 'jjdemo' }

async function main() {
  ws = new WebSocket(await getPageWs())
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) }
  }
  const J = JSON.stringify

  // 清掉此前测试遗留的本脚本产物(只删 ui-/feat- 前缀,绝不动用户自建连接)
  const existing = await evalJs(`window.__store.getState().connections.map(c=>({id:c.id,name:c.name}))`)
  for (const c of existing ?? []) {
    if (/^(ui-|feat-)/.test(c.name)) await evalJs(`window.api.deleteConnection(${J(c.id)})`)
  }
  await evalJs(`window.__store.getState().loadConnections()`)
  await sleep(400)

  // 建一个 mysql 连接(经 store,侧边栏会刷新)
  const conn = await evalJs(`window.__store.getState().saveConnection({ id:'', name:'ui-search', type:'mysql', permissionMode:'full', host:${J(MYSQL.host)}, port:${MYSQL.port}, user:${J(MYSQL.user)}, password:${J(MYSQL.password)}, database:${J(MYSQL.database)} }).then(()=>window.__store.getState().connections.find(c=>c.name==='ui-search'))`)
  check('连接已建并上树', !!conn?.id, conn)
  await sleep(500)

  // 搜索框存在
  const hasSearch = await evalJs(`!!document.querySelector('.sidebar-search input')`)
  check('搜索框已渲染', hasSearch === true)

  // 精准展开 ui-search 连接(点它自己的 switcher),懒加载数据库
  await evalJs(`(() => {
    const nodes = [...document.querySelectorAll('.n-tree-node')]
    const node = nodes.find(n => n.textContent.includes('ui-search'))
    node?.querySelector('.n-tree-node-switcher')?.click()
  })()`)
  await sleep(1500)
  const afterExpand = await evalJs(`[...document.querySelectorAll('.n-tree-node')].map(n=>n.textContent)`)
  check('展开连接加载数据库(jjdemo)', afterExpand?.some((t) => t.includes('jjdemo')), afterExpand)

  // 精准展开 jjdemo 数据库,懒加载表
  await evalJs(`(() => {
    const nodes = [...document.querySelectorAll('.n-tree-node')]
    const node = nodes.find(n => n.textContent.trim().startsWith('jjdemo'))
    node?.querySelector('.n-tree-node-switcher')?.click()
  })()`)
  await sleep(1500)
  const tables = await evalJs(`[...document.querySelectorAll('.n-tree-node')].map(n=>n.textContent)`)
  check('展开库加载表(users/orders)', tables?.some((t) => t.includes('users')) && tables?.some((t) => t.includes('orders')), tables)

  // 输入搜索词 'users',应只保留匹配节点及其祖先
  await evalJs(`(() => {
    const input = document.querySelector('.sidebar-search input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'users')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(500)
  const filtered = await evalJs(`[...document.querySelectorAll('.n-tree-node')].map(n=>n.textContent)`)
  const hasUsers = filtered?.some((t) => t.includes('users'))
  const hasOrders = filtered?.some((t) => t.includes('orders'))
  check('搜索 users:保留 users,隐藏 orders', hasUsers === true && hasOrders === false, filtered)

  // 清空搜索,恢复整棵树
  await evalJs(`(() => {
    const input = document.querySelector('.sidebar-search input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(500)
  const restored = await evalJs(`[...document.querySelectorAll('.n-tree-node')].map(n=>n.textContent)`)
  check('清空搜索恢复(users 与 orders 都在)', restored?.some((t) => t.includes('users')) && restored?.some((t) => t.includes('orders')), restored)

  // 清理
  await evalJs(`window.api.deleteConnection(${J(conn.id)})`)
  console.log(process.exitCode ? '== 存在失败项 ==' : '== 全部通过 ==')
  ws.close()
  process.exit(process.exitCode ?? 0)
}
main().catch((e) => { console.error('测试脚本错误:', e); process.exit(1) })
