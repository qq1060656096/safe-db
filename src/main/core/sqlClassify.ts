import type { SqlKind } from '../../shared/types'
import { splitSqlStatements } from './sqlSplit'

/** 无副作用的只读语句(首关键字直接判定) */
const READ_KEYWORDS = new Set(['SHOW', 'DESC', 'DESCRIBE', 'VALUES', 'TABLE'])
/** 数据修改 */
const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'CALL'])
/** 结构变更 / 授权 */
const DDL_KEYWORDS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'COMMENT'
])
/** 会话级 / 事务控制语句:不改数据,所有模式放行 */
const SESSION_KEYWORDS = new Set([
  'SET',
  'USE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'START',
  'SAVEPOINT',
  'RELEASE',
  'END',
  'ABORT'
])
/** 数据修改类 CTE 关键字(PG 允许 WITH x AS (INSERT/UPDATE/DELETE ...)) */
const DML_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])

const SEVERITY: Record<SqlKind, number> = { READ: 0, OTHER: 1, WRITE: 2, DDL: 3 }

/**
 * 词法扫描:抽取语句中「字符串 / 注释 / 标识符引号之外」的关键字词元(大写)。
 * 这样注释与字符串字面量里出现的 INSERT/DELETE 等不会干扰判定,
 * 同时也无法用注释把写关键字藏起来绕过只读。
 */
function tokenizeWords(stmt: string): string[] {
  const words: string[] = []
  let cur = ''
  let i = 0
  const n = stmt.length
  const flush = (): void => {
    if (cur) {
      words.push(cur.toUpperCase())
      cur = ''
    }
  }
  while (i < n) {
    const c = stmt[i]
    const next = stmt[i + 1]
    // 行注释 -- 与 #(MySQL)
    if ((c === '-' && next === '-') || c === '#') {
      flush()
      while (i < n && stmt[i] !== '\n') i++
      continue
    }
    // 块注释 /* */(PG 支持嵌套)
    if (c === '/' && next === '*') {
      flush()
      i += 2
      let depth = 1
      while (i < n && depth > 0) {
        if (stmt[i] === '/' && stmt[i + 1] === '*') {
          depth++
          i += 2
        } else if (stmt[i] === '*' && stmt[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    // PG 美元引用 $tag$ ... $tag$
    if (c === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(stmt.slice(i))
      if (m) {
        flush()
        const tag = m[0]
        const close = stmt.indexOf(tag, i + tag.length)
        i = close === -1 ? n : close + tag.length
        continue
      }
      // 否则 $ 是标识符一部分(如 col$)
      cur += c
      i++
      continue
    }
    // 字符串 / 标识符引号:' " `
    if (c === "'" || c === '"' || c === '`') {
      flush()
      const q = c
      i++
      while (i < n) {
        // MySQL 字符串内反斜杠转义(如 'it\'s')
        if (stmt[i] === '\\' && q === "'") {
          i += 2
          continue
        }
        if (stmt[i] === q) {
          if (stmt[i + 1] === q) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    // 词元字符(字母/数字/下划线)
    if (/[A-Za-z0-9_]/.test(c)) {
      cur += c
      i++
      continue
    }
    // 其余(空白、括号、运算符、标点)视为词元边界
    flush()
    i++
  }
  flush()
  return words
}

/** 由词元序列判定单条语句风险等级 */
function classifyFromWords(words: string[]): SqlKind {
  if (words.length === 0) return 'READ' // 空 / 纯注释,无副作用
  const kw = words[0]

  // EXPLAIN [ANALYZE | (选项)] <语句>:仅当带 ANALYZE 时才真正执行内部语句
  if (kw === 'EXPLAIN') {
    const STMT_START = new Set([
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'WITH',
      'VALUES',
      'TABLE',
      'MERGE',
      'REPLACE',
      'CALL'
    ])
    let i = 1
    let analyze = false
    while (i < words.length && !STMT_START.has(words[i])) {
      if (words[i] === 'ANALYZE') analyze = true
      i++
    }
    if (!analyze) return 'READ' // 纯 EXPLAIN 不执行
    // EXPLAIN ANALYZE 会真正执行,按内部语句定级
    return i < words.length ? classifyFromWords(words.slice(i)) : 'WRITE'
  }

  // WITH ...:PG 允许数据修改 CTE(WITH x AS (DELETE ...) SELECT ...)
  if (kw === 'WITH') {
    return words.slice(1).some((w) => DML_KEYWORDS.has(w)) ? 'WRITE' : 'READ'
  }

  // SELECT ... INTO:建表 / 写文件,并非只读
  if (kw === 'SELECT') {
    return words.slice(1).includes('INTO') ? 'DDL' : 'READ'
  }

  if (READ_KEYWORDS.has(kw)) return 'READ'
  if (WRITE_KEYWORDS.has(kw)) return 'WRITE'
  if (DDL_KEYWORDS.has(kw)) return 'DDL'
  if (SESSION_KEYWORDS.has(kw)) return 'OTHER'

  // 兜底:识别不出的一律按写处理 —— 失败即收紧(只读拦截,审批需确认)。
  // 覆盖 DO / PREPARE / EXECUTE / CALL 动态 SQL、LOAD DATA、COPY、
  // LOCK、VACUUM、ANALYZE、PRAGMA、ATTACH 等可能产生副作用的语句。
  return 'WRITE'
}

export function classifyStatement(stmt: string): SqlKind {
  return classifyFromWords(tokenizeWords(stmt))
}

export interface ClassifiedSql {
  kind: SqlKind
  statements: { sql: string; kind: SqlKind }[]
}

/** 整条 SQL(可多语句)分类:整体风险等级取各语句最高 */
export function classifySql(sql: string): ClassifiedSql {
  const stmts = splitSqlStatements(sql)
  const statements = stmts.map((s) => ({ sql: s, kind: classifyStatement(s) }))
  const kind = statements.reduce<SqlKind>(
    (acc, s) => (SEVERITY[s.kind] > SEVERITY[acc] ? s.kind : acc),
    'READ'
  )
  // 空 SQL 视为 READ,不会产生任何执行
  return { kind: statements.length ? kind : 'READ', statements }
}
