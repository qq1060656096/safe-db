import type { ConnectionMeta } from '../../shared/types'
import type { AppTab } from './stores/app'

export type ObjectDefinitionKind = 'view' | 'function' | 'procedure'

export interface ObjectDefinitionTarget {
  connectionId: string
  database: string
  schema?: string
  name: string
  kind: ObjectDefinitionKind
  arguments?: string
}

interface ObjectDefinitionTabStore {
  tabs: AppTab[]
  setActiveTab(id: string): void
  openTab(tab: Omit<AppTab, 'id'>): string
}

function quoteIdentifier(type: ConnectionMeta['type'], name: string): string {
  if (type === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (type === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}

function qualifiedObject(connection: ConnectionMeta, target: ObjectDefinitionTarget): string {
  if (connection.type === 'mysql') return `${quoteIdentifier(connection.type, target.database)}.${quoteIdentifier(connection.type, target.name)}`
  if (connection.type === 'postgres') return `${quoteIdentifier(connection.type, target.schema ?? 'public')}.${quoteIdentifier(connection.type, target.name)}`
  if (connection.type === 'sqlserver') return `${quoteIdentifier(connection.type, target.schema ?? 'dbo')}.${quoteIdentifier(connection.type, target.name)}`
  return quoteIdentifier(connection.type, target.name)
}

function editableDefinitionSql(connection: ConnectionMeta, target: ObjectDefinitionTarget, code: string): string {
  const normalized = code.trim()
  if (target.kind === 'view') {
    if (connection.type === 'mysql' || connection.type === 'postgres') {
      return /^CREATE\s+OR\s+REPLACE\b/i.test(normalized)
        ? normalized
        : normalized.replace(/^CREATE\b/i, 'CREATE OR REPLACE')
    }
    if (connection.type === 'sqlserver') {
      return normalized.replace(/^CREATE(?:\s+OR\s+ALTER)?\b/i, 'CREATE OR ALTER')
    }
    if (connection.type === 'sqlite') return `DROP VIEW ${qualifiedObject(connection, target)};\n${normalized}`
    return normalized
  }
  if (connection.type === 'postgres') return normalized
  if (connection.type === 'sqlserver') {
    const altered = normalized.replace(/^CREATE(?:\s+OR\s+ALTER)?\b/i, 'CREATE OR ALTER').replace(/;\s*$/, '')
    return `DELIMITER $$\n${altered}$$\nDELIMITER ;`
  }
  if (connection.type === 'mysql') {
    const keyword = target.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
    return `DROP ${keyword} IF EXISTS ${qualifiedObject(connection, target)};\nDELIMITER $$\n${normalized.replace(/;\s*$/, '')}$$\nDELIMITER ;`
  }
  return normalized
}

export async function loadObjectDefinition(target: ObjectDefinitionTarget): Promise<string> {
  return target.kind === 'view'
    ? window.api.getObjectDdl(target.connectionId, target.database, target.name, target.schema)
    : window.api.getRoutineDefinition(target.connectionId, target.database, target.name, target.kind, target.schema, target.arguments)
}

export function openObjectDefinitionTab(
  store: ObjectDefinitionTabStore,
  connection: ConnectionMeta,
  target: ObjectDefinitionTarget,
  code: string,
  readOnly: boolean,
  title: string
): void {
  const existing = store.tabs.find((tab: AppTab) => tab.type === 'query' && tab.definitionEditor
    && Boolean(tab.definitionReadOnly) === readOnly
    && tab.connectionId === target.connectionId && tab.database === target.database
    && tab.schema === target.schema && tab.definitionKind === target.kind
    && tab.table === (target.kind === 'view' ? target.name : undefined)
    && tab.routine === (target.kind === 'view' ? undefined : target.name)
    && tab.routineArguments === target.arguments)
  if (existing) {
    store.setActiveTab(existing.id)
    return
  }

  const replaceMode = (connection.type === 'sqlite' && target.kind === 'view')
    || (connection.type === 'mysql' && target.kind !== 'view')
    ? 'drop-create' as const
    : 'replace' as const
  store.openTab({
    type: 'query',
    title,
    connectionId: target.connectionId,
    database: target.database,
    schema: target.schema,
    table: target.kind === 'view' ? target.name : undefined,
    routine: target.kind === 'view' ? undefined : target.name,
    routineType: target.kind === 'view' ? undefined : target.kind,
    routineArguments: target.arguments,
    definitionEditor: true,
    definitionReadOnly: readOnly,
    definitionKind: target.kind,
    definitionReplaceMode: readOnly ? undefined : replaceMode,
    sql: readOnly ? code.trim() : editableDefinitionSql(connection, target, code)
  })
}
