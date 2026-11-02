import type { DbType } from './types'

const systemDatabases: Partial<Record<DbType, readonly string[]>> = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  postgres: ['postgres', 'template0', 'template1'],
  sqlserver: ['master', 'model', 'msdb', 'tempdb'],
  mongodb: ['admin', 'local', 'config']
}

/** 系统库保护在菜单和主进程使用同一规则，不能通过 IPC 绕过。 */
export function isSystemDatabase(type: DbType, database: string): boolean {
  const name = type === 'mysql' || type === 'sqlserver' ? database.toLowerCase() : database
  return systemDatabases[type]?.includes(name) ?? false
}
