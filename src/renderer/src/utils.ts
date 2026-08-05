import type { ColumnFilter, ColumnInfo } from '../../shared/types'

/** CSV 单元格转义:含引号/逗号/换行时用双引号包裹并双写内部引号 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

/** 生成 CSV(带 BOM,Excel 打开中文不乱码) */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.map(csvCell).join(',')
  const lines = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))
  return '\uFEFF' + [header, ...lines].join('\r\n')
}

/** 生成 JSON(行对象数组) */
export function toJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2)
}

/**
 * 解析单个列的筛选输入为结构化条件(发往主进程后值走参数绑定)。
 * 语法:
 *   空            → 无条件
 *   null / !null  → IS NULL / IS NOT NULL
 *   > = < >= <= != → 比较(如 `>5`、`!=abc`)
 *   ~x / !~x      → 包含 / 不包含(LIKE %x%)
 *   其它纯文本     → 数值列按 `=`,文本列按包含(LIKE %x%)
 */
export function parseColumnFilter(column: string, raw: string, isNumeric: boolean): ColumnFilter | null {
  const t = raw.trim()
  if (!t) return null
  if (/^null$/i.test(t)) return { column, op: 'null' }
  if (/^!null$/i.test(t)) return { column, op: 'notnull' }
  const m = /^(>=|<=|!=|!~|>|<|=|~)\s*(.*)$/.exec(t)
  if (m) {
    const op = m[1]
    const value = m[2]
    if (op === '~') return { column, op: 'like', value }
    if (op === '!~') return { column, op: 'notlike', value }
    return { column, op: op as ColumnFilter['op'], value }
  }
  return isNumeric ? { column, op: '=', value: t } : { column, op: 'like', value: t }
}

const NUMERIC_TYPES =
  /^(tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|decimal|numeric|float|double|real|number|money)/i

export function isNumericColumn(col: ColumnInfo | undefined): boolean {
  return !!col && NUMERIC_TYPES.test(col.dataType)
}
