import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, 'node_modules/.cache')
mkdirSync(cache, { recursive: true })
const outfile = join(cache, `database-drop.${process.pid}.cjs`)
buildSync({
  stdin: {
    contents: `
      export { Executor } from './src/main/core/executor'
      export { assertDatabaseOperation, operationSupports } from './src/main/core/databaseOperation'
      export { compileRelationalOperation } from './src/main/drivers/relationalOperation'
      export { capabilitiesForType } from './src/main/drivers/capabilities'
      export { MysqlDriver } from './src/main/drivers/mysql'
      export { PostgresDriver } from './src/main/drivers/postgres'
      export { SqlServerDriver } from './src/main/drivers/sqlserver'
      export { MongoDriver } from './src/main/drivers/mongodb'
    `,
    resolveDir: root, loader: 'ts'
  },
  outfile, bundle: true, format: 'cjs', platform: 'node',
  external: ['mongodb', 'mssql', 'mysql2/promise', 'pg'], logLevel: 'silent'
})
const require = createRequire(import.meta.url)
try {
  const { Executor, assertDatabaseOperation, operationSupports, compileRelationalOperation, capabilitiesForType, MysqlDriver, PostgresDriver, SqlServerDriver, MongoDriver } = require(outfile)
  const operation = { kind: 'database.drop', database: 'app' }
  for (const database of ['', ' ', 'app\0', undefined]) assert.throws(() => assertDatabaseOperation({ ...operation, database }), /无效|不支持的值/)
  for (const type of ['mysql', 'postgres', 'sqlserver', 'mongodb']) assert.equal(operationSupports(capabilitiesForType(type), operation)[0].supported, true)
  for (const type of ['sqlite', 'redis', 'qdrant']) assert.equal(operationSupports(capabilitiesForType(type), operation)[0].supported, false)
  const escaped = {
    mysql: ['db`; DROP TABLE users; --', 'DROP DATABASE `db``; DROP TABLE users; --`'],
    postgres: ['db"; DROP TABLE users; --', 'DROP DATABASE "db""; DROP TABLE users; --"'],
    sqlserver: ['db]; DROP TABLE users; --', 'DROP DATABASE [db]]; DROP TABLE users; --]']
  }
  for (const [type, [database, expected]] of Object.entries(escaped)) {
    assert.deepEqual(compileRelationalOperation({ ...operation, database }, type), [{ sql: expected, params: [] }])
  }
  for (const [type, database] of [['mysql', 'mysql'], ['postgres', 'template1'], ['sqlserver', 'MASTER']]) {
    assert.throws(() => compileRelationalOperation({ ...operation, database }, type), /系统数据库/)
  }

  const mysqlCalls = []
  const mysql = new MysqlDriver({ host: 'localhost', port: 3306, user: 'root', database: 'app' })
  mysql.conn = {
    execute: async (sql) => { mysqlCalls.push(sql); return [{ affectedRows: 0 }] },
    beginTransaction: async () => { throw new Error('DROP DATABASE must not start a transaction') }
  }
  assert.equal((await mysql.executeOperation(operation)).atomicity, 'single-request')
  assert.deepEqual(mysqlCalls, ['DROP DATABASE `app`'])

  const pgCalls = []
  const postgres = new PostgresDriver({ host: 'localhost', port: 5432, user: 'postgres', database: 'app' })
  postgres.clients.set('app', { end: async () => { pgCalls.push('close app') } })
  postgres.clientFor = async (database) => {
    pgCalls.push(`connect ${database}`)
    return { query: async (sql) => { pgCalls.push(sql); return { rowCount: 0 } } }
  }
  assert.equal((await postgres.executeOperation(operation)).atomicity, 'single-request')
  assert.deepEqual(pgCalls, ['connect postgres', 'close app', 'DROP DATABASE "app"'])
  assert.equal(postgres.clients.has('app'), false)
  assert.equal(postgres.cfg.database, undefined)

  const sqlServerCalls = []
  const sqlserver = new SqlServerDriver({ host: 'localhost', port: 1433, user: 'sa', database: 'app' })
  sqlserver.pools.set('APP', { close: async () => { sqlServerCalls.push('close app') } })
  sqlserver.poolFor = async (database) => {
    sqlServerCalls.push(`connect ${database}`)
    return { request: () => ({ query: async (sql) => { sqlServerCalls.push(sql); return { rowsAffected: [] } } }) }
  }
  assert.equal((await sqlserver.executeOperation(operation)).atomicity, 'single-request')
  assert.deepEqual(sqlServerCalls, ['connect master', 'close app', 'DROP DATABASE [app]'])
  assert.equal(sqlserver.pools.has('APP'), false)

  const mongoCalls = []
  const mongo = new MongoDriver({ host: 'localhost', port: 27017, database: 'other' })
  mongo.client = { db: (database) => ({ dropDatabase: async () => { mongoCalls.push(database); return true } }) }
  assert.equal((await mongo.executeOperation(operation)).atomicity, 'single-request')
  assert.deepEqual(mongoCalls, ['app'])
  await assert.rejects(mongo.executeOperation({ ...operation, database: 'admin' }), /系统数据库/)

  const configs = Object.fromEntries(['readonly', 'approval', 'full', 'failed', 'mongo', 'sqlserver'].map((id) => [id, {
    id, name: id, type: id === 'mongo' ? 'mongodb' : id === 'sqlserver' ? 'sqlserver' : 'postgres',
    permissionMode: ['readonly', 'approval'].includes(id) ? id : 'full', database: id === 'sqlserver' ? 'APP' : 'app', user: 'tester', password: 'secret'
  }]))
  configs.redis = { id: 'redis', name: 'redis', type: 'redis', permissionMode: 'full', database: '0' }
  const executed = []
  const saved = []
  const invalidated = []
  const logs = []
  const approvals = []
  const metadata = []
  const executor = new Executor({
    get: (id) => configs[id],
    save: (config) => { saved.push(config); configs[config.id] = config }
  }, {
    capabilities: (id) => capabilitiesForType(configs[id].type),
    get: async (id) => ({
      capabilities: capabilitiesForType(configs[id].type),
      executeOperation: async (input) => {
        if (id === 'failed') throw new Error('database is in use')
        executed.push({ id, input })
        return { results: [{ kind: 'exec', affectedRows: 1 }], atomicity: 'single-request', succeeded: 1, failed: 0 }
      }
    }),
    invalidate: async (id) => { invalidated.push(id) }
  }, { insert: (log) => logs.push(log), recordApproval: (log) => approvals.push(log) })
  executor.onMetadataChanged((id, database) => metadata.push({ id, database }))
  assert.equal((await executor.executeOperation('readonly', operation)).status, 'denied')
  assert.equal((await executor.executeOperation('redis', operation)).status, 'error')
  assert.equal((await executor.executeOperation('full', { ...operation, database: 'postgres' })).status, 'error')
  assert.equal(executed.length, 0)
  const pending = await executor.executeOperation('approval', operation)
  assert.equal(pending.status, 'needsApproval')
  assert.match(pending.preview, /DROP DATABASE "app";/)
  assert.equal(executed.length, 0)
  await executor.rejectExecute(pending.approvalToken)
  assert.equal(executed.length, 0)
  const accepted = await executor.executeOperation('approval', operation)
  assert.equal((await executor.confirmExecute(accepted.approvalToken)).status, 'ok')
  assert.equal((await executor.confirmExecute(accepted.approvalToken)).status, 'error', '审批 Token 只能执行一次')
  assert.equal((await executor.executeOperation('full', operation)).status, 'ok')
  assert.equal(configs.full.database, undefined)
  assert.equal(configs.full.password, 'secret')
  assert.ok(invalidated.includes('full'))
  assert.ok(metadata.some((event) => event.id === 'full' && event.database === 'app'))
  assert.equal((await executor.executeOperation('failed', operation)).status, 'error')
  assert.equal(configs.failed.database, 'app')
  assert.ok(!invalidated.includes('failed'))
  assert.ok(!metadata.some((event) => event.id === 'failed'))
  assert.equal((await executor.executeOperation('mongo', operation)).status, 'ok')
  assert.equal(configs.mongo.authDatabase, 'app', '删除默认库时保留认证来源')
  assert.equal((await executor.executeOperation('sqlserver', operation)).status, 'ok')
  assert.equal(configs.sqlserver.database, undefined, 'SQL Server 默认库按大小写不敏感比较')
  assert.ok(logs.some((log) => log.connectionId === 'readonly' && log.status === 'blocked'))
  assert.ok(logs.some((log) => log.connectionId === 'approval' && log.status === 'success' && log.approvalStatus === 'approved'))
  assert.ok(logs.some((log) => log.connectionId === 'failed' && log.status === 'error'))
  assert.ok(approvals.some((log) => log.action === 'rejected'))
  console.log('删除数据库测试通过：四类驱动、系统库保护、标识符转义、独立会话、只读/审批/审计与连接状态恢复。')
} finally {
  rmSync(outfile, { force: true })
}
