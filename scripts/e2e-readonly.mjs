/* 端到端:加固后的分类器经真实权限管线 —— 只读拦截伪装的写、不误伤读;审批模式同样拦下 */
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
const DB = '/tmp/jjclassify.db'

async function main() {
  ws = new WebSocket(await getPageWs())
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) }
  }

  // 准备:全权限连接建测试库
  console.log('== 准备 ==')
  const full = await evalJs(`window.api.saveConnection({ id:'', name:'分类e2e-全', type:'sqlite', permissionMode:'full', filePath:'${DB}' })`)
  await evalJs(`window.api.connect(${JSON.stringify(full.id)})`)
  await evalJs(`window.api.executeSql(${JSON.stringify(full.id)}, 'DROP TABLE IF EXISTS users')`)
  await evalJs(`window.api.executeSql(${JSON.stringify(full.id)}, 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INT)')`)
  await evalJs(`window.api.executeSql(${JSON.stringify(full.id)}, "INSERT INTO users (name, age) VALUES ('a',1),('b',2),('c',3)")`)

  // 只读连接
  console.log('== 只读模式 ==')
  const ro = await evalJs(`window.api.saveConnection({ id:'', name:'分类e2e-只读', type:'sqlite', permissionMode:'readonly', filePath:'${DB}' })`)
  await evalJs(`window.api.connect(${JSON.stringify(ro.id)})`)
  const DENY = [
    ['块注释伪装 DELETE', '/* x */ DELETE FROM users'],
    ['行注释伪装 DELETE', '-- x\nDELETE FROM users'],
    ['括号包裹 DELETE', '((DELETE FROM users))'],
    ['数据修改 CTE', 'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x'],
    ['EXPLAIN ANALYZE 真执行', 'EXPLAIN ANALYZE DELETE FROM users'],
    ['VACUUM 失败即收紧', 'VACUUM'],
    ['PRAGMA 失败即收紧', 'PRAGMA user_version = 1']
  ]
  for (const [name, sql] of DENY) {
    const r = await evalJs(`window.api.executeSql(${JSON.stringify(ro.id)}, ${JSON.stringify(sql)})`)
    check(`只读拦截:${name}`, r?.status === 'denied', r)
  }
  const ALLOW = [
    ['普通 SELECT', 'SELECT * FROM users'],
    ['字符串含 delete', "SELECT 'delete' AS x"],
    ['IN 非 INTO', 'SELECT COUNT(*) AS n FROM users WHERE age IN (SELECT 1)']
  ]
  for (const [name, sql] of ALLOW) {
    const r = await evalJs(`window.api.executeSql(${JSON.stringify(ro.id)}, ${JSON.stringify(sql)})`)
    check(`只读放行:${name}`, r?.status === 'ok', r)
  }
  const cnt = await evalJs(`window.api.executeSql(${JSON.stringify(ro.id)}, 'SELECT COUNT(*) AS n FROM users')`)
  check('拦截后数据完好(3 行)', cnt?.results?.[0]?.rows?.[0]?.n === 3, cnt)

  // 审批模式:伪装的写也应进入审批,而不是静默放行
  console.log('== 审批模式 ==')
  const ap = await evalJs(`window.api.saveConnection({ id:'', name:'分类e2e-审批', type:'sqlite', permissionMode:'approval', filePath:'${DB}' })`)
  await evalJs(`window.api.connect(${JSON.stringify(ap.id)})`)
  const ar = await evalJs(`window.api.executeSql(${JSON.stringify(ap.id)}, '/* x */ DELETE FROM users')`)
  check('审批拦截伪装写(needsApproval)', ar?.status === 'needsApproval' && !!ar?.approvalToken, ar)
  if (ar?.approvalToken) await evalJs(`window.api.rejectExecute(${JSON.stringify(ar.approvalToken)})`)
  const arRead = await evalJs(`window.api.executeSql(${JSON.stringify(ap.id)}, 'SELECT * FROM users')`)
  check('审批放行读', arRead?.status === 'ok', arRead)

  console.log('== 清理 ==')
  for (const c of [full, ro, ap]) await evalJs(`window.api.deleteConnection(${JSON.stringify(c.id)})`)
  console.log(process.exitCode ? '== 存在失败项 ==' : '== 全部通过 ==')
  ws.close()
  process.exit(process.exitCode ?? 0)
}
main().catch((e) => { console.error('测试脚本错误:', e); process.exit(1) })
