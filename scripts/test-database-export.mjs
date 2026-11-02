import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, 'node_modules/.cache')
mkdirSync(cache, { recursive: true })
const temp = mkdtempSync(join(tmpdir(), 'safe-db-export-'))
const bundle = join(cache, `database-export.${process.pid}.cjs`)
const driverBundle = join(cache, `export-sqlite-driver.${process.pid}.cjs`)
const require = createRequire(import.meta.url)
let driver
try {
  buildSync({ entryPoints: [join(root, 'src/main/core/databaseExport.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, logLevel: 'silent' })
  buildSync({
    stdin: {
      contents: `export { SqliteDriver } from './src/main/drivers/sqlite'; export { MongoDriver } from './src/main/drivers/mongodb'; export { RedisDriver } from './src/main/drivers/redis';`,
      resolveDir: root, loader: 'ts'
    },
    bundle: true, format: 'cjs', platform: 'node', outfile: driverBundle,
    external: ['better-sqlite3', 'mongodb', 'redis'], logLevel: 'silent'
  })
  const { saveDatabaseExport, writeDatabaseExport, assertDatabaseExportOptions, exportValue } = require(bundle)
  const { SqliteDriver, MongoDriver, RedisDriver } = require(driverBundle)
  const dbPath = join(temp, 'source.db')
  const seed = new Database(dbPath)
  seed.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, payload BLOB, quantity INTEGER CHECK(quantity >= 0));
    CREATE INDEX items_label ON items(label);
    CREATE VIEW item_labels AS SELECT id, label FROM items;
    CREATE TABLE no_pk (value TEXT, generated TEXT GENERATED ALWAYS AS (value || '!') STORED);
    INSERT INTO no_pk (value) VALUES ('中文');
  `)
  const payload = Buffer.alloc(128, 0xab)
  const insert = seed.prepare('INSERT INTO items VALUES (?, ?, ?, ?)')
  seed.transaction(() => {
    for (let id = 1; id <= 50001; id++) insert.run(id, `中文 O'Reilly ${id}`, id === 1 ? payload : null, 1)
    insert.run(9007199254740993n, 'large integer', null, 2)
  })()
  seed.close()
  driver = new SqliteDriver(dbPath)
  await driver.connect()
  const connection = { name: 'export-test', type: 'sqlite', password: 'must-not-export' }
  const options = { connectionId: 'test', databases: ['main'], mode: 'structure-and-data' }
  const path = join(temp, 'export.json')
  const result = await saveDatabaseExport(path, driver, connection, options)
  assert.deepEqual({ objects: result.objects, rows: result.rows }, { objects: 3, rows: 50003 })
  const output = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(output.connection, { name: connection.name, type: 'sqlite' })
  assert.equal(output.mode, options.mode)
  const items = output.databases[0].objects.find((object) => object.name === 'items')
  assert.equal(items.rows.length, 50002, 'must include all rows beyond the former 50000 cap')
  assert.deepEqual(items.rows[0].payload, { $safeDbType: 'binary', base64: payload.toString('base64') })
  assert.deepEqual(items.rows.at(-1).id, { $safeDbType: 'bigint', value: '9007199254740993' })
  assert.equal(items.rows[0].label, "中文 O'Reilly 1")
  assert.ok(items.indexes.some((index) => index.name === 'items_label'))
  assert.match(items.definition, /CREATE TABLE/)
  assert.equal(output.databases[0].objects.find((object) => object.type === 'view').rows, undefined)
  const noPk = output.databases[0].objects.find((object) => object.name === 'no_pk')
  assert.deepEqual(noPk.rows, [{ value: '中文', generated: '中文!' }], 'must not export synthetic rowid fields')
  const collect = async (driverToUse, mode, databases = ['main'], type = 'sqlite') => {
    let content = ''
    await writeDatabaseExport(driverToUse, { name: 'test', type }, { ...options, mode, databases }, async (chunk) => { content += chunk })
    return JSON.parse(content)
  }
  const structure = await collect(driver, 'structure')
  assert.equal(structure.totals.rows, 0)
  assert.ok(structure.databases[0].objects.every((object) => object.rows === undefined && object.definition))
  const data = await collect(driver, 'data')
  assert.equal(data.databases[0].routines, undefined)
  assert.ok(data.databases[0].objects.every((object) => object.definition === undefined && object.indexes === undefined && object.type === 'table'))
  const multiDatabase = await collect(driver, 'structure', ['main', 'temp'])
  assert.deepEqual(multiDatabase.databases.map((database) => database.name), ['main', 'temp'])

  // MongoDB 导出保留真实 BSON 类型和嵌套对象，不使用网格展示字符串。
  const { BSON } = require('mongodb')
  const document = { _id: new BSON.ObjectId(), nested: { values: [1, 2] }, long: BSON.Long.fromString('9007199254740993') }
  const mongo = new MongoDriver({ host: 'localhost', port: 27017, database: 'app' })
  mongo.listColumns = async () => []
  const mongoCursor = { skip() { return this }, limit() { return this }, toArray: async () => [document] }
  mongo.client = { db: () => ({ collection: () => ({ find: () => mongoCursor, countDocuments: async () => 1 }) }) }
  const mongoRaw = await mongo.getTableData({ table: 'docs', page: 1, pageSize: 500 }, { rawValues: true })
  assert.deepEqual(mongoRaw.rows, [BSON.EJSON.serialize(document, { relaxed: false })])
  const mongoDisplay = await mongo.getTableData({ table: 'docs', page: 1, pageSize: 500 })
  assert.equal(typeof mongoDisplay.rows[0].nested, 'string', '网格展示行为保持原样')

  // Redis 导出必须扫描到游标结束，不能沿用对象树的 5000 Key 上限。
  const redis = new RedisDriver({ host: 'localhost', port: 6379, database: '0' })
  redis.clientFor = async () => ({
    scan: async (cursor) => cursor === '0'
      ? { cursor: 'next', keys: Array.from({ length: 5000 }, (_, index) => `key:${index}`) }
      : { cursor: '0', keys: [...Array.from({ length: 1001 }, (_, index) => `key:${index + 5000}`), 'key:1'] },
    multi: () => {
      let count = 0
      return { sendCommand: () => { count++ }, execAsPipeline: async () => Array(count).fill('string') }
    }
  })
  assert.equal((await redis.listTables('0')).length, 5000)
  assert.equal((await redis.listTables('0', false, { forExport: true })).length, 6001)
  assert.deepEqual(exportValue({ date: new Date('2026-09-30T00:00:00Z'), nested: [2n, payload] }), {
    date: { $safeDbType: 'date', value: '2026-09-30T00:00:00.000Z' },
    nested: [{ $safeDbType: 'bigint', value: '2' }, { $safeDbType: 'binary', base64: payload.toString('base64') }]
  })
  for (const invalid of [null, { ...options, mode: 'unknown' }, { ...options, databases: ['main', 'main'] }, { ...options, databases: [1] }]) {
    assert.throws(() => assertDatabaseExportOptions(invalid), /无效/)
  }

  let calls = 0
  const cursorDriver = {
    capabilities: { recordModel: 'point', indexes: { list: { supported: false } } },
    listTables: async () => [{ name: 'points', type: 'table' }],
    listColumns: async () => [],
    getTableData: async (query, rawOptions) => {
      assert.equal(query.includeVectors, true)
      assert.equal(rawOptions.rawValues, true)
      calls++
      assert.equal(query.cursor, calls === 1 ? undefined : 'next')
      return { rows: [{ id: calls, payload: { nested: [1, 2] }, vector: [0.1, 0.2] }], total: 2, paginationMode: 'cursor', nextCursor: calls === 1 ? 'next' : undefined }
    }
  }
  const points = await collect(cursorDriver, 'data', [], 'qdrant')
  assert.equal(points.totals.rows, 2)
  assert.deepEqual(points.databases[0].objects[0].rows[1].vector, [0.1, 0.2])
  cursorDriver.getTableData = async () => ({ rows: [{ id: 1 }], total: 4, paginationMode: 'cursor', nextCursor: 'stuck' })
  await assert.rejects(collect(cursorDriver, 'data', [], 'qdrant'), /无效的分页游标/)
  cursorDriver.getTableData = async () => ({ rows: [{ id: 1 }], total: 4, paginationMode: 'cursor' })
  await assert.rejects(collect(cursorDriver, 'data', [], 'qdrant'), /导出不完整/)

  // 中途失败不得覆盖用户已有的文件或留下半成品。
  const oldContents = 'original user file'
  writeFileSync(path, oldContents)
  const failingDriver = Object.create(driver)
  failingDriver.getTableData = async () => { throw new Error('database disconnected') }
  await assert.rejects(saveDatabaseExport(path, failingDriver, connection, options), /database disconnected/)
  assert.equal(readFileSync(path, 'utf8'), oldContents)
  assert.ok(readdirSync(temp).every((name) => !name.endsWith('.tmp')))
  const source = new Database(dbPath, { readonly: true })
  assert.equal(source.prepare('SELECT COUNT(*) AS n FROM items').get().n, 50002)
  source.close()
  console.log('数据库导出测试通过：三种模式、50000 行以上、二进制/大整数、游标/向量、失败保护与只读源数据。')
} finally {
  await driver?.disconnect()
  rmSync(temp, { recursive: true, force: true })
  rmSync(bundle, { force: true })
  rmSync(driverBundle, { force: true })
}
