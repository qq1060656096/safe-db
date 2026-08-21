import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..')
const outfile = join('/tmp', `nativeCommand.test.${process.pid}.mjs`)

await build({
  entryPoints: [join(root, 'src/main/core/nativeCommand.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm'
})

const { classifyDatabaseInput, normalizeMysqlSessionVariables, parseRedisCommands } = await import(pathToFileURL(outfile).href)

const cases = [
  ['mongodb', 'READ', '{"find":"users","filter":{"active":true}}'],
  ['mongodb', 'READ', '{"aggregate":"users","pipeline":[{"$match":{}}],"cursor":{}}'],
  ['mongodb', 'WRITE', '{"aggregate":"users","pipeline":[{"$merge":"summary"}],"cursor":{}}'],
  ['mongodb', 'WRITE', '{"insert":"users","documents":[{"name":"Alice"}]}'],
  ['mongodb', 'DDL', '{"createIndexes":"users","indexes":[{"key":{"name":1},"name":"idx_name"}]}'],
  ['redis', 'READ', 'GET "user:1"'],
  ['redis', 'READ', 'HGETALL user:1'],
  ['redis', 'WRITE', 'SET "user:1" "Alice Zhang"'],
  ['redis', 'WRITE', 'GET user:1\nDEL user:1'],
  ['redis', 'DDL', 'FLUSHDB'],
  ['qdrant', 'READ', '{"method":"GET","path":"/collections"}'],
  ['qdrant', 'READ', '{"method":"POST","path":"/collections/docs/points/query","body":{"query":[0.1,0.2]}}'],
  ['qdrant', 'WRITE', '{"method":"PUT","path":"/collections/docs/points","body":{"points":[{"id":1,"vector":[0.1,0.2]}]}}'],
  ['qdrant', 'WRITE', '{"method":"PUT","path":"/collections/docs/points","query":{"wait":true},"body":{"points":[{"id":2,"vector":[0.1,0.2]}]}}'],
  ['qdrant', 'DDL', '{"method":"PUT","path":"/collections/docs","body":{"vectors":{"size":2,"distance":"Cosine"}}}']
]

for (const [type, expected, input] of cases) {
  const actual = classifyDatabaseInput(type, input).kind
  assert.equal(actual, expected, `${type}: ${input}`)
}

assert.deepEqual(parseRedisCommands('SET key "hello world"\n# comment\nGET key').map((item) => item.args), [
  ['SET', 'key', 'hello world'],
  ['GET', 'key']
])
assert.throws(() => classifyDatabaseInput('mongodb', '{bad json}'), /MongoDB/)
assert.throws(() => classifyDatabaseInput('redis', 'SET key "unterminated'), /未闭合/)
assert.throws(() => classifyDatabaseInput('qdrant', '{"method":"GET","path":"https://evil.example/collections"}'), /相对 API 路径/)
assert.throws(() => classifyDatabaseInput('qdrant', '{"method":"GET","path":"/collections/%2Fcluster"}'), /不安全的路径片段/)
assert.throws(() => classifyDatabaseInput('qdrant', '{"method":"GET","path":"/collections","headers":{"api-key":"leak"}}'), /只允许 method、path、query 和 body/)
assert.throws(() => classifyDatabaseInput('qdrant', '{"method":"GET","path":"/collections","query":{"api_key":"leak"}}'), /query 参数未开放/)
assert.throws(() => classifyDatabaseInput('qdrant', '{"method":"GET","path":"/cluster"}'), /未开放/)
assert.throws(() => classifyDatabaseInput('qdrant', '[{"method":"PUT","path":"/collections/a","body":{}},{"method":"DELETE","path":"/collections/b"}]'), /每次只能执行一条/)

const mysqlVariableQuery = `-- 176
SELECT company_id FROM common_company WHERE company_id = 195878;
@companyName = '%阿商订货宝176%';
SELECT company_id FROM common_company
WHERE company_name LIKE @companyName OR system_name LIKE @companyName;`
assert.equal(classifyDatabaseInput('mysql', mysqlVariableQuery).kind, 'OTHER')
assert.match(normalizeMysqlSessionVariables(mysqlVariableQuery), /SET @companyName = '%阿商订货宝176%'/)
assert.equal(
  normalizeMysqlSessionVariables("SELECT '@unchanged = 1;' AS sample; -- @comment = 2\nSELECT 1;"),
  "SELECT '@unchanged = 1;' AS sample; -- @comment = 2\nSELECT 1;"
)
assert.equal(classifyDatabaseInput('mysql', '@value = 1; DELETE FROM users WHERE id = 1').kind, 'WRITE')

const mysqlSetVariableQuery = `set companyId = 195878;
set ordersNum = 'DH.20260807.0031';
set ordersId = 340186;
select * from import_orders where company_id = @companyId and orders_num = @ordersNum;
select * from import_orders_list where company_id = @companyId and orders_id = @ordersId;`
const normalizedMysqlSetVariables = normalizeMysqlSessionVariables(mysqlSetVariableQuery)
assert.match(normalizedMysqlSetVariables, /set @companyId = 195878/)
assert.match(normalizedMysqlSetVariables, /set @ordersNum = 'DH\.20260807\.0031'/)
assert.match(normalizedMysqlSetVariables, /set @ordersId = 340186/)
assert.equal(
  normalizeMysqlSessionVariables("SET autocommit = 0; SELECT @@autocommit, '@autocommit'; -- @autocommit\n"),
  "SET autocommit = 0; SELECT @@autocommit, '@autocommit'; -- @autocommit\n"
)

console.log('✔ MySQL / MongoDB / Redis / Qdrant 命令分类与解析测试通过')
