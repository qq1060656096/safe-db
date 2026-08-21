/* 全驱动能力与结构化操作契约：关系型编译器、MongoDB、Redis，以及驱动入口完整性。 */
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, 'node_modules', '.cache')
mkdirSync(cache, { recursive: true })
const outfile = join(cache, `safe-db-all-drivers.${process.pid}.cjs`)
buildSync({
  stdin: {
    contents: `
      export { capabilitiesForType } from './src/main/drivers/capabilities.ts'
      export { compileRelationalOperation } from './src/main/drivers/relationalOperation.ts'
      export { MysqlDriver } from './src/main/drivers/mysql.ts'
      export { PostgresDriver } from './src/main/drivers/postgres.ts'
      export { SqlServerDriver } from './src/main/drivers/sqlserver.ts'
      export { MongoDriver } from './src/main/drivers/mongodb.ts'
      export { RedisDriver } from './src/main/drivers/redis.ts'
    `,
    resolveDir: root,
    sourcefile: 'all-driver-contract.ts',
    loader: 'ts'
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile,
  external: ['mongodb', 'mssql', 'mysql2/promise', 'pg', 'redis'],
  logLevel: 'silent'
})

const {
  capabilitiesForType,
  compileRelationalOperation,
  MysqlDriver,
  PostgresDriver,
  SqlServerDriver,
  MongoDriver,
  RedisDriver
} = await import(outfile + '?t=' + Date.now())

try {
  const types = ['mysql', 'postgres', 'sqlite', 'sqlserver', 'mongodb', 'redis', 'qdrant']
  for (const type of types) {
    const capabilities = capabilitiesForType(type)
    assert.equal(capabilities.structuredOperations, true, `${type} 必须开放结构化操作`)
    assert.ok(capabilities.recordModel)
    assert.ok(capabilities.recordTargetKind)
    assert.ok(capabilities.objectKinds.includes(capabilities.recordTargetKind), `${type} 的主对象类型必须出现在 objectKinds`)
    assert.ok(capabilities.databases.create)
  }
  assert.equal(capabilitiesForType('mongodb').records.update.supported, true)
  assert.equal(capabilitiesForType('redis').objects.copy.supported, true)
  assert.equal(capabilitiesForType('redis').records.clear.supported, false)
  assert.equal(capabilitiesForType('qdrant').objects.copy.supported, false)
  assert.equal(capabilitiesForType('qdrant').atomicity, 'best-effort')

  for (const Driver of [MysqlDriver, PostgresDriver, SqlServerDriver, MongoDriver, RedisDriver]) {
    assert.equal(typeof Driver.prototype.executeOperation, 'function', `${Driver.name} 缺少 executeOperation`)
  }

  const dialects = ['mysql', 'postgres', 'sqlite', 'sqlserver']
  for (const dialect of dialects) {
    const commands = compileRelationalOperation({
      kind: 'records.mutate',
      target: { kind: 'table', name: 'items', database: 'app', schema: dialect === 'sqlserver' ? 'dbo' : 'public' },
      mutations: [
        { kind: 'insert', values: { id: 1, name: "O'Reilly" } },
        { kind: 'update', key: { id: 1 }, changes: { name: 'updated' } },
        { kind: 'delete', key: { id: 2 } }
      ]
    }, dialect, 'app')
    assert.equal(commands.length, 3)
    assert.ok(commands.every((command) => !command.sql.includes("O'Reilly")))
    assert.ok(commands.some((command) => command.params.includes("O'Reilly")))
  }
  assert.match(compileRelationalOperation({
    kind: 'object.create', objectType: 'database', name: 'safe-name', definition: {}
  }, 'postgres')[0].sql, /^CREATE DATABASE "safe-name"$/)
  assert.match(compileRelationalOperation({
    kind: 'index.create', target: { kind: 'table', name: 'items', schema: 'public' }, name: 'idx_name',
    definition: { columns: ['name'], unique: true }
  }, 'postgres')[0].sql, /^CREATE UNIQUE INDEX/)

  const mongoCalls = []
  const mongoCollection = {
    bulkWrite: async (writes) => {
      mongoCalls.push({ kind: 'bulkWrite', writes })
      return { insertedCount: 1, modifiedCount: 1, deletedCount: 1, upsertedCount: 0 }
    },
    deleteMany: async () => ({ deletedCount: 3 }),
    createIndex: async (keys, options) => { mongoCalls.push({ kind: 'createIndex', keys, options }); return options.name },
    dropIndex: async (name) => { mongoCalls.push({ kind: 'dropIndex', name }) },
    drop: async () => true,
    indexes: async () => [
      { name: '_id_', key: { _id: 1 } },
      { name: 'name_1', key: { name: 1 }, unique: true, v: 2, ns: 'app.docs' }
    ],
    find: () => ({ async *[Symbol.asyncIterator]() {} })
  }
  const mongoDb = {
    collection: () => mongoCollection,
    createCollection: async (name, options) => { mongoCalls.push({ kind: 'createCollection', name, options }) },
    listCollections: () => ({ next: async () => ({ options: {} }) }),
    command: async (command) => { mongoCalls.push({ kind: 'command', command }); return { ok: 1 } }
  }
  const mongo = new MongoDriver({ host: 'localhost', port: 27017, database: 'app' })
  mongo.client = { db: () => mongoDb }
  const mongoResult = await mongo.executeOperation({
    kind: 'records.mutate', target: { kind: 'collection', database: 'app', name: 'docs' },
    mutations: [
      { kind: 'insert', values: { name: 'one' } },
      { kind: 'update', key: { _id: '{"$oid":"507f1f77bcf86cd799439011"}' }, changes: { name: 'two' } },
      { kind: 'delete', key: { _id: '{"$oid":"507f1f77bcf86cd799439012"}' } }
    ]
  })
  assert.equal(mongoResult.atomicity, 'best-effort')
  assert.equal(mongoResult.succeeded, 3)
  assert.equal(mongoCalls[0].writes[1].updateOne.filter._id._bsontype, 'ObjectId')
  await mongo.executeOperation({
    kind: 'index.create', target: { kind: 'collection', database: 'app', name: 'docs' },
    name: 'name', definition: { columns: ['name'], unique: true }
  })
  assert.deepEqual(mongoCalls.find((call) => call.kind === 'createIndex').keys, { name: 1 })
  await mongo.executeOperation({
    kind: 'object.copy', source: { kind: 'collection', database: 'app', name: 'docs' },
    targetName: 'docs_copy', withData: false
  })
  const copiedIndexes = mongoCalls.find((call) => call.kind === 'command').command
  assert.equal(copiedIndexes.createIndexes, 'docs_copy')
  assert.deepEqual(copiedIndexes.indexes, [{ name: 'name_1', key: { name: 1 }, unique: true }])

  const redisCommands = []
  let redisType = 'hash'
  const redisClient = {
    type: async () => redisType,
    multi: () => {
      const queued = []
      return {
        sendCommand(command) { queued.push(command); return this },
        async exec() { redisCommands.push(...queued); return queued.map(() => 1) }
      }
    },
    del: async () => 1,
    DUMP: async () => Buffer.from('dump'),
    pTTL: async () => 0,
    RESTORE: async (...args) => { redisCommands.push(['RESTORE', ...args]); return 'OK' }
  }
  const redis = new RedisDriver({ host: 'localhost', port: 6379, database: '0' })
  redis.clientFor = async () => redisClient
  const redisResult = await redis.executeOperation({
    kind: 'records.mutate', target: { kind: 'key', database: '0', name: 'profile' },
    mutations: [
      { kind: 'insert', values: { field: 'name', value: 'Alice' } },
      { kind: 'update', key: { field: 'name' }, changes: { value: 'Bob' } },
      { kind: 'delete', key: { field: 'name' } }
    ]
  })
  assert.equal(redisResult.atomicity, 'best-effort')
  assert.deepEqual(redisCommands.slice(0, 3).map((command) => command[0]), ['HSET', 'HSET', 'HDEL'])
  redisType = 'none'
  await redis.executeOperation({
    kind: 'object.create', objectType: 'key', name: 'new-key', database: '0',
    definition: { type: 'string', value: 'hello' }
  })
  assert.ok(redisCommands.some((command) => command[0] === 'SET' && command[1] === 'new-key'))
  await assert.rejects(redis.executeOperation({
    kind: 'records.clear', target: { kind: 'key', database: '0', name: 'profile' }
  }), /不存在可保留结构的空 Key/)

  console.log('✔ 全数据库驱动能力与结构化操作契约测试通过')
} finally {
  rmSync(outfile, { force: true })
}
