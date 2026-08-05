/* 端到端:本批 5 项功能 —— 网格筛选 / PG 跨库 / 表操作(清空、删除)/ 导出内容生成 / 断开重连。
   三方言(MySQL/PG/SQLite)真实库验证,筛选断言注入安全。 */
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
  else { console.log(`  ✘ ${name} ${detail !== undefined ? JSON.stringify(detail)?.slice(0, 400) : ''}`); process.exitCode = 1 }
}

const MYSQL = { host: '127.0.0.1', port: 23306, user: 'root', password: 'jjtest123', database: 'jjdemo' }
const PG = { host: '127.0.0.1', port: 15432, user: 'postgres', password: 'jjtest123', database: 'jjdemo' }
const SQLITE_FILE = '/tmp/jjfeat.db'

// 已知数据的筛选测试表
const SEED = [
  { id: 1, name: 'alice', age: 30, note: 'x' },
  { id: 2, name: 'bob', age: 25, note: null },
  { id: 3, name: 'Carol', age: 35, note: 'y' },
  { id: 4, name: 'dave', age: 40, note: null }
]

async function main() {
  ws = new WebSocket(await getPageWs())
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) }
  }

  const J = JSON.stringify
  // 建三个全权限连接
  console.log('== 建立连接 ==')
  const my = await evalJs(`window.api.saveConnection({ id:'', name:'feat-mysql', type:'mysql', permissionMode:'full', host:${J(MYSQL.host)}, port:${MYSQL.port}, user:${J(MYSQL.user)}, password:${J(MYSQL.password)}, database:${J(MYSQL.database)} })`)
  const pg = await evalJs(`window.api.saveConnection({ id:'', name:'feat-pg', type:'postgres', permissionMode:'full', host:${J(PG.host)}, port:${PG.port}, user:${J(PG.user)}, password:${J(PG.password)}, database:${J(PG.database)} })`)
  const lite = await evalJs(`window.api.saveConnection({ id:'', name:'feat-sqlite', type:'sqlite', permissionMode:'full', filePath:${J(SQLITE_FILE)} })`)
  check('mysql 连接', (await evalJs(`window.api.connect(${J(my.id)})`))?.ok === true)
  check('pg 连接', (await evalJs(`window.api.connect(${J(pg.id)})`))?.ok === true)
  check('sqlite 连接', (await evalJs(`window.api.connect(${J(lite.id)})`))?.ok === true)

  // 准备 feat_filter 表(三方言)
  console.log('== 准备筛选测试表 ==')
  const seedValues = SEED.map((r) => `(${r.id},'${r.name}',${r.age},${r.note === null ? 'NULL' : `'${r.note}'`})`).join(',')
  for (const [label, id, dbArg] of [['mysql', my.id, MYSQL.database], ['pg', pg.id, PG.database], ['sqlite', lite.id, undefined]]) {
    await evalJs(`window.api.executeSql(${J(id)}, 'DROP TABLE IF EXISTS feat_filter', ${J(dbArg)})`)
    await evalJs(`window.api.executeSql(${J(id)}, 'CREATE TABLE feat_filter (id INTEGER PRIMARY KEY, name VARCHAR(50), age INTEGER, note VARCHAR(50))', ${J(dbArg)})`)
    const insSql = `INSERT INTO feat_filter (id,name,age,note) VALUES ${seedValues}`
    const ins = await evalJs(`window.api.executeSql(${J(id)}, ${J(insSql)}, ${J(dbArg)})`)
    check(`${label} 种子数据`, ins?.status === 'ok', ins)
  }

  // ---- 1. 网格筛选(含 total、注入安全)----
  console.log('== 网格筛选 ==')
  const dialects = [
    ['mysql', my.id, { database: MYSQL.database }],
    ['pg', pg.id, { database: PG.database, schema: 'public' }],
    ['sqlite', lite.id, {}]
  ]
  const q = (id, extra, filters) =>
    `window.api.getTableData(${J(id)}, ${J({ table: 'feat_filter', page: 1, pageSize: 50, ...extra, filters })})`
  const filterCases = [
    ['等于(数值)', [{ column: 'age', op: '=', value: '30' }], 1],
    ['大于', [{ column: 'age', op: '>', value: '28' }], 3],
    ['包含(like)', [{ column: 'name', op: 'like', value: 'a' }], 3],
    ['IS NULL', [{ column: 'note', op: 'null' }], 2],
    ['IS NOT NULL', [{ column: 'note', op: 'notnull' }], 2],
    ['组合 AND', [{ column: 'age', op: '>', value: '28' }, { column: 'note', op: 'notnull' }], 2]
  ]
  for (const [label, id, extra] of dialects) {
    for (const [name, filters, want] of filterCases) {
      const r = await evalJs(q(id, extra, filters))
      check(`${label} 筛选:${name} 命中 ${want}`, r?.total === want && r?.rows?.length === want, { total: r?.total, got: r?.rows?.length })
    }
    // 注入尝试:值里带分号与 DROP,值走参数绑定应安全,表仍在
    const inj = await evalJs(q(id, extra, [{ column: 'name', op: '=', value: "x'; DROP TABLE feat_filter; --" }]))
    const still = await evalJs(q(id, extra, []))
    check(`${label} 注入安全(表未丢)`, inj?.total === 0 && still?.total === 4, { inj: inj?.total, still: still?.total })
  }

  // ---- 2. PG 跨库 ----
  console.log('== PG 跨库 ==')
  const dbs = await evalJs(`window.api.listDatabases(${J(pg.id)})`)
  check('listDatabases 含 postgres 与 jjdemo', Array.isArray(dbs) && dbs.includes('postgres') && dbs.includes('jjdemo'), dbs)
  await evalJs(`window.api.executeSql(${J(pg.id)}, 'CREATE TABLE IF NOT EXISTS feat_cross (id INTEGER)', 'postgres')`)
  await evalJs(`window.api.executeSql(${J(pg.id)}, 'DELETE FROM feat_cross', 'postgres')`)
  await evalJs(`window.api.executeSql(${J(pg.id)}, 'INSERT INTO feat_cross VALUES (1),(2)', 'postgres')`)
  // 连接默认库是 jjdemo,跨库读 postgres.feat_cross
  const cross = await evalJs(`window.api.getTableData(${J(pg.id)}, { database:'postgres', schema:'public', table:'feat_cross', page:1, pageSize:10 })`)
  check('跨库 getTableData 读 postgres.feat_cross', cross?.total === 2, cross)
  const crossRun = await evalJs(`window.api.executeSql(${J(pg.id)}, 'SELECT COUNT(*) AS n FROM feat_cross', 'postgres')`)
  check('跨库 executeSql(SELECT)', Number(crossRun?.results?.[0]?.rows?.[0]?.n) === 2, crossRun)
  await evalJs(`window.api.executeSql(${J(pg.id)}, 'DROP TABLE feat_cross', 'postgres')`)

  // ---- 3. 表操作:清空 / 删除(经权限管道)----
  console.log('== 表操作(清空/删除) ==')
  for (const [label, id, dbArg, schema] of [['mysql', my.id, MYSQL.database, undefined], ['pg', pg.id, PG.database, 'public'], ['sqlite', lite.id, undefined, undefined]]) {
    await evalJs(`window.api.executeSql(${J(id)}, 'DROP TABLE IF EXISTS feat_tmp', ${J(dbArg)})`)
    await evalJs(`window.api.executeSql(${J(id)}, 'CREATE TABLE feat_tmp (id INTEGER PRIMARY KEY, v INTEGER)', ${J(dbArg)})`)
    await evalJs(`window.api.executeSql(${J(id)}, 'INSERT INTO feat_tmp (id,v) VALUES (1,1),(2,2)', ${J(dbArg)})`)
    // 清空(mysql/pg 用 TRUNCATE,sqlite 用 DELETE —— 与侧边栏一致)
    const clearSql = label === 'sqlite' ? 'DELETE FROM feat_tmp' : 'TRUNCATE TABLE feat_tmp'
    const clr = await evalJs(`window.api.executeSql(${J(id)}, ${J(clearSql)}, ${J(dbArg)})`)
    const cntQ = schema ? `window.api.getTableData(${J(id)}, { database:${J(dbArg)}, schema:${J(schema)}, table:'feat_tmp', page:1, pageSize:10 })`
                        : (label === 'sqlite' ? `window.api.getTableData(${J(id)}, { table:'feat_tmp', page:1, pageSize:10 })`
                                            : `window.api.getTableData(${J(id)}, { database:${J(dbArg)}, table:'feat_tmp', page:1, pageSize:10 })`)
    const cnt = await evalJs(cntQ)
    check(`${label} 清空后 0 行`, clr?.status === 'ok' && cnt?.total === 0, { clr: clr?.status, total: cnt?.total })
    // 删除表
    const drp = await evalJs(`window.api.executeSql(${J(id)}, 'DROP TABLE feat_tmp', ${J(dbArg)})`)
    const tables = await evalJs(`window.api.listTables(${J(id)}, ${J(dbArg)})`)
    check(`${label} 删除表后列表无 feat_tmp`, drp?.status === 'ok' && !tables?.some((t) => t.name === 'feat_tmp'), { drp: drp?.status, tables: tables?.map((t) => t.name) })
  }

  // ---- 4. 导出内容生成(纯函数,动态 import 带缓存破坏)----
  console.log('== 导出内容生成 ==')
  const t = Date.now()
  const exp = await evalJs(`(async () => {
    const u = await import('/src/utils.ts?t=${t}')
    const cols = ['id','name','note']
    const rows = [
      { id:1, name:'a,b', note:'he said "hi"' },
      { id:2, name:'bob', note:null },
      { id:3, name:'multi\\nline', note:'z' }
    ]
    const csv = u.toCsv(cols, rows)
    const json = u.toJson(rows)
    const p = u.parseColumnFilter
    return {
      csv, json,
      f1: p('age', '>5', true),
      f2: p('name', 'ali', false),
      f3: p('note', 'null', false),
      f4: p('note', '!null', false),
      f5: p('age', '42', true),
      f6: p('name', '~x', false),
      f7: p('name', '  ', false)
    }
  })()`)
  check('CSV 转义逗号', exp?.csv?.includes('"a,b"'), exp?.csv)
  check('CSV 转义引号', exp?.csv?.includes('"he said ""hi"""'), exp?.csv)
  check('CSV NULL→空串', exp?.csv?.includes('2,bob,'), exp?.csv)
  check('CSV 换行被引号包裹', exp?.csv?.includes('"multi\nline"'), exp?.csv)
  check('CSV 带 BOM', exp?.csv?.charCodeAt(0) === 0xfeff, exp?.csv?.charCodeAt(0))
  check('JSON 为对象数组', Array.isArray(JSON.parse(exp?.json ?? '[]')) && JSON.parse(exp.json).length === 3, exp?.json)
  check('parse >', exp?.f1?.op === '>' && exp?.f1?.value === '5', exp?.f1)
  check('parse 文本默认 like', exp?.f2?.op === 'like' && exp?.f2?.value === 'ali', exp?.f2)
  check('parse null', exp?.f3?.op === 'null', exp?.f3)
  check('parse !null', exp?.f4?.op === 'notnull', exp?.f4)
  check('parse 数值默认 =', exp?.f5?.op === '=' && exp?.f5?.value === '42', exp?.f5)
  check('parse ~', exp?.f6?.op === 'like' && exp?.f6?.value === 'x', exp?.f6)
  check('parse 空白→null', exp?.f7 === null, exp?.f7)

  // ---- 5. 断开重连(连接生命周期)----
  console.log('== 断开重连 ==')
  await evalJs(`window.api.disconnect(${J(my.id)})`)
  const re = await evalJs(`window.api.connect(${J(my.id)})`)
  const reData = await evalJs(`window.api.getTableData(${J(my.id)}, { database:${J(MYSQL.database)}, table:'feat_filter', page:1, pageSize:5 })`)
  check('断开后重连可用', re?.ok === true && reData?.total === 4, { re, total: reData?.total })

  // ---- 清理 ----
  console.log('== 清理 ==')
  for (const [id, dbArg] of [[my.id, MYSQL.database], [pg.id, PG.database], [lite.id, undefined]]) {
    await evalJs(`window.api.executeSql(${J(id)}, 'DROP TABLE IF EXISTS feat_filter', ${J(dbArg)})`)
    await evalJs(`window.api.deleteConnection(${J(id)})`)
  }
  console.log(process.exitCode ? '== 存在失败项 ==' : '== 全部通过 ==')
  ws.close()
  process.exit(process.exitCode ?? 0)
}
main().catch((e) => { console.error('测试脚本错误:', e); process.exit(1) })
