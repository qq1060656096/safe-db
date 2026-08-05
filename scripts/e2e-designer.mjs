/* 表结构设计器:生成的 DDL 在三种真实数据库上执行验证(仅走 window.api,不触碰 UI) */
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

const TABLE = '__ddl_test__'

// 每种方言的建表列与一次 ALTER(加列 + 删列 + 重命名)的期望
const CASES = [
  {
    label: 'MySQL',
    cfg: { id: '', name: '设计器测试-mysql', type: 'mysql', permissionMode: 'full', host: '127.0.0.1', port: 23306, user: 'root', password: 'jjtest123', database: 'jjdemo' },
    dialect: 'mysql',
    schema: undefined,
    database: 'jjdemo',
    createCols: [
      { name: 'id', dataType: 'INT', nullable: false, isPrimaryKey: true, autoIncrement: true },
      { name: 'name', dataType: 'VARCHAR(50)', nullable: false, defaultValue: 'x', comment: '姓名' },
      { name: 'age', dataType: 'INT', nullable: true }
    ],
    drop: 'age',
    renameFrom: 'name',
    renameTo: 'full_name',
    add: { name: 'email', dataType: 'VARCHAR(100)', nullable: true },
    expectAfter: ['id', 'full_name', 'email']
  },
  {
    label: 'PostgreSQL',
    cfg: { id: '', name: '设计器测试-pg', type: 'postgres', permissionMode: 'full', host: '127.0.0.1', port: 15432, user: 'postgres', password: 'jjtest123', database: 'jjdemo' },
    dialect: 'postgres',
    schema: 'public',
    database: 'jjdemo',
    createCols: [
      { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true, autoIncrement: true },
      { name: 'name', dataType: 'varchar(50)', nullable: false, defaultValue: 'x' },
      { name: 'price', dataType: 'numeric(10,2)', nullable: true }
    ],
    drop: 'price',
    renameFrom: 'name',
    renameTo: 'full_name',
    add: { name: 'email', dataType: 'varchar(100)', nullable: true },
    expectAfter: ['id', 'full_name', 'email']
  },
  {
    label: 'SQLite',
    cfg: { id: '', name: '设计器测试-sqlite', type: 'sqlite', permissionMode: 'full', filePath: '/tmp/jjtest.db' },
    dialect: 'sqlite',
    schema: undefined,
    database: 'main',
    createCols: [
      { name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true, autoIncrement: true },
      { name: 'name', dataType: 'TEXT', nullable: false },
      { name: 'note', dataType: 'TEXT', nullable: true }
    ],
    drop: 'note',
    renameFrom: 'name',
    renameTo: 'full_name',
    add: { name: 'email', dataType: 'TEXT', nullable: true },
    expectAfter: ['id', 'full_name', 'email']
  }
]

async function runCase(M, c) {
  console.log(`== ${c.label} ==`)
  const conn = await evalJs(`window.api.saveConnection(${JSON.stringify(c.cfg)})`)
  try {
    await evalJs(`window.api.connect(${JSON.stringify(conn.id)})`)
    // 幂等:清掉上轮可能遗留的表
    await evalJs(`window.api.executeSql(${JSON.stringify(conn.id)}, 'DROP TABLE IF EXISTS ${TABLE}', ${JSON.stringify(c.database)})`)

    const col = (over) => ({
      key: over.key ?? over.name, name: '', dataType: '', nullable: true,
      isPrimaryKey: false, autoIncrement: false, defaultValue: '', comment: '', status: 'existing', ...over
    })
    const createDrafts = c.createCols.map((x) => col({ ...x, status: 'added' }))

    // 1. 建表
    const createSql = await M.buildCreateSql(c.dialect, c.schema, c.database, TABLE, createDrafts)
    const cr = await evalJs(`window.api.executeSql(${JSON.stringify(conn.id)}, ${JSON.stringify(createSql)}, ${JSON.stringify(c.database)})`)
    check('建表执行成功', cr?.status === 'ok', { sql: createSql, cr })
    const colsAfterCreate = await evalJs(`window.api.listColumns(${JSON.stringify(conn.id)}, ${JSON.stringify(c.database)}, ${JSON.stringify(TABLE)}, ${JSON.stringify(c.schema)})`)
    check('建表后列齐全', c.createCols.every((x) => colsAfterCreate?.some((k) => k.name === x.name)), colsAfterCreate?.map((k) => k.name))

    // 2. ALTER:删列 + 重命名 + 加列
    const orig = c.createCols.map((x) => col({ ...x, status: 'existing', origName: x.name }))
    const work = orig.map((x) =>
      x.name === c.drop ? { ...x, status: 'dropped' } : x.name === c.renameFrom ? { ...x, name: c.renameTo } : x
    )
    work.push(col({ ...c.add, key: 'added:' + c.add.name, status: 'added' }))
    const alterSql = await M.buildAlterSql(c.dialect, c.schema, c.database, TABLE, orig, work)
    const ar = await evalJs(`window.api.executeSql(${JSON.stringify(conn.id)}, ${JSON.stringify(alterSql)}, ${JSON.stringify(c.database)})`)
    check('ALTER 执行成功', ar?.status === 'ok', { sql: alterSql, ar })
    const finalCols = await evalJs(`window.api.listColumns(${JSON.stringify(conn.id)}, ${JSON.stringify(c.database)}, ${JSON.stringify(TABLE)}, ${JSON.stringify(c.schema)})`)
    const names = finalCols?.map((k) => k.name) ?? []
    check(
      'ALTER 后列正确(删/改名/加)',
      c.expectAfter.every((n) => names.includes(n)) && !names.includes(c.drop) && !names.includes(c.renameFrom),
      { names, sql: alterSql }
    )
  } finally {
    await evalJs(`window.api.executeSql(${JSON.stringify(conn.id)}, 'DROP TABLE IF EXISTS ${TABLE}', ${JSON.stringify(c.database)})`).catch(() => {})
    await evalJs(`window.api.deleteConnection(${JSON.stringify(conn.id)})`).catch(() => {})
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
  await evalJs('typeof window.api !== "undefined" ? 1 : (() => { throw new Error("no api") })()')
  for (const c of CASES) {
    // 模块函数无法跨 returnByValue 带回,驻留在 window.__ddlM 上调用
    await evalJs(`(async () => { window.__ddlM = await import('/src/components/StructureDesigner.tsx?t=' + ${JSON.stringify(Date.now().toString())}) })()`)
    const proxy = {
      buildCreateSql: (d, s, db, t, cols) =>
        evalJs(`window.__ddlM.buildCreateSql(${JSON.stringify(d)}, ${JSON.stringify(s)}, ${JSON.stringify(db)}, ${JSON.stringify(t)}, ${JSON.stringify(cols)})`),
      buildAlterSql: (d, s, db, t, orig, cols) =>
        evalJs(`window.__ddlM.buildAlterSql(${JSON.stringify(d)}, ${JSON.stringify(s)}, ${JSON.stringify(db)}, ${JSON.stringify(t)}, ${JSON.stringify(orig)}, ${JSON.stringify(cols)})`)
    }
    await runCase(proxy, c)
  }
  console.log(process.exitCode ? '== 存在失败项 ==' : '== 全部通过 ==')
  ws.close()
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => {
  console.error('测试脚本错误:', e)
  process.exit(1)
})
