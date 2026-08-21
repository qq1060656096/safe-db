import type {
  DatabaseObjectRef,
  DatabaseOperation,
  DriverCapabilities,
  OperationSupport
} from '../../shared/types'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function assertName(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) {
    throw new Error(`${label}无效`)
  }
}

function assertSerializable(value: unknown, depth = 0, budget = { remaining: 1_000_000 }): void {
  if (depth > 32 || --budget.remaining < 0) throw new Error('结构化操作数据过大')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('结构化操作不能包含非有限数字')
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSerializable(item, depth + 1, budget)
    return
  }
  const object = record(value)
  if (!object) throw new Error('结构化操作包含不支持的值')
  for (const [key, item] of Object.entries(object)) {
    assertName(key, '字段名')
    assertSerializable(item, depth + 1, budget)
  }
}

function assertTarget(value: unknown): asserts value is DatabaseObjectRef {
  const target = record(value)
  if (!target || !['table', 'collection', 'key'].includes(String(target.kind))) throw new Error('操作目标类型无效')
  assertName(target.name, '操作目标名称')
  if (target.database !== undefined) assertName(target.database, '数据库名称')
  if (target.schema !== undefined) assertName(target.schema, 'Schema 名称')
}

export function assertDatabaseOperation(value: unknown): asserts value is DatabaseOperation {
  const operation = record(value)
  if (!operation || typeof operation.kind !== 'string') throw new Error('结构化操作无效')
  // 先约束整个 IPC 输入，未知字段也不能绕过深度和体积限制。
  assertSerializable(operation)
  if (operation.kind === 'records.mutate') {
    assertTarget(operation.target)
    if (!Array.isArray(operation.mutations) || operation.mutations.length === 0) throw new Error('记录变更不能为空')
    if (operation.mutations.length > 50_000) throw new Error('单次最多执行 50000 条记录变更')
    for (const value of operation.mutations) {
      const mutation = record(value)
      if (!mutation || !['insert', 'update', 'delete'].includes(String(mutation.kind))) throw new Error('记录变更类型无效')
      if (mutation.kind === 'insert') {
        const values = record(mutation.values)
        if (!values || !Object.keys(values).length) throw new Error('新增记录不能为空')
        assertSerializable(values)
      } else {
        const key = record(mutation.key)
        if (!key || !Object.keys(key).length) throw new Error('修改或删除记录必须提供定位键')
        assertSerializable(key)
        if (mutation.kind === 'update') {
          const changes = record(mutation.changes)
          if (!changes || !Object.keys(changes).length) throw new Error('记录修改内容不能为空')
          assertSerializable(changes)
        }
      }
    }
    return
  }
  if (operation.kind === 'records.clear' || operation.kind === 'object.drop') {
    assertTarget(operation.target)
    return
  }
  if (operation.kind === 'object.create') {
    if (!['database', 'table', 'collection', 'key'].includes(String(operation.objectType))) throw new Error('对象类型无效')
    assertName(operation.name, '对象名称')
    if (operation.database !== undefined) assertName(operation.database, '数据库名称')
    if (operation.schema !== undefined) assertName(operation.schema, 'Schema 名称')
    if (!record(operation.definition)) throw new Error('对象定义无效')
    assertSerializable(operation.definition)
    return
  }
  if (operation.kind === 'object.alter') {
    assertTarget(operation.target)
    if (operation.target.kind !== 'table') throw new Error('只有表对象支持结构变更')
    if (!Array.isArray(operation.changes) || operation.changes.length === 0) throw new Error('表结构变更不能为空')
    if (operation.changes.length > 1_000) throw new Error('单次最多执行 1000 个表结构变更')
    for (const value of operation.changes) {
      const change = record(value)
      if (!change || !['add', 'drop', 'alter'].includes(String(change.kind))) throw new Error('表结构变更类型无效')
      if (change.kind === 'drop') assertName(change.name, '列名')
      else {
        if (change.kind === 'alter') assertName(change.previousName, '原列名')
        const column = record(change.column)
        if (!column) throw new Error('列定义无效')
        assertName(column.name, '列名')
        assertName(column.dataType, '数据类型')
        if (typeof column.nullable !== 'boolean') throw new Error('列 nullable 无效')
      }
    }
    return
  }
  if (operation.kind === 'object.copy') {
    assertTarget(operation.source)
    assertName(operation.targetName, '目标对象名称')
    if (typeof operation.withData !== 'boolean') throw new Error('复制数据选项无效')
    return
  }
  if (operation.kind === 'index.create' || operation.kind === 'index.drop') {
    assertTarget(operation.target)
    assertName(operation.name, '索引名称')
    if (operation.kind === 'index.create') {
      if (!record(operation.definition)) throw new Error('索引定义无效')
      assertSerializable(operation.definition)
    }
    return
  }
  throw new Error(`不支持的结构化操作：${operation.kind}`)
}

