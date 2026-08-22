/* 审批弹窗 + 审计页面 端到端验证 */
import { unlink } from 'node:fs/promises'
async function getPageWs() {
  const port = process.env.E2E_CDP_PORT ?? '9222'
  const res = await fetch(`http://localhost:${port}/json/list`)
  const targets = await res.json()
  const prefix = process.env.E2E_PAGE_PREFIX
  const page = targets.find((t) => t.type === 'page' && (!prefix || t.url.startsWith(prefix)))
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

  console.log('== 准备:审批模式连接 ==')
  // 只清理本测试创建的连接(按名字匹配),绝不动用户自己的连接
  const TEST_CONN_NAMES = ['审批库', '只读库']
  const TEST_DB_NAME = `safe-db-e2e-approval-${process.pid}.db`
  const conns = await evalJs('window.api.listConnections()')
  const staleTestConnections = conns.filter((connection) => TEST_CONN_NAMES.includes(connection.name))
  for (const connection of staleTestConnections) {
    await evalJs(`window.api.deleteConnection(${JSON.stringify(connection.id)})`)
    if (/^\/tmp\/safe-db-e2e-approval-\d+\.db$/.test(connection.filePath ?? '')) {
      await unlink(connection.filePath).catch(() => {})
    }
  }
  if (process.argv.includes('--cleanup-only')) {
    console.log('== 测试连接已清理 ==')
    ws.close()
    return
  }
  const conn = await evalJs(
    `window.api.saveConnection({ id: '', name: '审批库', type: 'sqlite', permissionMode: 'approval', sqliteCreate: { directory: '/tmp', databaseName: ${JSON.stringify(TEST_DB_NAME)} } })`
  )
  await evalJs(`window.__store.getState().loadConnections()`)
  await evalJs(`window.api.connect(${JSON.stringify(conn.id)})`)
  for (const sql of [
    'CREATE TABLE users (id INTEGER PRIMARY KEY, age INTEGER NOT NULL)',
    'INSERT INTO users (id, age) VALUES (1, 28), (2, 35), (3, 42)'
  ]) {
    await evalJs(`window.api.executeSql(${JSON.stringify(conn.id)}, ${JSON.stringify(sql)})`).then(async (r) => {
      if (r?.status === 'needsApproval') await evalJs(`window.api.confirmExecute(${JSON.stringify(r.approvalToken)})`)
    })
  }

  console.log('== 1. 审批弹窗:确认执行 ==')
  await evalJs(`window.__store.getState().openTab({ type: 'query', title: '审批查询', connectionId: ${JSON.stringify(conn.id)}, database: 'main' })`)
  await waitFor(`!!document.querySelector('.cm-content')`)
  await evalJs(`(() => {
    const cm = document.querySelector('.cm-content')
    cm.focus()
    document.execCommand('insertText', false, "UPDATE users SET age = 88 WHERE id = 1")
  })()`)
  await sleep(300)
  await evalJs(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('运行'))?.click()`)
  check('审批弹窗出现', await waitFor(`document.body.innerText.includes('操作审批')`))
  check('弹窗展示 SQL', await waitFor(`document.body.innerText.includes('UPDATE users SET age = 88')`))
  check('弹窗标注数据修改', await waitFor(`document.body.innerText.includes('数据修改')`))
  // 点确认执行(危险按钮)
  await evalJs(`[...document.querySelectorAll('.approval-modal button')].find(b => b.innerText.includes('确认执行'))?.click()`)
  check('执行结果:影响行数 1', await waitFor(`document.body.innerText.includes('影响行数') && /影响行数[:：]\\s*1/.test(document.body.innerText)`))
  const age1 = await evalJs(`window.api.executeSql(${JSON.stringify(conn.id)}, 'SELECT age FROM users WHERE id = 1')`)
  check('数据已落库(age=88)', age1?.results?.[0]?.rows?.[0]?.age === 88, age1)

  console.log('== 2. 审批弹窗:取消 ==')
  const cntBefore = await evalJs(`window.api.executeSql(${JSON.stringify(conn.id)}, 'SELECT COUNT(*) AS n FROM users')`)
  await evalJs(`(() => {
    const cm = document.querySelector('.cm-content')
    cm.focus()
    // 全选后替换
    document.execCommand('selectAll')
    document.execCommand('insertText', false, "DELETE FROM users WHERE id = 3")
  })()`)
  await sleep(300)
  await evalJs(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('运行'))?.click()`)
  check('审批弹窗再次出现', await waitFor(`document.body.innerText.includes('操作审批')`))
  await evalJs(`[...document.querySelectorAll('.approval-modal button')].find(b => b.innerText.trim() === '取消')?.click()`)
  await sleep(400)
  const cnt = await evalJs(`window.api.executeSql(${JSON.stringify(conn.id)}, 'SELECT COUNT(*) AS n FROM users')`)
  check('取消后数据未变', cnt?.results?.[0]?.rows?.[0]?.n === cntBefore?.results?.[0]?.rows?.[0]?.n, { before: cntBefore, after: cnt })

  console.log('== 3. 审计页面 ==')
  await evalJs(`window.__store.getState().openTab({ type: 'audit', title: '审计日志' })`)
  check('双日志页渲染', await waitFor(`document.body.innerText.includes('操作日志') && document.body.innerText.includes('审批日志')`))
  await evalJs(`[...document.querySelectorAll('.audit-page .n-tabs-tab')].find(el => el.innerText.includes('审批日志'))?.click()`)
  check('含「已通过」审批事件', await waitFor(`document.body.innerText.includes('已通过')`))
  check('含「已拒绝」审批事件', await waitFor(`document.body.innerText.includes('已拒绝')`))
  // 展开所有行查看完整 SQL
  await evalJs(`[...document.querySelectorAll('.audit-page .n-data-table-expand-trigger')].forEach(el => el.click())`)
  check('含 UPDATE 语句', await waitFor(`document.body.innerText.includes('UPDATE users SET age = 88')`))

  console.log('== 4. 只读模式 UI 拦截提示 ==')
  const ro = await evalJs(
    `window.api.saveConnection({ id: '', name: '只读库', type: 'sqlite', permissionMode: 'readonly', filePath: ${JSON.stringify(conn.filePath)} })`
  )
  await evalJs(`window.__store.getState().loadConnections()`)
  await evalJs(`window.api.connect(${JSON.stringify(ro.id)})`)
  await evalJs(`window.__store.getState().openTab({ type: 'query', title: '只读查询', connectionId: ${JSON.stringify(ro.id)}, database: 'main' })`)
  await waitFor(`(() => {
    const pane = document.querySelector('.n-tab-pane:not([style*="display: none"])')
    return !!pane?.querySelector('.cm-content')
  })()`)
  await sleep(300)
  await evalJs(`(() => {
    const pane = document.querySelector('.n-tab-pane:not([style*="display: none"])')
    const cm = pane.querySelector('.cm-content')
    cm.focus()
    document.execCommand('insertText', false, "UPDATE users SET age = 1 WHERE id = 1")
  })()`)
  await sleep(300)
  await evalJs(`(() => {
    const pane = document.querySelector('.n-tab-pane:not([style*="display: none"])')
    ;[...pane.querySelectorAll('button')].find(b => b.innerText.includes('运行'))?.click()
  })()`)
  check('只读拦截提示展示', await waitFor(`document.body.innerText.includes('只读模式,写操作已被阻止') || document.body.innerText.includes('当前连接为只读模式')`))

  console.log('== 收尾 ==')
  // 只关闭本测试打开的标签页,保留用户的标签页
  await evalJs(`(() => { const s = window.__store.getState(); const mine = ['审批查询','审计日志','只读查询']; s.tabs.filter(t => mine.includes(t.title)).forEach(t => s.closeTab(t.id)) })()`)
  for (const c of [conn, ro]) await evalJs(`window.api.deleteConnection(${JSON.stringify(c.id)})`)
  await unlink(conn.filePath).catch(() => {})
  await evalJs(`window.__store.getState().loadConnections()`)
  console.log(process.exitCode ? '== 存在失败项 ==' : '== 全部通过 ==')
  ws.close()
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => {
  console.error('测试脚本错误:', e)
  process.exit(1)
})
