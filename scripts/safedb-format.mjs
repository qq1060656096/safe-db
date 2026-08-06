const MAX_COLUMN_WIDTH = 40

function isWide(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

function displayWidth(value) {
  let width = 0
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined || codePoint === 0xfe0f || /\p{Mark}/u.test(character)) continue
    width += isWide(codePoint) ? 2 : 1
  }
  return width
}

function displayValue(value) {
  if (value === null) return 'NULL'
  if (value === undefined) return '-'
  if (typeof value === 'string') return (value || '""').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function truncate(value, maxWidth) {
  if (displayWidth(value) <= maxWidth) return { value, truncated: false }
  let output = ''
  let width = 0
  const contentWidth = Math.max(1, maxWidth - 1)
  for (const character of value) {
    const characterWidth = displayWidth(character)
    if (width + characterWidth > contentWidth) break
    output += character
    width += characterWidth
  }
  return { value: output + '…', truncated: true }
}

function pad(value, width) {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)))
}

function renderTable(headers, rows, state, maxColumnWidth = MAX_COLUMN_WIDTH) {
  if (rows.length === 0) return '（无数据）'
  const values = rows.map((row) => headers.map((_, index) => displayValue(row[index])))
  const widths = headers.map((header, index) => Math.min(
    maxColumnWidth,
    Math.max(displayWidth(header), ...values.map((row) => displayWidth(row[index])))
  ))
  const renderRow = (row) => row.map((cell, index) => {
    const shortened = truncate(cell, widths[index])
    if (shortened.truncated) state.truncatedCells += 1
    return pad(shortened.value, widths[index])
  }).join('  ').trimEnd()
  return [
    renderRow(headers),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...values.map(renderRow)
  ].join('\n')
}

function yesNo(value) {
  return value ? '是' : '否'
}

function qualifiedName(value) {
  return [value?.schema, value?.name].filter(Boolean).join('.') || '-'
}

function section(title, content) {
  return `${title}\n${content}`
}

function formatCapabilities(data, state) {
  const rows = [
    ['协议版本', data.protocolVersion],
    ['数据库', Array.isArray(data.databases) ? data.databases.join(', ') : undefined],
    ['SQL 输入', Array.isArray(data.sqlInput) ? data.sqlInput.join(', ') : undefined],
    ['单次表数上限', data.maxTablesPerDescribe]
  ]
  const methods = Array.isArray(data.methods) ? data.methods.map((method) => [method]) : []
  return [
    section('safe db Agent CLI', renderTable(['能力', '值'], rows, state)),
    section('支持的方法', renderTable(['METHOD'], methods, state))
  ].join('\n\n')
}

function formatConnections(data, state) {
  const connections = Array.isArray(data.connections) ? data.connections : []
  const rows = connections.map((connection) => [
    connection.id,
    connection.name,
    connection.type,
    connection.defaultDatabase,
    connection.permissionMode,
    yesNo(connection.permissionModeLocked),
    yesNo(connection.sshEnabled)
  ])
  return `${renderTable(['ID', '名称', '类型', '默认数据库', '权限', '锁定', 'SSH'], rows, state)}\n\n共 ${connections.length} 个连接`
}

function connectionSummary(connection, database) {
  const parts = []
  if (connection?.name || connection?.id) parts.push(`连接：${connection.name ?? connection.id}`)
  if (connection?.type) parts.push(`类型：${connection.type}`)
  if (database) parts.push(`数据库：${database}`)
  return parts.join('  ')
}

function formatDatabases(data, state) {
  const databases = Array.isArray(data.databases) ? data.databases : []
  const rows = databases.map((database) => [database.name, yesNo(database.isDefault)])
  return [
    connectionSummary(data.connection),
    renderTable(['数据库', '默认'], rows, state),
    `共 ${databases.length} 个数据库`
  ].filter(Boolean).join('\n\n')
}

function formatObjects(data, state) {
  const objects = Array.isArray(data.objects) ? data.objects : []
  const rows = objects.map((object) => [
    object.schema,
    object.name,
    object.type,
    object.arguments,
    object.comment
  ])
  return [
    connectionSummary(data.connection, data.database),
    renderTable(['Schema', '名称', '类型', '参数', '备注'], rows, state),
    `共 ${objects.length} 个对象`
  ].filter(Boolean).join('\n\n')
}

