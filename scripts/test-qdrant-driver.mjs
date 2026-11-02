/* Qdrant 驱动契约测试：连接、Collection 元数据、游标分页和原生 REST 请求。 */
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { rmSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join('/tmp', `qdrantDriver.test.${process.pid}.cjs`)
buildSync({
  entryPoints: [join(root, 'src/main/drivers/qdrant.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile,
  logLevel: 'silent'
})
const { QdrantDriver } = await import(outfile + '?t=' + Date.now())

const requests = []
const collectionInfo = {
  status: 'green',
  optimizer_status: 'ok',
  indexed_vectors_count: 2,
  points_count: 2,
  segments_count: 1,
  config: {
    params: {
      vectors: { size: 2, distance: 'Cosine' },
      shard_number: 1,
      replication_factor: 1,
      write_consistency_factor: 1,
      sparse_vectors: null
    },
    hnsw_config: {},
    optimizer_config: {},
    wal_config: {}
  },
  payload_schema: { city: { data_type: 'keyword', points: 2 } }
}
const namedCollectionInfo = {
  ...collectionInfo,
  config: {
    ...collectionInfo.config,
    params: {
      ...collectionInfo.config.params,
      vectors: {
        text: { size: 2, distance: 'Cosine' },
        image: { size: 3, distance: 'Dot' }
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const parsedBody = body ? JSON.parse(body) : undefined
  requests.push({ method: req.method, url: req.url, body: parsedBody, apiKey: req.headers['api-key'] })
  res.setHeader('content-type', 'application/json')
  res.setHeader('x-qdrant-version', '1.19.0')
  const send = (result) => res.end(JSON.stringify({ result, status: 'ok', time: 0.001 }))
  if (req.method === 'GET' && req.url === '/') return res.end(JSON.stringify({ title: 'qdrant', version: '1.19.0', commit: 'test' }))
  if (req.method === 'GET' && req.url === '/collections') return send({ collections: [{ name: 'docs' }] })
  if (req.method === 'GET' && req.url === '/collections/docs') return send(collectionInfo)
  if (req.method === 'GET' && req.url === '/collections/named') return send(namedCollectionInfo)
  if (req.method === 'POST' && req.url === '/collections/docs/points/count') return send({ count: 2 })
  if (req.method === 'POST' && req.url === '/collections/docs/points/scroll') {
    if (parsedBody?.limit === 100) return send({ points: [{ id: 1, payload: { city: 'Beijing', nested: { active: true } } }] })
    if (parsedBody?.offset === 2) return send({ points: [{ id: 2, payload: { city: 'Shanghai' }, vector: parsedBody.with_vector ? [0.3, 0.4] : undefined }] })
    return send({ points: [{ id: 1, payload: { city: 'Beijing' }, vector: parsedBody?.with_vector ? [0.1, 0.2] : undefined }], next_page_offset: 2 })
  }
  if (req.method === 'POST' && req.url === '/collections/docs/points/query') {
    return send({ points: [{ id: 1, score: 0.99, payload: { city: 'Beijing' } }] })
  }
  if (req.method === 'POST' && req.url === '/collections/named/points/query') {
    return send({ points: [{ id: 2, score: 0.88, payload: { city: 'Shanghai' } }] })
  }
  if (req.method === 'PUT' && (req.url === '/collections/docs/points' || req.url === '/collections/docs/points?wait=true')) return send({ operation_id: 7, status: 'completed' })
  if ((req.method === 'POST' || req.method === 'PUT') && /^\/collections\/docs\/points\/(?:payload|vectors|delete)\?wait=true$/.test(req.url)) return send({ operation_id: 8, status: 'completed' })
  if (req.method === 'PUT' && req.url === '/collections/newdocs') return send(true)
  if (req.method === 'DELETE' && req.url === '/collections/newdocs') return send(true)
  if (req.method === 'PUT' && req.url === '/collections/docs/index?wait=true') return send({ operation_id: 9, status: 'completed' })
  if (req.method === 'DELETE' && req.url === '/collections/docs/index/city?wait=true') return send({ operation_id: 10, status: 'completed' })
  res.statusCode = 404
  res.end(JSON.stringify({ status: { error: 'not found' } }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address !== 'string')
const originalWarn = console.warn
let driver
try {
  console.warn = (...args) => {
    if (!String(args[0]).includes('Api key is used with unsecure connection')) originalWarn(...args)
  }
  driver = new QdrantDriver({ host: '127.0.0.1', port: address.port, apiKey: 'secret', timeoutMs: 5000 })
} finally {
  console.warn = originalWarn
}

try {
  await driver.connect()
  assert.deepEqual(await driver.listDatabases(), [])
  assert.deepEqual((await driver.listTables()).map((item) => item.name), ['docs'])
  const tables = await driver.listTables(undefined, true)
  assert.equal(tables[0].rowCount, 2)
  assert.match(tables[0].comment, /dense\[2\] Cosine/)

  const columns = await driver.listColumns(undefined, 'docs')
  assert.ok(columns.some((column) => column.name === 'payload.city' && column.extra === 'payload index'))
  assert.ok(columns.some((column) => column.name === 'payload.nested' && column.extra === 'sampled payload'))
  assert.ok((await driver.listIndexes(undefined, 'docs')).some((index) => index.name === 'payload:city'))

  const first = await driver.getTableData({ table: 'docs', page: 1, pageSize: 1 })
  assert.equal(first.editable, true)
  assert.equal(first.paginationMode, 'cursor')
  assert.equal(first.nextCursor, 2)
  assert.equal(first.rows[0]['payload.city'], 'Beijing')
  assert.match(String(first.rows[0].vector), /hidden/)
  const second = await driver.getTableData({ table: 'docs', page: 2, pageSize: 1, cursor: first.nextCursor, includeVectors: true })
  assert.equal(second.rows[0].id, 2)
  assert.equal(second.rows[0].vector, '[0.3,0.4]')
  const raw = await driver.getTableData({ table: 'docs', page: 1, pageSize: 1, includeVectors: true }, { rawValues: true })
  assert.deepEqual(raw.rows[0], { id: 1, payload: { city: 'Beijing' }, vector: [0.1, 0.2] })
  await driver.getTableData({
    table: 'docs', page: 1, pageSize: 10,
    filters: [{ column: 'payload.city', op: '=', value: '"Beijing"' }]
  })
  const filteredScroll = requests.findLast((request) => request.url === '/collections/docs/points/scroll')
  assert.deepEqual(filteredScroll?.body?.filter?.must, [{ key: 'city', match: { value: 'Beijing' } }])
  const vectorResult = await driver.getTableData({
    table: 'docs', page: 1, pageSize: 100,
    nativeQuery: {
      type: 'qdrant',
      vector: { vector: [0.1, 0.2], scoreThreshold: 0.75, limit: 20 },
      filter: [
        { clause: 'must', field: 'payload.city', op: 'match_any', value: '["Beijing", "Shanghai"]' },
        { clause: 'must_not', field: 'payload.status', op: 'match', value: '"deleted"' }
      ]
    }
  })
  assert.equal(vectorResult.paginationMode, 'none')
  assert.equal(vectorResult.totalMode, 'returned')
  assert.equal(vectorResult.rows[0].score, 0.99)
  assert.ok(vectorResult.columns.some((column) => column.name === 'score'))
  assert.deepEqual(vectorResult.vectorFields, [{ kind: 'dense', size: 2, distance: 'Cosine' }])
  const vectorRequest = requests.findLast((request) => request.url === '/collections/docs/points/query')
  assert.deepEqual(vectorRequest?.body?.query, [0.1, 0.2])
  assert.equal(vectorRequest?.body?.score_threshold, 0.75)
  assert.equal(vectorRequest?.body?.limit, 20)
  assert.deepEqual(vectorRequest?.body?.filter?.must, [{ key: 'city', match: { any: ['Beijing', 'Shanghai'] } }])
  assert.deepEqual(vectorRequest?.body?.filter?.must_not, [{ key: 'status', match: { value: 'deleted' } }])
  const namedResult = await driver.getTableData({
    table: 'named', page: 1, pageSize: 100,
    nativeQuery: { type: 'qdrant', vector: { using: 'text', vector: [0.3, 0.4], limit: 5 } }
  })
  assert.equal(namedResult.rows[0].score, 0.88)
  assert.deepEqual(namedResult.vectorFields, [
    { name: 'text', kind: 'dense', size: 2, distance: 'Cosine' },
    { name: 'image', kind: 'dense', size: 3, distance: 'Dot' }
  ])
  const namedRequest = requests.findLast((request) => request.url === '/collections/named/points/query')
  assert.equal(namedRequest?.body?.using, 'text')
  await assert.rejects(
    driver.getTableData({
      table: 'docs', page: 1, pageSize: 10,
      nativeQuery: { type: 'qdrant', vector: { vector: [0.1], limit: 10 } }
    }),
    /维度应为 2/
  )
  await assert.rejects(
    driver.getTableData({ table: 'docs', page: 1, pageSize: 10, orderBy: [{ column: 'id', direction: 'desc' }] }),
    /只支持按 id 正序/
  )

  const read = await driver.run(JSON.stringify({
    method: 'POST', path: '/collections/docs/points/query', body: { query: [0.1, 0.2], limit: 1 }
  }))
  assert.equal(read[0].kind, 'rows')
  assert.equal(read[0].rows[0].score, 0.99)

  const write = await driver.runInTransaction([JSON.stringify({
    method: 'PUT', path: '/collections/docs/points', query: { wait: true }, body: { points: [{ id: 3, vector: [0.5, 0.6] }] }
  })])
  assert.deepEqual(write, [{ kind: 'exec', affectedRows: 1 }])
  assert.ok(requests.some((request) => request.url === '/collections/docs/points?wait=true'))
  assert.ok(requests.every((request) => request.apiKey === 'secret'))

  assert.equal(driver.capabilities.structuredOperations, true)
  const structured = await driver.executeOperation({
    kind: 'records.mutate', target: { kind: 'collection', name: 'docs' },
    mutations: [
      { kind: 'update', key: { id: 1 }, changes: { 'payload.city': 'Shenzhen', vector: [0.9, 0.8] } },
      { kind: 'delete', key: { id: 2 } }
    ]
  })
  assert.equal(structured.atomicity, 'best-effort')
  assert.equal(structured.succeeded, 2)
  assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/collections/docs/points/payload?wait=true'))
  assert.ok(requests.some((request) => request.method === 'PUT' && request.url === '/collections/docs/points/vectors?wait=true'))
  assert.ok(requests.some((request) => request.method === 'POST' && request.url === '/collections/docs/points/delete?wait=true'))

  await driver.executeOperation({
    kind: 'object.create', objectType: 'collection', name: 'newdocs',
    definition: { vectors: { size: 2, distance: 'Cosine' } }
  })
  await driver.executeOperation({ kind: 'object.drop', target: { kind: 'collection', name: 'newdocs' } })
  await driver.executeOperation({
    kind: 'index.create', target: { kind: 'collection', name: 'docs' }, name: 'city',
    definition: { fieldSchema: 'keyword' }
  })
  await driver.executeOperation({ kind: 'index.drop', target: { kind: 'collection', name: 'docs' }, name: 'city' })
  console.log('✔ Qdrant 驱动测试通过')
} finally {
  await driver.disconnect()
  await new Promise((resolve) => server.close(resolve))
  rmSync(outfile, { force: true })
}
