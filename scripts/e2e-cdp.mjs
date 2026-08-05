/* 通过 CDP 驱动运行中的 Electron 应用,端到端验证主进程链路 */
const TARGET_URL = 'http://localhost:5173/'

async function getPageWsUrl() {
  const res = await fetch('http://localhost:9222/json/list')
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith(TARGET_URL))
  if (!page) throw new Error('找不到渲染进程页面')
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
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.exceptionDetails) {
    throw new Error('页面内执行出错: ' + JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text))
  }
  return res.result?.value
}

function check(name, cond, detail) {
  if (cond) console.log(`  ✔ ${name}`)
  else {
    console.log(`  ✘ ${name} ${detail ? JSON.stringify(detail) : ''}`)
    process.exitCode = 1
  }
}

async function main() {
  const wsUrl = await getPageWsUrl()
  ws = new WebSocket(wsUrl)
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

  // 等待应用就绪
  for (let i = 0; i < 30; i++) {
    const ready = await evalJs('typeof window.api !== "undefined"').catch(() => false)
    if (ready) break
    await new Promise((r) => setTimeout(r, 500))
  }

  console.log('== 1. 连接管理 ==')
  // 只清理本测试创建的连接(按名字前缀匹配),绝不动用户自己的连接
  await evalJs('window.api.listConnections()').then(async (conns) => {
    for (const c of conns) {
      if (String(c.name).startsWith('测试-')) await evalJs(`window.api.deleteConnection(${JSON.stringify(c.id)})`)
    }
  })
  const mk = (name, mode) =>
    `window.api.saveConnection({ id: '', name: ${JSON.stringify(name)}, type: 'sqlite', permissionMode: '${mode}', filePath: '/tmp/jjtest.db' })`
  const ro = await evalJs(mk('测试-只读', 'readonly'))
  const ap = await evalJs(mk('测试-审批', 'approval'))
  const fu = await evalJs(mk('测试-完全', 'full'))
  check('保存三个连接', ro?.id && ap?.id && fu?.id, { ro, ap, fu })
  const listed = await evalJs('window.api.listConnections()')
  check('列表不泄露密码', listed.every((c) => !('password' in c)), listed)
  const testRes = await evalJs(
    `window.api.testConnection({ id: '', name: 't', type: 'sqlite', permissionMode: 'readonly', filePath: '/tmp/jjtest.db' })`
  )
  check('测试连接 ok', testRes?.ok === true, testRes)

  console.log('== 2. 连接与浏览 ==')
  const connRes = await evalJs(`window.api.connect(${JSON.stringify(ro.id)})`)
  check('连接成功', connRes?.ok === true, connRes)
  const dbs = await evalJs(`window.api.listDatabases(${JSON.stringify(ro.id)})`)
  check('数据库列表含 main', Array.isArray(dbs) && dbs.includes('main'), dbs)
  const tables = await evalJs(`window.api.listTables(${JSON.stringify(ro.id)}, 'main')`)
  const names = tables?.map((t) => `${t.name}:${t.type}`)
  check('表/视图齐全', names?.includes('users:table') && names?.includes('orders:table') && names?.includes('v_user_orders:view'), names)
  const cols = await evalJs(`window.api.listColumns(${JSON.stringify(ro.id)}, 'main', 'users')`)
  check('users 主键为 id', cols?.find((c) => c.name === 'id')?.isPrimaryKey === true, cols)
  const data = await evalJs(
    `window.api.getTableData(${JSON.stringify(ro.id)}, { database: 'main', table: 'users', page: 1, pageSize: 2 })`
  )
  check('分页取数 page=1 size=2 → 2 行/总 3', data?.rows?.length === 2 && data?.total === 3, data)
  check('可编辑且定位键为 id', data?.editable === true && data?.keyColumns?.[0] === 'id', data?.keyColumns)

  console.log('== 3. 只读模式 ==')
  const sel = await evalJs(`window.api.executeSql(${JSON.stringify(ro.id)}, 'SELECT * FROM users ORDER BY id')`)
  check('SELECT 放行且 3 行', sel?.status === 'ok' && sel?.results?.[0]?.rows?.length === 3, sel)
  const upd = await evalJs(`window.api.executeSql(${JSON.stringify(ro.id)}, "UPDATE users SET age = 99 WHERE id = 1")`)
  check('UPDATE 被拦截(denied)', upd?.status === 'denied' && upd?.sqlKind === 'WRITE', upd)
  const ddl = await evalJs(`window.api.executeSql(${JSON.stringify(ro.id)}, 'CREATE TABLE t1 (id INTEGER)')`)
  check('DDL 被拦截(denied)', ddl?.status === 'denied' && ddl?.sqlKind === 'DDL', ddl)
  const afterDeny = await evalJs(`window.api.executeSql(${JSON.stringify(ro.id)}, 'SELECT age FROM users WHERE id = 1')`)
  check('拦截后数据未被修改', afterDeny?.results?.[0]?.rows?.[0]?.age === 28, afterDeny)

  console.log('== 4. 审批模式 ==')
  await evalJs(`window.api.connect(${JSON.stringify(ap.id)})`)
  const needAp = await evalJs(`window.api.executeSql(${JSON.stringify(ap.id)}, "UPDATE users SET age = 99 WHERE id = 1")`)
  check('UPDATE 返回 needsApproval + token', needAp?.status === 'needsApproval' && !!needAp?.approvalToken, needAp)
  const confirmed = await evalJs(`window.api.confirmExecute(${JSON.stringify(needAp.approvalToken)})`)
  check('确认后执行成功,影响 1 行', confirmed?.status === 'ok' && confirmed?.results?.[0]?.affectedRows === 1, confirmed)
  const reuse = await evalJs(`window.api.confirmExecute(${JSON.stringify(needAp.approvalToken)})`)
  check('token 一次性,复用报错', reuse?.status === 'error', reuse)
  const rej = await evalJs(`window.api.executeSql(${JSON.stringify(ap.id)}, "DELETE FROM users WHERE id = 2")`)
  await evalJs(`window.api.rejectExecute(${JSON.stringify(rej.approvalToken)})`)
  const afterRej = await evalJs(`window.api.executeSql(${JSON.stringify(ap.id)}, 'SELECT COUNT(*) AS n FROM users')`)
  check('取消审批后数据未删(仍 3 行)', afterRej?.results?.[0]?.rows?.[0]?.n === 3, afterRej)
  const selAp = await evalJs(`window.api.executeSql(${JSON.stringify(ap.id)}, 'SELECT 1')`)
  check('审批模式下 SELECT 直接放行', selAp?.status === 'ok', selAp)

  console.log('== 5. 完全访问模式 ==')
  await evalJs(`window.api.connect(${JSON.stringify(fu.id)})`)
  const ins = await evalJs(`window.api.executeSql(${JSON.stringify(fu.id)}, "INSERT INTO users (name, age) VALUES ('赵六', 40)")`)
  check('INSERT 直接执行', ins?.status === 'ok' && ins?.results?.[0]?.affectedRows === 1, ins)
  const multi = await evalJs(
    `window.api.executeSql(${JSON.stringify(fu.id)}, "UPDATE users SET age = age + 1 WHERE id = 3; INSERT INTO orders (user_id, amount) VALUES (3, 77.0)")`
  )
  check('多语句写事务执行', multi?.status === 'ok' && multi?.results?.length === 2, multi)
  const bad = await evalJs(`window.api.executeSql(${JSON.stringify(fu.id)}, 'UPDAT users SET age = 1')`)
  check('错误 SQL 返回 error', bad?.status === 'error' && !!bad?.error, bad)

  console.log('== 6. 审计日志 ==')
  const audit = await evalJs(`window.api.queryAudit({ page: 1, pageSize: 50 })`)
  const rows = audit?.rows ?? []
  const has = (f) => rows.some(f)
  check('审计记录了被拦截的只读写操作', has((r) => r.status === 'blocked' && r.permissionMode === 'readonly' && r.sqlKind === 'WRITE'))
  check('审计记录了审批通过(approved)', has((r) => r.approvalStatus === 'approved' && r.status === 'success'))
  check('审计记录了审批拒绝(rejected)', has((r) => r.approvalStatus === 'rejected'))
  check('审计记录了完全访问(not_required)', has((r) => r.permissionMode === 'full' && r.approvalStatus === 'not_required' && r.sqlText.includes('INSERT')))
  check('审计记录了失败 SQL(error)', has((r) => r.status === 'error'))
  check('记录了影响行数', has((r) => r.affectedRows === 1 && r.sqlText.includes('age = 99')))
  const auditFiltered = await evalJs(
    `window.api.queryAudit({ page: 1, pageSize: 50, connectionId: ${JSON.stringify(ro.id)} })`
  )
  check('按连接过滤审计', auditFiltered?.rows?.every((r) => r.connectionId === ro.id) && auditFiltered.rows.length > 0)

  console.log('== 清理:删除测试连接 ==')
  for (const id of [ro.id, ap.id, fu.id]) await evalJs(`window.api.deleteConnection(${JSON.stringify(id)})`)
  console.log(process.exitCode ? '== 存在失败项 ==' : '== 全部通过 ==')
  ws.close()
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => {
  console.error('测试脚本错误:', e)
  process.exit(1)
})