function formatIndexes(indexes, state) {
  const rows = indexes.map((index) => [
    index.name,
    Array.isArray(index.columns) ? index.columns.join(', ') : undefined,
    yesNo(index.unique),
    yesNo(index.primary)
  ])
  return renderTable(['名称', '字段', '唯一', '主键'], rows, state)
}

function formatForeignKeys(foreignKeys, state) {
  const rows = foreignKeys.map((foreignKey) => [
    foreignKey.name,
    Array.isArray(foreignKey.columns) ? foreignKey.columns.join(', ') : undefined,
    [foreignKey.referencedSchema, foreignKey.referencedTable].filter(Boolean).join('.'),
    Array.isArray(foreignKey.referencedColumns) ? foreignKey.referencedColumns.join(', ') : undefined,
    foreignKey.onUpdate,
    foreignKey.onDelete
  ])
  return renderTable(['名称', '字段', '引用表', '引用字段', 'ON UPDATE', 'ON DELETE'], rows, state)
}

function formatChecks(checks, state) {
  return renderTable(
    ['名称', '表达式'],
    checks.map((check) => [check.name, check.expression]),
    state
  )
}

function formatTableDescription(table, state) {
  if (table.status === 'error') {
    const error = table.error ?? {}
    return `表：${qualifiedName(table)}\n读取失败 [${error.code ?? 'UNKNOWN'}]：${error.message ?? '未知错误'}`
  }
  const columns = Array.isArray(table.columns) ? table.columns : []
  const columnRows = columns.map((column) => [
    column.name,
    column.dataType,
    yesNo(column.nullable),
    yesNo(column.primaryKey),
    yesNo(column.autoIncrement),
    yesNo(column.generated),
    column.defaultValue,
    column.comment
  ])
  const parts = [
    `表：${qualifiedName(table)}${table.type ? `  类型：${table.type}` : ''}`,
    table.database ? `数据库：${table.database}` : '',
    table.comment ? `备注：${table.comment}` : '',
    renderTable(['字段', '类型', '可空', '主键', '自增', '生成', '默认值', '备注'], columnRows, state)
  ]
  const primaryKey = table.primaryKey
  if (primaryKey && Array.isArray(primaryKey.columns) && primaryKey.columns.length > 0) {
    parts.push(`主键：${primaryKey.name ?? '(未命名)'} (${primaryKey.columns.join(', ')})`)
  }
  if (Array.isArray(table.indexes) && table.indexes.length > 0) {
    parts.push(section('索引', formatIndexes(table.indexes, state)))
  }
  if (Array.isArray(table.foreignKeys) && table.foreignKeys.length > 0) {
    parts.push(section('外键', formatForeignKeys(table.foreignKeys, state)))
  }
  if (Array.isArray(table.checks) && table.checks.length > 0) {
    parts.push(section('CHECK 约束', formatChecks(table.checks, state)))
  }
  if (Array.isArray(table.metadataLimitations)) {
    for (const limitation of table.metadataLimitations) parts.push(`元数据提示：${limitation}`)
  }
  return parts.filter(Boolean).join('\n\n')
}

function formatTables(data, state) {
  const tables = Array.isArray(data.tables) ? data.tables : []
  const summary = data.summary
  const output = tables.map((table) => formatTableDescription(table, state))
  if (summary) {
    output.push(`汇总：请求 ${summary.requested ?? 0}，成功 ${summary.succeeded ?? 0}，失败 ${summary.failed ?? 0}`)
  }
  return output.length > 0 ? output.join('\n\n====================\n\n') : '（无表结构数据）'
}

function formatSqlCheck(data, state) {
  const decisionLabels = {
    allow: '允许',
    deny: '拒绝',
    approval_required: '需要审批'
  }
  const rows = [
    ['连接', data.connection?.name ?? data.connection?.id],
    ['权限模式', data.connection?.permissionMode],
    ['数据库', data.database],
    ['SQL 类型', data.classification],
    ['语句数', data.statementCount],
    ['权限决策', decisionLabels[data.decision] ?? data.decision],
    ['SQL 哈希', data.sqlHash]
  ]
  const statements = Array.isArray(data.statements)
    ? data.statements.map((statement, index) => [index + 1, statement.kind])
    : []
  return [
    renderTable(['检查项', '结果'], rows, state),
    statements.length > 1 ? section('语句分类', renderTable(['#', '类型'], statements, state)) : ''
  ].filter(Boolean).join('\n\n')
}

