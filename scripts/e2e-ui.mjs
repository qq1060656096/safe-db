/* 通过 CDP + __store 钩子验证渲染层组件(查询编辑器 / 数据网格 / 侧栏树) */
async function getPageWs() {
  const res = await fetch('http://localhost:9222/json/list')
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'))
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (res.exceptionDetails) {
        throw new Error('页面内出错: ' + (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text))
      }
      return res.result?.value
    } catch (e) {
      // 页面 HMR 刷新会让挂起的 evaluate 被回收,稍等重试
      if (e.message === 'Promise was collected' && attempt < 2) {
        await new Promise((r) => setTimeout(r, 800))
        continue
      }
      throw e
    }
  }
}

async function waitFor(expression, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await evalJs(expression)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

function check(name, cond, detail) {
  if (cond) console.log(`  ✔ ${name}`)
  else {
    console.log(`  ✘ ${name} ${detail !== undefined ? JSON.stringify(detail)?.slice(0, 400) : ''}`)
    process.exitCode = 1
  }
}

async function main() {
  ws = new WebSocket(await getPageWs())
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  await waitFor('typeof window.__store !== "undefined" && typeof window.api !== "undefined"')

  console.log('== 1. 准备连接 ==')
  // 只清理本测试创建的连接(按名字匹配),绝不动用户自己的连接
  const conns = await evalJs('window.api.listConnections()')
  for (const c of conns) {
    if (c.name === 'UI测试库') await evalJs(`window.api.deleteConnection(${JSON.stringify(c.id)})`)
  }
  const conn = await evalJs(
    `window.api.saveConnection({ id: '', name: 'UI测试库', type: 'sqlite', permissionMode: 'full', filePath: '/tmp/jjtest.db' })`
  )
  await evalJs(`window.__store.getState().loadConnections()`)
  await evalJs(`window.api.connect(${JSON.stringify(conn.id)})`)

  console.log('== 2. 侧栏树 ==')
  check('连接节点渲染', await waitFor(`document.body.innerText.includes('UI测试库')`))
  check('权限标签渲染(完全访问)', await waitFor(`document.body.innerText.includes('完全访问')`))

  console.log('== 3. 查询编辑器 ==')
  await evalJs(`window.__store.getState().openTab({ type: 'query', title: '测试查询', connectionId: ${JSON.stringify(conn.id)}, database: 'main' })`)
  check('编辑器挂载', await waitFor(`!!document.querySelector('.cm-editor')`))
  check('运行按钮存在', await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('运行'))`))
  // 通过 CodeMirror 的 DOM 输入 SQL 比较脆,这里直接调用编辑器内部路径:先聚焦再插入文本
  await evalJs(`(() => {
    const cm = document.querySelector('.cm-content')
    cm.focus()
    document.execCommand('insertText', false, 'SELECT id, name, age FROM users ORDER BY id')
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  // 点击运行按钮
  await evalJs(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('运行'))?.click()`)
  check('查询结果渲染(张三)', await waitFor(`document.body.innerText.includes('张三')`))
  check('查询结果渲染(赵六)', await waitFor(`document.body.innerText.includes('赵六')`))
  check('耗时显示', await waitFor(`/\\d+ms/.test(document.body.innerText)`))

  console.log('== 4. 数据网格 ==')
  await evalJs(`window.__store.getState().openTab({ type: 'table', title: 'users', connectionId: ${JSON.stringify(conn.id)}, database: 'main', table: 'users' })`)
  check('网格行渲染(>=4 行)', await waitFor(`document.querySelectorAll('.data-grid-page tbody tr').length >= 4`))
  check('总数显示 共 4 行', await waitFor(`document.body.innerText.includes('共 4 行')`))
  check('主键标识渲染', await waitFor(`document.body.innerText.includes('🔑')`))
  check('保存按钮存在且禁用', await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('保存') && b.disabled)`))
  check('添加行按钮可用', await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('添加行') && !b.disabled)`))

  console.log('== 5. 视图只读 ==')
  await evalJs(`window.__store.getState().openTab({ type: 'table', title: 'v_user_orders', connectionId: ${JSON.stringify(conn.id)}, database: 'main', table: 'v_user_orders' })`)
  check('视图数据渲染', await waitFor(`document.body.innerText.includes('99.5')`))

  // 收尾:只关闭属于本测试连接的标签页(保留用户的标签页),再删除本测试连接
  await evalJs(`(() => { const s = window.__store.getState(); s.tabs.filter(t => t.connectionId === ${JSON.stringify(conn.id)}).forEach(t => s.closeTab(t.id)) })()`)
  await evalJs(`window.api.deleteConnection(${JSON.stringify(conn.id)})`)
  await evalJs(`window.__store.getState().loadConnections()`)

  console.log(process.exitCode ? '== 存在失败项 ==' : '== 全部通过 ==')
  ws.close()
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => {
  console.error('测试脚本错误:', e)
  process.exit(1)
})
