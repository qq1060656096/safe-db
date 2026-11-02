/* 双日志与加密执行明细契约。 */
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'safe-db-audit-'))
const cache = join(root, 'node_modules', '.cache')
const bundle = join(cache, `audit-store.${process.pid}.cjs`)
const databasePath = join(temp, 'audit.db')
mkdirSync(cache, { recursive: true })

const legacy = new Database(databasePath)
legacy.exec(`
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    connection_name TEXT NOT NULL,
    database_name TEXT,
    sql_text TEXT NOT NULL,
    sql_kind TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    approval_status TEXT NOT NULL,
    status TEXT NOT NULL,
    affected_rows INTEGER,
    error TEXT,
    duration_ms INTEGER NOT NULL,
    executed_at TEXT NOT NULL
  )
`)
legacy.prepare(`
  INSERT INTO audit_log (
    connection_id, connection_name, database_name, sql_text, sql_kind,
    permission_mode, approval_status, status, duration_ms, executed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('conn-1', '本地库', 'main', 'SELECT 1', 'READ', 'full', 'not_required', 'success', 2, '2026-08-21T00:00:00.000Z')
legacy.close()

buildSync({
  stdin: {
    contents: `
      export { AuditStore } from './src/main/store/audit'
      export { configureExecutionTraceRecorder, runWithOperationContext, traceExecution } from './src/main/audit/trace'
      export { SqliteDriver } from './src/main/drivers/sqlite'
    `,
    resolveDir: root,
    sourcefile: 'audit-trace-contract.ts'
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundle,
  external: ['better-sqlite3', 'electron'],
  logLevel: 'silent'
})

const { AuditStore, SqliteDriver, configureExecutionTraceRecorder, runWithOperationContext, traceExecution } = await import(bundle + '?t=' + Date.now())
try {
  let store = new AuditStore(databasePath)
  configureExecutionTraceRecorder(store)
  let operations = store.queryOperations({ page: 1, pageSize: 20 })
  assert.equal(operations.total, 1)
  assert.equal(operations.rows[0].action, 'EXECUTE_SQL')
  assert.equal(operations.rows[0].sqlText, null)
  const legacyTraces = store.listExecutionTraces(operations.rows[0].eventId)
  assert.equal(legacyTraces.length, 1)
  assert.equal(store.revealExecutionTrace(legacyTraces[0].id).sensitive.statement, 'SELECT 1')

  store.recordOperation({
    category: 'data',
    action: 'REFRESH_DATA',
    connectionId: 'conn-1',
    connectionName: '本地库',
    connectionType: 'sqlite',
    databaseName: 'main',
    targetType: 'table',
    targetName: 'items',
    summary: '刷新数据',
    status: 'success',
    durationMs: 8,
    details: { page: 1 }
  })
  operations = store.queryOperations({ category: 'data', page: 1, pageSize: 20 })
  assert.equal(operations.total, 1)
  assert.equal(operations.rows[0].details.page, 1)

  store.recordOperation({
    eventId: 'operation-sensitive', category: 'query', action: 'EXECUTE_QUERY',
    connectionId: 'conn-1', connectionName: '本地库', connectionType: 'sqlite',
    databaseName: 'main', summary: '执行查询', status: 'success'
  })
  store.recordExecutionTrace({
    id: 'trace-sql', operationId: 'operation-sensitive', spanId: 'span-sql', parentSpanId: null,
    sequence: 1, attempt: 1, protocol: 'sql', driverType: 'sqlite', commandName: 'ALL',
    databaseName: 'main', status: 'success', returnedRows: 1, matchedRows: null,
    affectedRows: null, responseBytes: null, errorCode: null, errorMessage: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1,
    sensitive: { statement: 'SELECT * FROM users WHERE tenant_id = ? AND age > ?', parameters: ['tenant-A', 18] }
  })
  store.recordExecutionTrace({
    id: 'trace-http', operationId: 'operation-sensitive', spanId: 'span-http', parentSpanId: null,
    sequence: 2, attempt: 1, protocol: 'http', driverType: 'qdrant', commandName: 'POST /points/query',
    databaseName: null, status: 'success', returnedRows: 2, matchedRows: null,
    affectedRows: null, responseBytes: null, errorCode: null, errorMessage: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 2,
    sensitive: {
      httpMethod: 'POST', requestPath: '/points/query?api_key=must-not-persist',
      requestBody: { filter: { tenant_id: 'tenant-A' }, vector: [0.1, 0.2], apiKey: 'must-not-persist', Authorization: 'Bearer secret' }
    }
  })
  store.recordExecutionTrace({
    id: 'trace-error', operationId: 'operation-sensitive', spanId: 'span-error', parentSpanId: null,
    sequence: 3, attempt: 1, protocol: 'sql', driverType: 'mysql', commandName: 'QUERY',
    databaseName: 'main', status: 'error', returnedRows: null, matchedRows: null,
    affectedRows: null, responseBytes: null, errorCode: 'ER_WRONG_FIELD_WITH_GROUP',
    errorMessage: "Expression #3 is not in GROUP BY; mysql://report:never-store@db/main password='also-secret'",
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 25_406,
    sensitive: { statement: 'SELECT value FROM report GROUP BY category' }
  })
  const traces = store.listExecutionTraces('operation-sensitive')
  assert.deepEqual(traces.map((trace) => trace.sequence), [1, 2, 3])
  const sqlDetail = store.revealExecutionTrace('trace-sql')
  assert.deepEqual(sqlDetail.sensitive.parameters, ['tenant-A', 18])
  assert.deepEqual(sqlDetail.sensitive.parameterTypes, ['string', 'integer'])
  const qdrantDetail = store.revealExecutionTrace('trace-http')
  assert.equal(qdrantDetail.sensitive.requestBody.filter.tenant_id, 'tenant-A')
  assert.equal(qdrantDetail.sensitive.requestBody.apiKey, '[REDACTED]')
  assert.equal(qdrantDetail.sensitive.requestBody.Authorization, '[REDACTED]')
  assert.equal(qdrantDetail.sensitive.requestPath, '/points/query?api_key=%5BREDACTED%5D')
  const errorDetail = store.revealExecutionTrace('trace-error')
  assert.match(errorDetail.sensitive.errorMessage, /Expression #3 is not in GROUP BY/)
  assert.match(errorDetail.sensitive.errorMessage, /mysql:\/\/report:\[REDACTED\]@db\/main/)
  assert.doesNotMatch(errorDetail.sensitive.errorMessage, /never-store|also-secret/)
  assert.deepEqual(store.verifyIntegrity(), { valid: true, checked: 4, failedTraceId: null })
  store.recordExecutionTrace({
    id: 'trace-credential', operationId: 'operation-sensitive', spanId: 'span-credential', parentSpanId: null,
    sequence: 4, attempt: 1, protocol: 'sql', driverType: 'postgres', commandName: 'QUERY',
    databaseName: 'main', status: 'success', returnedRows: null, matchedRows: null,
    affectedRows: 1, responseBytes: null, errorCode: null, errorMessage: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1,
    sensitive: { statement: 'ALTER USER bob PASSWORD $1', parameters: ['never-store-this-password'] }
  })
  const credentialDetail = store.revealExecutionTrace('trace-credential')
  assert.equal(credentialDetail.sensitive.statement, 'ALTER USER bob PASSWORD $1')
  assert.deepEqual(credentialDetail.sensitive.parameters, ['[REDACTED]'])
  assert.deepEqual(credentialDetail.sensitive.parameterTypes, ['string'])
  const tamper = new Database(databasePath)
  const originalCiphertext = tamper.prepare('SELECT ciphertext FROM execution_trace WHERE id = ?').get('trace-http').ciphertext
  tamper.prepare('UPDATE execution_trace SET ciphertext = ? WHERE id = ?').run(`${originalCiphertext}A`, 'trace-http')
  assert.equal(store.verifyIntegrity().valid, false)
  assert.throws(() => store.revealExecutionTrace('trace-http'), /完整性校验失败/)
  tamper.prepare('UPDATE execution_trace SET ciphertext = ? WHERE id = ?').run(originalCiphertext, 'trace-http')
  tamper.close()
  assert.equal(store.verifyIntegrity().valid, true)
  const rotatedKey = store.rotateEncryptionKey()
  assert.match(rotatedKey, /^key-/)

  const tracedDatabasePath = join(temp, 'driver.db')
  const tracedDatabase = new Database(tracedDatabasePath)
  tracedDatabase.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items(name) VALUES (\'one\'), (\'two\')')
  tracedDatabase.close()
  const driver = new SqliteDriver(tracedDatabasePath)
  await runWithOperationContext('operation-driver', async () => {
    await driver.connect()
    await driver.listTables('main', true)
    await driver.getTableData({ database: 'main', table: 'items', page: 1, pageSize: 20 })
    await driver.disconnect()
    store.recordOperation({
      eventId: 'operation-driver', category: 'data', action: 'REFRESH_DATA',
      connectionType: 'sqlite', summary: '刷新数据', status: 'success'
    })
  })
  const driverTraces = store.listExecutionTraces('operation-driver')
  assert.ok(driverTraces.length >= 5)
  assert.equal(driverTraces[0].commandName, 'OPEN')
  assert.ok(driverTraces.some((trace) => trace.protocol === 'sql' && trace.commandName === 'ALL'))
  assert.deepEqual(driverTraces.map((trace) => trace.sequence), driverTraces.map((_, index) => index + 1))
  assert.equal(store.verifyIntegrity().valid, true)

  await runWithOperationContext('operation-timeout', async () => {
    await assert.rejects(() => traceExecution({
      protocol: 'sql', driverType: 'mysql', commandName: 'QUERY', databaseName: 'main',
      sensitive: { statement: 'SELECT SLEEP(30)' }
    }, async () => {
      throw Object.assign(new Error('connect ETIMEDOUT authorization: Bearer never-store-token'), {
        code: 'ETIMEDOUT'
      })
    }), /ETIMEDOUT/)
    store.recordOperation({
      eventId: 'operation-timeout', category: 'query', action: 'EXECUTE_QUERY',
      connectionType: 'mysql', summary: '执行查询', status: 'error'
    })
  })
  const timeoutTrace = store.listExecutionTraces('operation-timeout')[0]
  assert.equal(timeoutTrace.status, 'timeout')
  assert.equal(timeoutTrace.errorCode, 'ETIMEDOUT')
  const timeoutDetail = store.revealExecutionTrace(timeoutTrace.id)
  assert.match(timeoutDetail.sensitive.errorMessage, /connect ETIMEDOUT/)
  assert.doesNotMatch(timeoutDetail.sensitive.errorMessage, /never-store-token/)

  const approval = {
    approvalId: 'approval-1',
    connectionId: 'conn-1',
    connectionName: '本地库',
    connectionType: 'sqlite',
    databaseName: 'main',
    sqlText: 'DELETE FROM items',
    sqlKind: 'WRITE',
    permissionMode: 'approval'
  }
  store.recordApproval({ ...approval, action: 'requested' })
  store.recordApproval({ ...approval, action: 'rejected', message: '用户拒绝了审批' })
  const approvals = store.queryApprovals({ connectionId: 'conn-1', page: 1, pageSize: 20 })
  assert.equal(approvals.total, 2)
  assert.deepEqual(approvals.rows.map((row) => row.action), ['rejected', 'requested'])
  assert.ok(approvals.rows.every((row) => row.sqlText === '[已加密]' && row.message === null))
  store.close()

  const raw = new Database(databasePath, { readonly: true })
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='audit_log'").get().n, 0)
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM operation_log WHERE sql_text IS NOT NULL').get().n, 0)
  const encryptedRows = raw.prepare('SELECT ciphertext FROM execution_trace').all()
  assert.ok(encryptedRows.every((row) => !row.ciphertext.includes('tenant-A') && !row.ciphertext.includes('must-not-persist')))
  raw.close()

  // 重启后迁移保持幂等，旧日志不会被重复复制。
  store = new AuditStore(databasePath)
  operations = store.queryOperations({ page: 1, pageSize: 20 })
  assert.equal(operations.total, 5)
  store.close()
  console.log('✔ 双日志存储契约测试通过')
} finally {
  rmSync(temp, { recursive: true, force: true })
  rmSync(bundle, { force: true })
}
