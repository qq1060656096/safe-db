/* MySQL / PostgreSQL 驱动端到端验证(通过运行中应用的 IPC) */
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
      if (e.message === 'Promise was collected' && attempt < 2) {
        await new Promise((r) => setTimeout(r, 800))
        continue
      }
      throw e
    }
  }
}

function check(name, cond, detail) {
  if (cond) console.log(`  ✔ ${name}`)
  else {
    console.log(`  ✘ ${name} ${detail !== undefined ? JSON.stringify(detail)?.slice(0, 500) : ''}`)
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

  console.log('== MySQL 驱动 ==')
  const myCfg = {
    id: '', name: 'mysql测试', type: 'mysql', permissionMode: 'full',
    host: '127.0.0.1', port: 23306, user: 'root', password: 'jjtest123', database: 'jjdemo'
  }
  const myTest = await evalJs(`window.api.testConnection(${JSON.stringify(myCfg)})`)
  check('测试连接', myTest?.ok === true, myTest)
  const my = await evalJs(`window.api.saveConnection(${JSON.stringify(myCfg)})`)
  const myConn = await evalJs(`window.api.connect(${JSON.stringify(my.id)})`)
  check('连接', myConn?.ok === true, myConn)
  // 幂等:清掉上轮测试遗留数据
  await evalJs(`window.api.executeSql(${JSON.stringify(my.id)}, "DELETE FROM users WHERE name = '赵六'", 'jjdemo')`)
  const myDbs = await evalJs(`window.api.listDatabases(${JSON.stringify(my.id)})`)
  check('数据库列表含 jjdemo', myDbs?.includes('jjdemo'), myDbs)
  const myTables = await evalJs(`window.api.listTables(${JSON.stringify(my.id)}, 'jjdemo')`)
  const myNames = myTables?.map((t) => `${t.name}:${t.type}`)
  check('表/视图齐全', myNames?.includes('users:table') && myNames?.includes('orders:table') && myNames?.includes('v_user_orders:view'), myNames)
  const myCols = await evalJs(`window.api.listColumns(${JSON.stringify(my.id)}, 'jjdemo', 'users')`)
  check('id 主键 + auto_increment', myCols?.find((c) => c.name === 'id')?.isPrimaryKey === true && /auto_increment/.test(myCols?.find((c) => c.name === 'id')?.extra ?? ''), myCols)
  const myIdx = await evalJs(`window.api.listIndexes(${JSON.stringify(my.id)}, 'jjdemo', 'users')`)
  check('PRIMARY 索引', myIdx?.some((i) => i.primary && i.columns.includes('id')), myIdx)
  const myData = await evalJs(`window.api.getTableData(${JSON.stringify(my.id)}, { database: 'jjdemo', table: 'users', page: 1, pageSize: 2 })`)
  check('分页 2/3 行,可编辑', myData?.rows?.length === 2 && myData?.total === 3 && myData?.editable === true, myData)
  const mySel = await evalJs(`window.api.executeSql(${JSON.stringify(my.id)}, "SELECT name FROM jjdemo.users WHERE id = 1")`)
  check('SELECT 中文', mySel?.results?.[0]?.rows?.[0]?.name === '张三', mySel)
  const myWrite = await evalJs(`window.api.executeSql(${JSON.stringify(my.id)}, "INSERT INTO users (name, age) VALUES ('赵六', 40); UPDATE users SET age = 41 WHERE name = '赵六'", 'jjdemo')`)
  check('多语句写事务(2 个结果)', myWrite?.status === 'ok' && myWrite?.results?.length === 2, myWrite)
  const myView = await evalJs(`window.api.getTableData(${JSON.stringify(my.id)}, { database: 'jjdemo', table: 'v_user_orders', page: 1, pageSize: 10 })`)
  check('视图只读', myView?.editable === false && myView?.rows?.length >= 2, myView)
  // USE 切换:不带默认库的连接
  const myCfg2 = { ...myCfg, name: 'mysql测试-无默认库', database: '' }
  const my2 = await evalJs(`window.api.saveConnection(${JSON.stringify(myCfg2)})`)
  await evalJs(`window.api.connect(${JSON.stringify(my2.id)})`)
  const useRes = await evalJs(`window.api.executeSql(${JSON.stringify(my2.id)}, 'SELECT COUNT(*) AS n FROM users', 'jjdemo')`)
  check('database 参数切换库', useRes?.status === 'ok' && Number(useRes?.results?.[0]?.rows?.[0]?.n) >= 3, useRes)

  console.log('== PostgreSQL 驱动 ==')
  const pgCfg = {
    id: '', name: 'pg测试', type: 'postgres', permissionMode: 'full',
    host: '127.0.0.1', port: 15432, user: 'postgres', password: 'jjtest123', database: 'jjdemo'
  }
  const pgTest = await evalJs(`window.api.testConnection(${JSON.stringify(pgCfg)})`)
  check('测试连接', pgTest?.ok === true, pgTest)
  const pg = await evalJs(`window.api.saveConnection(${JSON.stringify(pgCfg)})`)
  const pgConn = await evalJs(`window.api.connect(${JSON.stringify(pg.id)})`)
  check('连接', pgConn?.ok === true, pgConn)
  // 幂等:清掉上轮测试遗留数据
  await evalJs(`window.api.executeSql(${JSON.stringify(pg.id)}, "DELETE FROM public.users WHERE name = '赵六'")`)
  const pgDbs = await evalJs(`window.api.listDatabases(${JSON.stringify(pg.id)})`)
  check('数据库列表含 jjdemo', pgDbs?.includes('jjdemo'), pgDbs)
  const pgTables = await evalJs(`window.api.listTables(${JSON.stringify(pg.id)})`)
  const pgHas = (schema, name, type) => pgTables?.some((t) => t.schema === schema && t.name === name && t.type === type)
  check('public.users / app.products / 视图', pgHas('public', 'users', 'table') && pgHas('app', 'products', 'table') && pgHas('public', 'v_user_orders', 'view'), pgTables)
  const pgCols = await evalJs(`window.api.listColumns(${JSON.stringify(pg.id)}, undefined, 'users', 'public')`)
  check('id 主键 + serial 默认值', pgCols?.find((c) => c.name === 'id')?.isPrimaryKey === true && /nextval/.test(pgCols?.find((c) => c.name === 'id')?.defaultValue ?? ''), pgCols)
  const pgIdx = await evalJs(`window.api.listIndexes(${JSON.stringify(pg.id)}, undefined, 'users', 'public')`)
  check('主键索引', pgIdx?.some((i) => i.primary && i.columns.includes('id')), pgIdx)
  const pgData = await evalJs(`window.api.getTableData(${JSON.stringify(pg.id)}, { schema: 'public', table: 'users', page: 1, pageSize: 2 })`)
  check('分页 2/3 行,可编辑', pgData?.rows?.length === 2 && pgData?.total === 3 && pgData?.editable === true, pgData)
  const pgAppData = await evalJs(`window.api.getTableData(${JSON.stringify(pg.id)}, { schema: 'app', table: 'products', page: 1, pageSize: 10 })`)
  check('schema 表读取(键盘)', pgAppData?.rows?.some((r) => r.title === '键盘'), pgAppData)
  check('布尔值读取', pgAppData?.rows?.[0]?.active === true, pgAppData?.rows?.[0])
  const pgSel = await evalJs(`window.api.executeSql(${JSON.stringify(pg.id)}, "SELECT name FROM public.users WHERE id = 1")`)
  check('SELECT 中文', pgSel?.results?.[0]?.rows?.[0]?.name === '张三', pgSel)
  const pgWrite = await evalJs(`window.api.executeSql(${JSON.stringify(pg.id)}, "INSERT INTO public.users (name, age) VALUES ('赵六', 40); UPDATE public.users SET age = 41 WHERE name = '赵六'")`)
  check('多语句写事务', pgWrite?.status === 'ok' && pgWrite?.results?.length === 2, pgWrite)
  const pgView = await evalJs(`window.api.getTableData(${JSON.stringify(pg.id)}, { schema: 'public', table: 'v_user_orders', page: 1, pageSize: 10 })`)
  check('视图只读', pgView?.editable === false, pgView)
  const pgErr = await evalJs(`window.api.executeSql(${JSON.stringify(pg.id)}, 'SELECT * FROM 不存在的表')`)
  check('错误回传', pgErr?.status === 'error' && !!pgErr?.error, pgErr)

  console.log('== 清理 ==')
  for (const id of [my.id, my2.id, pg.id]) await evalJs(`window.api.deleteConnection(${JSON.stringify(id)})`)
  console.log(process.exitCode ? '== 存在失败项 ==' : '== 全部通过 ==')
  ws.close()
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => {
  console.error('测试脚本错误:', e)
  process.exit(1)
})
