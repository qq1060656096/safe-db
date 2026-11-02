import type { DbType, DriverCapabilities, OperationSupport } from '../../shared/types'

const native = (options: Omit<Extract<OperationSupport, { supported: true }>, 'supported' | 'mode'> = {}): OperationSupport => ({
  supported: true,
  mode: 'native',
  ...options
})
const emulated = (options: Omit<Extract<OperationSupport, { supported: true }>, 'supported' | 'mode'> = {}): OperationSupport => ({
  supported: true,
  mode: 'emulated',
  ...options
})
const unavailable = (reason: string): OperationSupport => ({ supported: false, reason })

const relationalKinds: DriverCapabilities['objectKinds'] = ['database', 'schema', 'table', 'view', 'routine']

function sqlCapabilities(type: Extract<DbType, 'mysql' | 'postgres' | 'sqlite' | 'sqlserver'>): DriverCapabilities {
  const sqlite = type === 'sqlite'
  return {
    recordModel: 'row',
    recordTargetKind: 'table',
    databases: {
      create: sqlite ? unavailable('SQLite 数据库通过本地文件创建') : native(),
      drop: sqlite ? unavailable('SQLite 数据库是本地文件，不支持 DROP DATABASE') : native()
    },
    objectKinds: sqlite ? ['database', 'table', 'view'] : relationalKinds,
    records: {
      read: native(), insert: native({ requiresKey: false }), update: native({ requiresKey: true }),
      delete: native({ requiresKey: true }), clear: native(), bulkImport: native({ maxBatchSize: 50_000 }),
      pagination: 'offset'
    },
    objects: { create: native(), drop: native(), copy: emulated() },
    definition: { read: native(), update: native() },
    indexes: { list: native(), create: native(), drop: native() },
    atomicity: 'transaction',
    structuredOperations: true
  }
}

export function capabilitiesForType(type: DbType): DriverCapabilities {
  if (type === 'mysql' || type === 'postgres' || type === 'sqlite' || type === 'sqlserver') {
    return sqlCapabilities(type)
  }
  if (type === 'qdrant') {
    return {
      recordModel: 'point',
      recordTargetKind: 'collection',
      databases: { create: unavailable('Qdrant 没有数据库层级'), drop: unavailable('Qdrant 没有数据库层级') },
      objectKinds: ['collection', 'payloadIndex'],
      records: {
        read: native(), insert: native({ maxBatchSize: 1_000 }), update: native({ requiresKey: true, maxBatchSize: 1_000 }),
        delete: native({ requiresKey: true, maxBatchSize: 1_000 }), clear: native(),
        bulkImport: native({ maxBatchSize: 50_000 }), pagination: 'cursor'
      },
      objects: { create: native(), drop: native(), copy: unavailable('Qdrant Collection 复制需要多阶段迁移，当前未开放') },
      definition: { read: native(), update: unavailable('Collection 定义需要按可变配置拆分后更新') },
      indexes: { list: native(), create: native(), drop: native() },
      // Point 批量变更可能拆成多个 REST 请求；单请求操作会在实际结果中单独标明。
      atomicity: 'best-effort',
      structuredOperations: true
    }
  }
  if (type === 'mongodb') {
    return {
      recordModel: 'document',
      recordTargetKind: 'collection',
      databases: { create: unavailable('MongoDB 数据库在首次创建 Collection 或写入时隐式创建'), drop: native() },
      objectKinds: ['database', 'collection'],
      records: {
        read: native(), insert: native({ maxBatchSize: 50_000 }), update: native({ requiresKey: true, maxBatchSize: 50_000 }),
        delete: native({ requiresKey: true, maxBatchSize: 50_000 }), clear: native(),
        bulkImport: native({ maxBatchSize: 50_000 }), pagination: 'offset'
      },
      objects: { create: native(), drop: native(), copy: emulated() },
      definition: { read: native(), update: unavailable('Collection 校验器变更尚未接入设计器') },
      indexes: { list: native(), create: native(), drop: native() },
      atomicity: 'best-effort', structuredOperations: true
    }
  }
  return {
    recordModel: 'key-entry',
    recordTargetKind: 'key',
    databases: {
      create: unavailable('Redis 逻辑数据库由服务端配置决定'),
      drop: unavailable('Redis 逻辑数据库不能删除，清空数据需使用 FLUSHDB')
    },
    objectKinds: ['database', 'key'],
    records: {
      read: native(), insert: native({ maxBatchSize: 50_000 }), update: native({ requiresKey: true, maxBatchSize: 50_000 }),
      delete: native({ requiresKey: true, maxBatchSize: 50_000 }),
      clear: unavailable('Redis 不存在可保留结构的空 Key；请删除 Key 或逐条删除成员'),
      bulkImport: native({ maxBatchSize: 50_000 }), pagination: 'offset'
    },
    objects: { create: native(), drop: native(), copy: emulated() },
    definition: { read: native(), update: unavailable('Redis Key 类型不可原地修改') },
    indexes: { list: unavailable('Redis 没有通用索引对象'), create: unavailable('Redis 没有通用索引对象'), drop: unavailable('Redis 没有通用索引对象') },
    atomicity: 'best-effort', structuredOperations: true
  }
}
