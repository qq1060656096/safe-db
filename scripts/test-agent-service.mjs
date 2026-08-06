/* Agent CLI 服务单元验证：连接发现、多表结构、SQL 分类与审批生命周期。 */
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join('/tmp', `agentService.test.${process.pid}.mjs`)
buildSync({
  entryPoints: [join(root, 'src/main/agent/service.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent'
})
const { AgentService } = await import(outfile + '?t=' + Date.now())

const connection = {
  id: 'conn-1',
  name: '测试库',
  type: 'postgres',
  database: 'app',
  permissionMode: 'approval',
  permissionModeLocked: true,
  host: 'secret.internal',
  user: 'secret-user'
}

const driver = {
  listDatabases: async () => ['app', 'analytics'],
  listTables: async () => [
    { schema: 'public', name: 'users', type: 'table', comment: '用户表' },
    { schema: 'sales', name: 'orders', type: 'table' }
  ],
  listRoutines: async () => [{ schema: 'public', name: 'find_user', type: 'function' }],
  listColumns: async (_database, table) => table === 'users'
    ? [{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, defaultValue: null, ordinal: 1 }]
    : [{ name: 'id', dataType: 'uuid', nullable: false, isPrimaryKey: true, defaultValue: null, ordinal: 1 }],
  listIndexes: async (_database, table) => [{ name: `${table}_pkey`, columns: ['id'], unique: true, primary: true }],
  listForeignKeys: async () => [],
  listCheckConstraints: async () => [],
  getObjectDdl: async (_database, table, schema) => `CREATE TABLE "${schema}"."${table}" ();`
}

let approvalListener
const executor = {
  onApprovalResolved(listener) {
    approvalListener = listener
    return () => {}
  },
  async execute(_connectionId, sql) {
    if (/^select/i.test(sql.trim())) {
      return { status: 'ok', sqlKind: 'READ', results: [{ kind: 'rows', rows: [{ id: '1' }] }] }
    }
    return { status: 'needsApproval', sqlKind: 'WRITE', approvalToken: 'approval-token' }
  }
}

const notifications = []
const service = new AgentService(
  { list: () => [connection] },
  { get: async () => driver },
  executor,
  (request) => notifications.push(request)
)

const listed = await service.handle('connection.list', {})
assert.equal(listed.status, 'ok')
assert.deepEqual(listed.data.connections[0], {
  id: 'conn-1',
  name: '测试库',
  type: 'postgres',
  defaultDatabase: 'app',
  permissionMode: 'approval',
  permissionModeLocked: true,
  sshEnabled: false
})

const described = await service.handle('table.describe', {
  connection: '测试库',
  database: 'app',
  tables: ['public.users', 'sales.orders', 'public.users', 'missing']
})
assert.equal(described.status, 'partial')
assert.deepEqual(described.data.summary, { requested: 3, succeeded: 2, failed: 1 })
assert.equal(described.data.tables[0].columns[0].dataType, 'bigint')
assert.equal(described.data.tables[2].error.code, 'TABLE_NOT_FOUND')

const checked = await service.handle('sql.check', {
  connection: 'conn-1',
  database: 'app',
  sql: 'UPDATE users SET name = \'x\' WHERE id = 1'
})
assert.equal(checked.data.classification, 'WRITE')
assert.equal(checked.data.decision, 'approval_required')

const submitted = await service.handle('sql.run', {
  connection: 'conn-1',
  database: 'app',
  sql: 'UPDATE users SET name = \'x\' WHERE id = 1'
})
assert.equal(submitted.status, 'approval_required')
assert.equal(notifications.length, 1)
const requestId = submitted.data.requestId

const pending = await service.handle('request.get', { requestId })
assert.equal(pending.status, 'pending')

approvalListener({ token: 'approval-token', response: { status: 'ok', sqlKind: 'WRITE', results: [] } })
const completed = await service.handle('request.get', { requestId })
assert.equal(completed.status, 'completed')

console.log('✔ Agent CLI 服务测试通过')
