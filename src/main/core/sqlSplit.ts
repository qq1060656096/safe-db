/**
 * SQL 语句切分。支持普通分号、PostgreSQL 美元引用，以及用于编辑 MySQL
 * 方法定义的 DELIMITER 指令。注释会被移除，但会保留换行以避免词元粘连。
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  const n = sql.length
  let delimiter = ';'
  let lineStart = true
  const flush = (): void => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  while (i < n) {
    if (lineStart) {
      const lineEnd = sql.indexOf('\n', i)
      const end = lineEnd === -1 ? n : lineEnd
      const directive = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(sql.slice(i, end))
      if (directive) {
        delimiter = directive[1]
        i = lineEnd === -1 ? n : lineEnd + 1
        lineStart = true
        continue
      }
    }
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      cur += '\n'
      if (i < n) i++
      lineStart = true
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      let depth = 1
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      cur += ' '
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      cur += c
      i++
      while (i < n) {
        cur += sql[i]
        if (quote === "'" && sql[i] === '\\' && i + 1 < n) {
          cur += sql[i + 1]
          i += 2
          continue
        }
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
    // 自定义分隔符优先于美元引用；例如 MySQL 的 END$$。
    if (delimiter !== ';' && sql.startsWith(delimiter, i)) {
      flush()
      i += delimiter.length
      lineStart = false
      continue
    }
    // PostgreSQL 的 $$...$$ / $tag$...$tag$ 中允许出现任意分号。
    if (c === '$') {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))
      if (match) {
        const tag = match[0]
        const close = sql.indexOf(tag, i + tag.length)
        if (close === -1) {
          cur += sql.slice(i)
          i = n
        } else {
          cur += sql.slice(i, close + tag.length)
          i = close + tag.length
        }
        lineStart = false
        continue
      }
    }
    if (delimiter === ';' && c === ';') {
      flush()
      i++
      lineStart = false
      continue
    }
    cur += c
    i++
    lineStart = c === '\n'
  }
  flush()
  return out
}