function assertDomainTarget(capabilities: DriverCapabilities, target: DatabaseObjectRef, action: string): void {
  if (target.kind !== capabilities.recordTargetKind) {
    throw new Error(`${action}目标必须是 ${capabilities.recordTargetKind}，实际为 ${target.kind}`)
  }
  if (!capabilities.objectKinds.includes(target.kind)) {
    throw new Error(`当前驱动未声明 ${target.kind} 对象能力`)
  }
}

/**
 * 把领域目标校验与能力选择收敛在主进程，避免调用方仅凭一个 supported=true
 * 就把 Collection/Key 操作误投递给关系型表驱动，或反向投递。
 */
export function operationSupports(
  capabilities: DriverCapabilities,
  operation: DatabaseOperation
): OperationSupport[] {
  if (!capabilities.structuredOperations) throw new Error('当前驱动尚未开放结构化操作')
  if (operation.kind === 'records.mutate') {
    assertDomainTarget(capabilities, operation.target, '记录变更')
    const supports: OperationSupport[] = []
    if (operation.mutations.some((item) => item.kind === 'insert')) supports.push(capabilities.records.insert)
    if (operation.mutations.some((item) => item.kind === 'update')) supports.push(capabilities.records.update)
    if (operation.mutations.some((item) => item.kind === 'delete')) supports.push(capabilities.records.delete)
    if (operation.mutations.length > 1 && operation.mutations.every((item) => item.kind === 'insert')) {
      supports.push(capabilities.records.bulkImport)
    }
    return supports
  }
  if (operation.kind === 'records.clear') {
    assertDomainTarget(capabilities, operation.target, '清空记录')
    return [capabilities.records.clear]
  }
  if (operation.kind === 'object.create') {
    if (operation.objectType === 'database') return [capabilities.databases.create]
    if (operation.objectType !== capabilities.recordTargetKind) {
      throw new Error(`当前驱动只能创建 ${capabilities.recordTargetKind} 对象`)
    }
    if (!capabilities.objectKinds.includes(operation.objectType)) {
      throw new Error(`当前驱动未声明 ${operation.objectType} 对象能力`)
    }
    return [capabilities.objects.create]
  }
  if (operation.kind === 'object.alter') {
    assertDomainTarget(capabilities, operation.target, '结构变更')
    return [capabilities.definition.update]
  }
  if (operation.kind === 'object.copy') {
    assertDomainTarget(capabilities, operation.source, '复制对象')
    return [capabilities.objects.copy]
  }
  if (operation.kind === 'object.drop') {
    assertDomainTarget(capabilities, operation.target, '删除对象')
    return [capabilities.objects.drop]
  }
  if (operation.kind === 'index.create') {
    assertDomainTarget(capabilities, operation.target, '创建索引')
    return [capabilities.indexes.create]
  }
  assertDomainTarget(capabilities, operation.target, '删除索引')
  return [capabilities.indexes.drop]
}

export function databaseOperationKind(operation: DatabaseOperation): 'WRITE' | 'DDL' {
  return operation.kind === 'records.mutate' || operation.kind === 'records.clear' ? 'WRITE' : 'DDL'
}

export function databaseOperationPreview(operation: DatabaseOperation): string {
  const compact = (value: unknown, depth = 0): unknown => {
    if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…<${value.length} chars>` : value
    if (Array.isArray(value)) {
      if (value.length <= 20) return value.map((item) => compact(item, depth + 1))
      return [...value.slice(0, 20).map((item) => compact(item, depth + 1)), `<${value.length - 20} more items>`]
    }
    const object = record(value)
    if (!object || depth > 8) return value
    const entries = Object.entries(object)
    const result = Object.fromEntries(entries.slice(0, 50).map(([key, item]) => [key, compact(item, depth + 1)]))
    if (entries.length > 50) result.__omittedFields = entries.length - 50
    return result
  }
  if (operation.kind !== 'records.mutate' || operation.mutations.length <= 10) {
    return JSON.stringify(compact(operation), null, 2)
  }
  const counts = { insert: 0, update: 0, delete: 0 }
  for (const mutation of operation.mutations) counts[mutation.kind] += 1
  return JSON.stringify(compact({
    kind: operation.kind,
    target: operation.target,
    summary: { total: operation.mutations.length, ...counts },
    sample: operation.mutations.slice(0, 3),
    omittedMutations: operation.mutations.length - 3
  }), null, 2)
}
