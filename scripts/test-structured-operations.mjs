/* 结构化操作契约：运行时输入校验、SQLite 参数绑定 CRUD 与真实事务。 */
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'safe-db-operations-'))
const cache = join(root, 'node_modules', '.cache')
mkdirSync(cache, { recursive: true })
const driverBundle = join(cache, `sqlite-driver.${process.pid}.cjs`)
const operationBundle = join(cache, `database-operation.${process.pid}.cjs`)
const executorBundle = join(cache, `executor.${process.pid}.cjs`)
buildSync({
  entryPoints: [join(root, 'src/main/drivers/sqlite.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: driverBundle, external: ['better-sqlite3'], logLevel: 'silent'
})
buildSync({
  entryPoints: [join(root, 'src/main/core/executor.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: executorBundle, logLevel: 'silent'
})
buildSync({
  entryPoints: [join(root, 'src/main/core/databaseOperation.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: operationBundle, logLevel: 'silent'
})

const { SqliteDriver } = await import(driverBundle + '?t=' + Date.now())
const { assertDatabaseOperation, databaseOperationPreview } = await import(operationBundle + '?t=' + Date.now())
const { Executor } = await import(executorBundle + '?t=' + Date.now())
const databasePath = join(temp, 'contract.db')
const seed = new Database(databasePath)
seed.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, amount INTEGER)')
seed.close()

const driver = new SqliteDriver(databasePath)
try {
  await driver.connect()
  assert.equal(driver.capabilities.structuredOperations, true)
  const result = await driver.executeOperation({
    kind: 'records.mutate', target: { kind: 'table', database: 'main', name: 'items' },
    mutations: [
      { kind: 'insert', values: { id: 1, name: "O'Reilly", amount: 2 } },
      { kind: 'insert', values: { id: 2, name: 'delete-me', amount: 3 } },
      { kind: 'update', key: { id: 1 }, changes: { amount: 5 } },
      { kind: 'delete', key: { id: 2 } }
    ]
  })
  assert.equal(result.atomicity, 'transaction')
  assert.equal(result.succeeded, 4)
  const rows = await driver.run('SELECT id, name, amount FROM items ORDER BY id')
  assert.deepEqual(rows[0].rows, [{ id: 1, name: "O'Reilly", amount: 5 }])

  await assert.rejects(
    driver.executeOperation({
      kind: 'records.mutate', target: { kind: 'table', database: 'main', name: 'items' },
      mutations: [
        { kind: 'insert', values: { id: 3, name: 'must rollback', amount: 1 } },
        { kind: 'insert', values: { id: 1, name: 'duplicate', amount: 1 } }
      ]
    }),
    /UNIQUE constraint failed/
  )
  const count = await driver.run('SELECT COUNT(*) AS count FROM items')
  assert.equal(count[0].rows[0].count, 1)

  assert.throws(() => assertDatabaseOperation({
    kind: 'records.mutate', target: { kind: 'table', name: 'items' }, mutations: []
  }), /不能为空/)
  assert.throws(() => assertDatabaseOperation({
    kind: 'object.drop', target: { kind: 'table', name: '../items' + '\0' }
  }), /无效/)
  const preview = databaseOperationPreview({
    kind: 'records.mutate', target: { kind: 'table', name: 'items' },
    mutations: Array.from({ length: 100 }, (_, id) => ({ kind: 'insert', values: { id, value: 'x'.repeat(1_000) } }))
  })
  assert.ok(preview.length < 5_000)
  assert.match(preview, /omittedMutations/)

  const auditRows = []
  const approvalRows = []
  let executed = 0
  const configs = {
    approval: { id: 'approval', name: 'approval', type: 'sqlite', permissionMode: 'approval' },
    readonly: { id: 'readonly', name: 'readonly', type: 'sqlite', permissionMode: 'readonly' }
  }
  const executor = new Executor(
    { get: (id) => configs[id] },
    {
      capabilities: () => driver.capabilities,
      get: async () => ({
        capabilities: driver.capabilities,
        executeOperation: async () => {
          executed += 1
          return { results: [{ kind: 'exec', affectedRows: 1 }], atomicity: 'transaction', succeeded: 1, failed: 0 }
        }
      })
    },
    {
      insert: (row) => auditRows.push(row),
      recordApproval: (row) => approvalRows.push(row)
    }
  )
  const approval = await executor.executeOperation('approval', {
    kind: 'records.clear', target: { kind: 'table', database: 'main', name: 'items' }
  })
  assert.equal(approval.status, 'needsApproval')
  assert.equal(approvalRows.at(-1).action, 'requested')
  const approvedAuditId = approvalRows.at(-1).approvalId
  assert.notEqual(approvedAuditId, approval.approvalToken)
  assert.equal(executed, 0)
  const approved = await executor.confirmExecute(approval.approvalToken)
  assert.equal(approved.status, 'ok')
  assert.equal(approved.atomicity, 'transaction')
  assert.equal(approvalRows.at(-1).action, 'approved')
  assert.equal(executed, 1)
  assert.equal(auditRows.at(-1).approvalId, approvedAuditId)
  const rejectedApproval = await executor.executeOperation('approval', {
    kind: 'records.clear', target: { kind: 'table', database: 'main', name: 'items' }
  })
  const rejectedAuditId = approvalRows.at(-1).approvalId
  await executor.rejectExecute(rejectedApproval.approvalToken)
  assert.equal(approvalRows.at(-1).action, 'rejected')
  assert.equal(auditRows.at(-1).approvalId, rejectedAuditId)
  assert.equal(auditRows.at(-1).status, 'blocked')
  const denied = await executor.executeOperation('readonly', {
    kind: 'records.clear', target: { kind: 'table', database: 'main', name: 'items' }
  })
  assert.equal(denied.status, 'denied')
  assert.equal(executed, 1)
  const mismatchedTarget = await executor.executeOperation('approval', {
    kind: 'records.clear', target: { kind: 'collection', database: 'main', name: 'items' }
  })
  assert.equal(mismatchedTarget.status, 'error')
  assert.match(mismatchedTarget.error, /目标必须是 table/)
  assert.equal(executed, 1)
  assert.ok(auditRows.some((row) => row.status === 'success'))
  assert.ok(auditRows.some((row) => row.status === 'blocked'))

  await driver.executeOperation({
    kind: 'object.alter', target: { kind: 'table', database: 'main', name: 'items' },
    changes: [{ kind: 'add', column: { name: 'note', dataType: 'TEXT', nullable: true } }]
  })
  assert.ok((await driver.listColumns('main', 'items')).some((column) => column.name === 'note'))
  await driver.executeOperation({
    kind: 'index.create', target: { kind: 'table', database: 'main', name: 'items' },
    name: 'idx_items_amount', definition: { columns: ['amount'], unique: false }
  })
  assert.ok((await driver.listIndexes('main', 'items')).some((index) => index.name === 'idx_items_amount'))
  await driver.executeOperation({
    kind: 'object.copy', source: { kind: 'table', database: 'main', name: 'items' },
    targetName: 'items_copy', withData: true
  })
  assert.equal((await driver.run('SELECT COUNT(*) AS count FROM items_copy'))[0].rows[0].count, 1)
  await driver.executeOperation({ kind: 'object.drop', target: { kind: 'table', database: 'main', name: 'items_copy' } })
  await driver.executeOperation({
    kind: 'index.drop', target: { kind: 'table', database: 'main', name: 'items' }, name: 'idx_items_amount'
  })

  await driver.executeOperation({ kind: 'records.clear', target: { kind: 'table', database: 'main', name: 'items' } })
  const empty = await driver.run('SELECT COUNT(*) AS count FROM items')
  assert.equal(empty[0].rows[0].count, 0)
  console.log('✔ 结构化操作契约测试通过')
} finally {
  await driver.disconnect()
  rmSync(temp, { recursive: true, force: true })
  rmSync(driverBundle, { force: true })
  rmSync(operationBundle, { force: true })
  rmSync(executorBundle, { force: true })
}
