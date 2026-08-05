/**
 * 语句切分:按分号把一段 SQL 拆成多条语句。
 * 对单/双/反引号字符串与行/块注释做了感知,引号内的分号不会误切。
 * 纯字符串处理,无任何依赖 —— 供 SQLite 驱动与 SQL 分类器共用。
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      cur += c
      i++
      while (i < n) {
        cur += sql[i]
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            cur += sql[i + 1]
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
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
