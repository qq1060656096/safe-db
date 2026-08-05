import type { PermissionMode, SqlKind } from '../../shared/types'

export type PermissionDecision = 'allow' | 'deny' | 'needsApproval'

/**
 * 权限判定:
 * - READ / OTHER(会话级):所有模式放行
 * - 完全访问:一切放行
 * - 审批:WRITE / DDL 需要本地二次确认
 * - 只读:WRITE / DDL 直接拒绝
 */
export function decide(mode: PermissionMode, kind: SqlKind): PermissionDecision {
  if (kind === 'READ' || kind === 'OTHER') return 'allow'
  if (mode === 'full') return 'allow'
  if (mode === 'approval') return 'needsApproval'
  return 'deny'
}