function resultColumns(result) {
  if (Array.isArray(result.columns) && result.columns.length > 0) {
    return result.columns.map((column) => typeof column === 'string' ? column : column.name)
  }
  const firstRow = Array.isArray(result.rows) ? result.rows[0] : undefined
  return firstRow && typeof firstRow === 'object' ? Object.keys(firstRow) : []
}

function formatExecuteResponse(data, state) {
  const results = Array.isArray(data?.results) ? data.results : []
  const parts = []
  if (data?.sqlKind) parts.push(`SQL 类型：${data.sqlKind}`)
  if (results.length === 0) parts.push('执行成功')
  results.forEach((result, index) => {
    const title = results.length > 1 ? `结果 ${index + 1}/${results.length}` : '查询结果'
    if (result.kind === 'rows') {
      const columns = resultColumns(result)
      const rows = Array.isArray(result.rows) ? result.rows : []
      const tableRows = rows.map((row) => columns.map((column) => row?.[column]))
      parts.push(section(title, `${renderTable(columns.length > 0 ? columns : ['结果'], tableRows, state)}\n\n${rows.length} 行`))
    } else {
      parts.push(`${title}：执行成功，影响 ${result.affectedRows ?? 0} 行`)
    }
  })
  if (typeof data?.durationMs === 'number') parts.push(`耗时：${data.durationMs} ms`)
  return parts.join('\n\n')
}

function formatApproval(response, state) {
  const data = response.data ?? {}
  if (response.status === 'approval_required') {
    return [
      '操作需要审批',
      `请求 ID：${data.requestId ?? '-'}`,
      `SQL 类型：${data.sqlKind ?? '-'}`,
      `有效期至：${data.expiresAt ?? '-'}`
    ].join('\n')
  }
  if (response.status === 'pending') {
    return `正在等待审批\n请求 ID：${data.requestId ?? '-'}\n有效期至：${data.expiresAt ?? '-'}`
  }
  if (response.status === 'denied') {
    return `操作已拒绝${data.sqlKind ? `\nSQL 类型：${data.sqlKind}` : ''}`
  }
  if (response.status === 'completed') {
    return [
      '审批已通过，操作已完成',
      `请求 ID：${data.requestId ?? '-'}`,
      formatExecuteResponse(data.result, state)
    ].filter(Boolean).join('\n\n')
  }
  return ''
}

function formatError(response) {
  const error = response?.error ?? {}
  const lines = [`错误 [${error.code ?? 'UNKNOWN'}]：${error.message ?? '未知错误'}`]
  if (error.retryable) lines.push('该错误可能可以重试。')
  if (error.details !== undefined) lines.push(`详情：${JSON.stringify(error.details, null, 2)}`)
  return lines.join('\n')
}

export function formatHumanResponse(response, method) {
  if (!response || typeof response !== 'object') return '错误 [INVALID_RESPONSE]：safe db 返回了无效响应'
  if (response.status === 'error') return formatError(response)

  const state = { truncatedCells: 0 }
  const approval = formatApproval(response, state)
  let output = approval
  if (!output) {
    const data = response.data ?? {}
    switch (method) {
      case 'capabilities':
        output = formatCapabilities(data, state)
        break
      case 'connection.list':
        output = formatConnections(data, state)
        break
      case 'database.list':
        output = formatDatabases(data, state)
        break
      case 'object.list':
        output = formatObjects(data, state)
        break
      case 'object.ddl':
        output = typeof data.ddl === 'string' && data.ddl ? data.ddl.trimEnd() : '（DDL 为空）'
        break
      case 'table.describe':
        output = formatTables(data, state)
        break
      case 'sql.check':
        output = formatSqlCheck(data, state)
        break
      case 'sql.run':
        output = formatExecuteResponse(data, state)
        break
      case 'request.get':
      case 'request.wait':
        output = `请求状态：${response.status}`
        break
      default:
        output = JSON.stringify(data, null, 2)
    }
  }

  const notes = []
  if (state.truncatedCells > 0) {
    notes.push(`提示：${state.truncatedCells} 个单元格因内容过长已省略；使用 --format json 查看完整值。`)
  }
  if (Array.isArray(response.warnings)) {
    for (const warning of response.warnings) notes.push(`警告 [${warning.code}]：${warning.message}`)
  }
  return [output, ...notes].filter(Boolean).join('\n\n')
}

export function formatResponse(response, method, format) {
  if (format === 'pretty') return JSON.stringify(response, null, 2)
  if (format === 'human') return formatHumanResponse(response, method)
  return JSON.stringify(response)
}
