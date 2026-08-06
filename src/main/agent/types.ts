import type { AgentApprovalRequest, ExecuteResponse } from '../../shared/types'

export const AGENT_PROTOCOL_VERSION = '1'

export type AgentMethod =
  | 'capabilities'
  | 'connection.list'
  | 'database.list'
  | 'object.list'
  | 'object.ddl'
  | 'table.describe'
  | 'sql.check'
  | 'sql.run'
  | 'request.get'
  | 'request.wait'

export interface AgentRequestEnvelope {
  protocolVersion: string
  requestId: string
  method: AgentMethod
  params: Record<string, unknown>
}

export type AgentResponseStatus = 'ok' | 'partial' | 'approval_required' | 'pending' | 'completed' | 'denied' | 'error'

export interface AgentErrorBody {
  code: string
  message: string
  retryable: boolean
  details?: unknown
}

export interface AgentResponseEnvelope {
  protocolVersion: string
  requestId: string
  status: AgentResponseStatus
  data?: unknown
  error?: AgentErrorBody
  warnings?: { code: string; message: string }[]
}

export interface AgentServiceResult {
  status: AgentResponseStatus
  data?: unknown
  warnings?: { code: string; message: string }[]
}

export interface StoredAgentRequest extends AgentApprovalRequest {
  status: 'pending' | 'completed' | 'denied' | 'expired'
  result?: ExecuteResponse
}
