/* SQL 分类器单元验证:对抗性绕过 + 常见误报,直接用 esbuild 编译真实源码跑,不依赖 app/原生模块 */
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join('/tmp', `sqlClassify.test.${process.pid}.mjs`)
buildSync({
  entryPoints: [join(root, 'src/main/core/sqlClassify.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent'
})
const { classifySql } = await import(outfile + '?t=' + Date.now())

// kind 的放行语义:READ/OTHER 只读放行;WRITE/DDL 只读拦截、审批需确认
const CASES = [
  // ---- 对抗:写操作各种伪装,都必须识别为 WRITE/DDL(只读拦截)----
  ['WRITE', '基线 DELETE', 'DELETE FROM users WHERE id = 1'],
  ['WRITE', '块注释前缀绕过', '/* 注释 */ DELETE FROM users WHERE id = 1'],
  ['WRITE', '行注释前缀绕过', '-- 注释\nDELETE FROM users WHERE id = 1'],
  ['WRITE', 'MySQL # 注释绕过', '# 注释\nDELETE FROM users WHERE id = 1'],
  ['WRITE', '单层括号包裹', '(DELETE FROM users WHERE id = 1)'],
  ['WRITE', '双层括号包裹', '((DELETE FROM users WHERE id = 1))'],
  ['WRITE', 'UPDATE', 'UPDATE users SET age = 0'],
  ['WRITE', 'INSERT', "INSERT INTO users (name) VALUES ('x')"],
  ['WRITE', '数据修改 CTE(DELETE)', 'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x'],
  ['WRITE', '数据修改 CTE(UPDATE)', 'WITH x AS (UPDATE users SET age=0 RETURNING *) SELECT * FROM x'],
  ['WRITE', 'EXPLAIN ANALYZE 真执行', 'EXPLAIN ANALYZE DELETE FROM users WHERE id = 1'],
  ['WRITE', 'EXPLAIN (ANALYZE,...) 真执行', 'EXPLAIN (ANALYZE, COSTS OFF) DELETE FROM users'],
  ['WRITE', 'DO 块(动态代码)', 'DO $$ BEGIN DELETE FROM users; END $$'],
  ['WRITE', 'PREPARE 动态 SQL', "PREPARE s FROM 'DELETE FROM users'"],
  ['WRITE', 'VACUUM(未识别→按写)', 'VACUUM'],
  ['WRITE', 'PRAGMA 写(未识别→按写)', 'PRAGMA user_version = 1'],
  ['WRITE', 'LOAD DATA(未识别→按写)', "LOAD DATA INFILE '/tmp/x' INTO TABLE users"],
  ['WRITE', 'CALL 存储过程', 'CALL do_something()'],
  ['DDL', 'CREATE', 'CREATE TABLE t (id INT)'],
  ['DDL', 'DROP', 'DROP TABLE users'],
  ['DDL', 'ALTER', 'ALTER TABLE users ADD COLUMN x INT'],
  ['DDL', 'TRUNCATE', 'TRUNCATE users'],
  ['DDL', 'SELECT INTO 建表', 'SELECT * INTO backup FROM users'],
  ['DDL', 'SELECT INTO OUTFILE 写文件', "SELECT id, name INTO OUTFILE '/tmp/x' FROM users"],
  ['DDL', '多语句藏 DDL', 'SELECT 1; /* x */ DROP TABLE users'],

  // ---- 常见读/会话语句,绝不能误报(只读放行)----
  ['READ', '普通 SELECT', 'SELECT * FROM users'],
  ['READ', '字符串里含 delete', "SELECT 'delete' AS x"],
  ['READ', 'WHERE 值是 update', "SELECT name FROM users WHERE name = 'update'"],
  ['READ', '字符串里藏分号+DDL', "SELECT 'a;drop table users'"],
  ['READ', '只读 CTE', 'WITH x AS (SELECT * FROM users) SELECT * FROM x'],
  ['READ', '纯 EXPLAIN 不执行', 'EXPLAIN SELECT * FROM users'],
  ['READ', 'EXPLAIN QUERY PLAN', 'EXPLAIN QUERY PLAN SELECT * FROM users'],
  ['READ', 'EXPLAIN ANALYZE 包只读', 'EXPLAIN ANALYZE SELECT * FROM users'],
  ['READ', '行尾块注释', 'SELECT 1 /* delete */'],
  ['READ', '行尾行注释', 'SELECT * FROM users -- update'],
  ['READ', 'IN 不是 INTO', 'SELECT COUNT(*) FROM users WHERE age IN (SELECT 1)'],
  ['READ', 'snake_case 列不误报', 'SELECT updated_at, deleted_at FROM users'],
  ['READ', '双引号标识符 update', 'SELECT "update" FROM users'],
  ['READ', '反引号标识符', 'SELECT `delete` FROM users'],
  ['READ', '双写单引号字符串', "SELECT * FROM users WHERE note = 'O''Brien'"],
  ['READ', '反斜杠转义字符串', "SELECT * FROM users WHERE x = 'it\\'s'"],
  ['READ', 'PG 美元引用字符串', 'SELECT $$delete from users$$'],
  ['READ', 'SHOW', 'SHOW TABLES'],
  ['READ', 'DESC', 'DESC users'],
  ['READ', 'VALUES', 'VALUES (1,2),(3,4)'],
  ['READ', '多语句全读', 'SELECT 1; SELECT 2'],
  ['OTHER', 'SET 会话变量', 'SET autocommit = 1'],
  ['OTHER', 'USE 切库', 'USE mydb'],
  ['OTHER', 'BEGIN', 'BEGIN'],
  ['OTHER', 'START TRANSACTION', 'START TRANSACTION'],
  ['OTHER', 'SAVEPOINT', 'SAVEPOINT sp'],
  ['OTHER', 'ROLLBACK', 'ROLLBACK']
]

let fail = 0
for (const [expect, note, sql] of CASES) {
  const got = classifySql(sql).kind
  const ok = got === expect
  if (!ok) fail++
  console.log(`${ok ? '✔' : '✘'} [${expect}]${' '.repeat(Math.max(0, 6 - expect.length))}${note}${ok ? '' : `  → 实得 ${got}`}  | ${JSON.stringify(sql).slice(0, 60)}`)
}
console.log(fail ? `\n== ${fail} 项失败 ==` : `\n== 全部 ${CASES.length} 项通过 ==`)
process.exit(fail ? 1 : 0)
