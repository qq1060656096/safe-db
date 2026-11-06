/* MySQL 驱动集成测试：依赖 `npm run db:up` 启动的本地 MySQL（127.0.0.1:60001）。
 * 覆盖：多语句事务批量发送、取消/断开时 SSH 隧道先关闭导致的永久挂起回归。 */
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, 'node_modules/.cache')
mkdirSync(cache, { recursive: true })
const outfile = join(cache, `mysql-driver.${process.pid}.cjs`)
buildSync({
  stdin: {
    contents: `
      export { MysqlDriver, batchMysqlStatements } from './src/main/drivers/mysql'
      export { classifyDatabaseInput } from './src/main/core/nativeCommand'
    `,
    resolveDir: root, loader: 'ts'
  },
  outfile, bundle: true, format: 'cjs', platform: 'node', external: ['mysql2/promise'], logLevel: 'silent'
})
const require = createRequire(import.meta.url)
const { MysqlDriver, batchMysqlStatements, classifyDatabaseInput } = require(outfile)

const BASE = { host: '127.0.0.1', port: 60001, user: 'root', password: 'SafeDb_123456', database: 'safedb' }
const DB = `safedb_driver_test_${process.pid}`
const settle = (promise, ms) => Promise.race([
  promise.then(() => 'resolved', (error) => `rejected: ${error.message}`),
  new Promise((resolve) => setTimeout(() => resolve('HUNG'), ms))
])

/** 模拟 SSH 本地转发端口：kill() 会像 tunnels.close() 一样直接断开所有转发流。 */
function tunnel() {
  const sockets = new Set()
  const server = net.createServer((client) => {
    const upstream = net.connect(BASE.port, BASE.host)
    sockets.add(client).add(upstream)
    client.pipe(upstream).pipe(client)
    client.on('error', () => {})
    upstream.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    kill: () => { for (const socket of sockets) socket.destroy(); server.close() }
  })))
}

const statementsOf = (sql) => classifyDatabaseInput('mysql', sql).statements.map((item) => item.sql)

try {
  // 批次切分：按字节上限分组，单条超限语句单独成批。
  assert.deepEqual(batchMysqlStatements(['a', 'b', 'c'], 1024), [['a', 'b', 'c']])
  assert.deepEqual(batchMysqlStatements(['aaaa', 'bbbb', 'cc'], 8), [['aaaa'], ['bbbb'], ['cc']])
  assert.deepEqual(batchMysqlStatements([], 8), [])

  const admin = new MysqlDriver(BASE)
  await admin.connect()
  await admin.run(`CREATE DATABASE ${DB}`)
  try {
    const driver = new MysqlDriver({ ...BASE, database: DB })
    await driver.connect()
    await driver.runInTransaction(statementsOf('CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))'))

    // 一次往返执行多语句：结果与语句一一对应，`#` 行注释不会吞掉分隔符，
    // 用户变量、PREPARE/EXECUTE 与 DELIMITER 定义的过程体都按原语义执行。
    const script = [
      'SET @n := 2;',
      "INSERT INTO t VALUES (1, 'a') # trailing comment",
      ';',
      "INSERT INTO t SELECT @n, 'b' FROM DUAL WHERE @n = 2;",
      'SELECT COUNT(*) INTO @c FROM t;',
      "SET @q := IF(@c = 2, 'SELECT 1 AS ok', 'SELECT 0 AS ok');",
      'PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;',
      'DELIMITER $$',
      'CREATE PROCEDURE p() BEGIN SELECT COUNT(*) AS n FROM t; SELECT 7 AS seven; END$$',
      'DELIMITER ;',
      'CALL p();',
      'SELECT id, v FROM t ORDER BY id;'
    ].join('\n')
    const statements = statementsOf(script)
    const results = await driver.runInTransaction(statements)
    const rows = results.filter((item) => item.kind === 'rows')
    // 连接启用了 bigNumberStrings，BIGINT 结果（字面量、COUNT）以字符串返回。
    assert.equal(String(rows[0].rows[0].ok), '1')
    assert.deepEqual(rows.at(-1).rows, [{ id: 1, v: 'a' }, { id: 2, v: 'b' }])
    assert.ok(rows.some((item) => String(item.rows[0]?.n) === '2') && rows.some((item) => String(item.rows[0]?.seven) === '7'), 'CALL 返回的结果集')
    assert.ok(results.length >= statements.length, `结果数 ${results.length} 少于语句数 ${statements.length}`)

    // 批次中途出错时整体回滚，不残留前面语句的写入。
    await assert.rejects(driver.runInTransaction(statementsOf("INSERT INTO t VALUES (3, 'c'); INSERT INTO missing VALUES (1)")), /missing/)
    assert.equal(String((await driver.run('SELECT COUNT(*) AS n FROM t'))[0].rows[0].n), '2')
    await driver.disconnect()

    // 回归：取消/断开后隧道随即关闭，mysql2 不回调在途命令；驱动必须立即失败而不是永久挂起。
    for (const action of ['cancel', 'disconnect']) {
      for (const shape of ['run', 'transaction']) {
        const forward = await tunnel()
        const tunneled = new MysqlDriver({ ...BASE, database: DB, port: forward.port })
        await tunneled.connect()
        const running = shape === 'run'
          ? tunneled.run('SELECT SLEEP(3)')
          : tunneled.runInTransaction(['SELECT 1', 'SELECT SLEEP(3)', 'SELECT 2'])
        await new Promise((resolve) => setTimeout(resolve, 300))
        const closing = tunneled[action]()
        forward.kill()
        await settle(closing, 1000)
        const outcome = await settle(running, 2000)
        assert.match(outcome, /^rejected: /, `${action} + 隧道关闭后 ${shape} 应立即失败，实际 ${outcome}`)
      }
    }
  } finally {
    await admin.run(`DROP DATABASE IF EXISTS ${DB}`)
    await admin.disconnect()
  }
  console.log('✔ MySQL 驱动批量事务与中断测试通过')
} finally {
  rmSync(outfile, { force: true })
}
