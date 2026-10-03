import type {
  BatchItem,
  BatchReceipt,
  ExecutionBatch,
  IdentityCheck,
  PrivacyRequest,
  RequestStatus,
  RequestType,
  WorkspaceState,
} from '@/types/domain'
import { computeScopeHash, getBatchConclusion, isItemScopeCurrent, latestItemForSystem } from './batchService'
import { addDays, buildWorkflowSteps, responseDays } from './workflow'

const cloneState = (state: WorkspaceState): WorkspaceState => structuredClone(state)
const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

function digest(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `PD-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function appendAudit(
  state: WorkspaceState,
  request: PrivacyRequest,
  action: string,
  operator: string,
  detail: string,
) {
  const entry = {
    id: id('audit'),
    requestId: request.id,
    action,
    operator,
    detail,
    createdAt: now(),
  }
  state.audit.unshift(entry)
  request.audit.unshift({
    id: entry.id,
    action,
    operator,
    detail,
    createdAt: entry.createdAt,
  })
}

function mutateRequest(
  state: WorkspaceState,
  requestId: string,
  mutation: (request: PrivacyRequest, draft: WorkspaceState) => void,
  audit:
    | { action: string; operator: string; detail: string }
    | (() => { action: string; operator: string; detail: string }),
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  mutation(request, draft)
  const resolved = typeof audit === 'function' ? audit() : audit
  appendAudit(draft, request, resolved.action, resolved.operator, resolved.detail)
  draft.revision += 1
  return draft
}

function refreshBatchStatus(batch: ExecutionBatch) {
  if (batch.items.some((item) => item.status === 'sent')) {
    batch.status = 'in-flight'
    return
  }
  batch.settledAt = batch.settledAt ?? now()
  batch.status = batch.items.some((item) => item.status === 'superseded') ? 'superseded' : 'settled'
}

function executeTaskName(type: RequestType, systemName: string): string {
  return `${type === 'deletion' ? '执行删除' : type === 'rectification' ? '执行更正' : '执行请求'}：${systemName}`
}

function ensureExecuteTask(request: PrivacyRequest, draft: WorkspaceState, systemId: string): string {
  const taskId = `${request.id}-execute-${systemId}`
  if (request.tasks.some((task) => task.id === taskId)) return taskId
  const system = draft.systems.find((item) => item.id === systemId)
  request.tasks.push({
    id: taskId,
    order: request.tasks.length + 1,
    name: executeTaskName(request.type, system?.name ?? systemId),
    role: system?.owner ?? '数据管理员',
    systemId,
    status: 'pending',
    assignee: system?.owner ?? '数据管理员',
    dueAt: request.dueAt,
    exceptionReason: '',
  })
  return taskId
}

interface DispatchInfo {
  sequence: number
  itemCount: number
  retried: number
  superseded: number
}

/**
 * 派发新批次：只覆盖未结清的系统（失败、作废、未派发或范围已过期），
 * 已成功的回执与完成时间保持不动；旧范围的在途项作废，等迟到回执转入复核。
 */
function dispatchBatchInternal(
  request: PrivacyRequest,
  draft: WorkspaceState,
  operator: string,
): DispatchInfo {
  if (['completed', 'rejected'].includes(request.status)) {
    throw new Error('请求已关闭，不能派发执行批次')
  }
  if (request.identity.status !== 'verified') {
    throw new Error('身份核验通过后才能派发执行批次')
  }
  if (!request.affectedSystemIds.length) {
    throw new Error('请求未关联任何系统，不能派发执行批次')
  }
  const scopeHash = computeScopeHash(request)
  const conclusion = getBatchConclusion(request, draft.systems)
  const pending = conclusion.systems.filter(
    (item) =>
      item.state === 'failed' ||
      item.state === 'superseded' ||
      item.state === 'not-dispatched' ||
      item.stale,
  )
  if (!pending.length) {
    if (conclusion.allSucceeded) throw new Error('全部系统均已成功结清，无需派发新批次')
    throw new Error('在途回执尚未返回，且没有需要重试的失败项')
  }
  let superseded = 0
  for (const batch of request.batches) {
    for (const item of batch.items) {
      if (item.status === 'sent' && !isItemScopeCurrent(request, batch, item)) {
        item.status = 'superseded'
        item.updatedAt = now()
        superseded += 1
      }
    }
    refreshBatchStatus(batch)
  }
  const sequence = request.batches.reduce((max, batch) => Math.max(max, batch.sequence), 0) + 1
  const batchId = id('batch')
  const items: BatchItem[] = pending.map((entry) => {
    const taskId = ensureExecuteTask(request, draft, entry.systemId)
    const task = request.tasks.find((item) => item.id === taskId)
    const previous = latestItemForSystem(request, entry.systemId)
    if (task && task.status === 'blocked') {
      task.status = 'active'
      task.exceptionReason = ''
    }
    return {
      id: id('batch-item'),
      batchId,
      systemId: entry.systemId,
      taskId,
      attempt: (previous?.item.attempt ?? 0) + 1,
      status: 'sent' as const,
      retryOfItemId: previous?.item.id,
      failureReason: '',
      updatedAt: now(),
    }
  })
  request.batches.push({
    id: batchId,
    requestId: request.id,
    sequence,
    scopeHash,
    scopeSnapshot: {
      type: request.type,
      systemIds: [...request.affectedSystemIds],
      taskIds: items.map((item) => item.taskId),
    },
    status: 'in-flight',
    dispatchedAt: now(),
    dispatchedBy: operator,
    items,
  })
  return {
    sequence,
    itemCount: items.length,
    retried: items.filter((item) => item.retryOfItemId).length,
    superseded,
  }
}

export interface CreateRequestInput {
  requesterName: string
  requesterContact: string
  region: keyof typeof responseDays
  type: RequestType
  affectedSystemIds: string[]
  identityMaterialType: IdentityCheck['materialType']
  identityReference: string
  note: string
}

export function createRequest(
  state: WorkspaceState,
  input: CreateRequestInput,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const requestedAt = now()
  const dueAt = addDays(new Date(requestedAt), responseDays[input.region]).toISOString()
  const duplicate = draft.requests.find(
    (request) =>
      request.requesterContact === input.requesterContact &&
      request.type === input.type &&
      !['completed', 'rejected'].includes(request.status),
  )
  const identityInsufficient =
    input.identityMaterialType === 'none' || input.identityReference.trim().length < 6
  const status: RequestStatus = identityInsufficient || duplicate ? 'review-required' : 'identity-review'
  const nextNumber =
    Math.max(
      0,
      ...draft.requests.map((request) => Number(request.code.split('-').at(-1)) || 0),
    ) + 1
  const requestId = id('request')
  const request: PrivacyRequest = {
    id: requestId,
    code: `DSR-2026-${String(nextNumber).padStart(3, '0')}`,
    requesterName: input.requesterName.trim(),
    requesterContact: input.requesterContact.trim(),
    region: input.region,
    type: input.type,
    status,
    identity: {
      status: identityInsufficient ? 'insufficient' : 'pending',
      materialType: input.identityMaterialType,
      maskedReference: input.identityReference.trim(),
      protectedDigest: digest(input.identityReference),
      note: input.note.trim(),
    },
    requestedAt,
    dueAt,
    extendedDays: 0,
    duplicateOf: duplicate?.code,
    affectedSystemIds: [...input.affectedSystemIds],
    tasks: buildWorkflowSteps({
      requestId,
      type: input.type,
      systemIds: input.affectedSystemIds,
      requestedAt,
      dueAt,
      initialStatus: 'identity-review',
      systems: draft.systems,
    }),
    batches: [],
    evidence: [],
    conflicts: [],
    resultSummary: '',
    closureReason: '',
    audit: [],
  }
  if (identityInsufficient) {
    request.conflicts.push('身份材料不足：需要补充可核验的身份或授权关系证明。')
    const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
    if (identityTask) {
      identityTask.status = 'blocked'
      identityTask.exceptionReason = '身份材料不足，等待复核。'
    }
  }
  if (duplicate) {
    request.conflicts.push(`疑似重复请求：与 ${duplicate.code} 的请求人和请求类型相同。`)
  }
  draft.requests.unshift(request)
  appendAudit(
    draft,
    request,
    '登记隐私请求',
    operator,
    `按 ${responseDays[input.region]} 日模板登记，涉及 ${input.affectedSystemIds.length} 个系统。`,
  )
  draft.revision += 1
  return draft
}

export function saveRequest(
  state: WorkspaceState,
  requestId: string,
  patch: Partial<PrivacyRequest>,
  operator: string,
): WorkspaceState {
  let scopeNote = ''
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const scopeChanged =
        (patch.affectedSystemIds !== undefined &&
          JSON.stringify([...patch.affectedSystemIds].sort()) !==
            JSON.stringify([...request.affectedSystemIds].sort())) ||
        (patch.type !== undefined && patch.type !== request.type)
      Object.assign(request, patch)
      request.audit = request.audit
      if (scopeChanged) {
        const inFlight = request.batches.reduce(
          (total, batch) => total + batch.items.filter((item) => item.status === 'sent').length,
          0,
        )
        scopeNote = inFlight
          ? `范围已更新：${inFlight} 项在途回执将按新范围校验，迟到回执作废并转入复核。`
          : '范围已更新：后续批次按新范围派发。'
      }
    },
    () => ({
      action: '更新请求信息',
      operator,
      detail: `更新申请人、地区、请求类型或涉及系统。${scopeNote}`,
    }),
  )
}

export function verifyIdentity(
  state: WorkspaceState,
  requestId: string,
  status: 'verified' | 'insufficient',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request, draft) => {
      request.identity.status = status
      request.identity.note = note
      request.identity.reviewedAt = now()
      const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
      if (status === 'verified') {
        if (identityTask) {
          identityTask.status = 'completed'
          identityTask.completedAt = now()
          identityTask.exceptionReason = ''
        }
        request.conflicts = request.conflicts.filter(
          (conflict) => !conflict.startsWith('身份材料不足'),
        )
        const nextTask = request.tasks.find((task) => task.status === 'pending')
        if (nextTask) nextTask.status = 'active'
        request.status = request.conflicts.length ? 'review-required' : 'processing'
        if (!request.conflicts.length && !request.batches.length && request.affectedSystemIds.length) {
          const info = dispatchBatchInternal(request, draft, operator)
          appendAudit(
            draft,
            request,
            '派发执行批次',
            operator,
            `身份核验通过后自动派发第 ${info.sequence} 批，覆盖 ${info.itemCount} 个系统。`,
          )
        }
      } else {
        if (identityTask) {
          identityTask.status = 'blocked'
          identityTask.exceptionReason = note
        }
        request.status = 'review-required'
        if (!request.conflicts.some((conflict) => conflict.startsWith('身份材料不足'))) {
          request.conflicts.push(`身份材料不足：${note}`)
        }
      }
    },
    {
      action: status === 'verified' ? '身份核验通过' : '身份材料退回',
      operator,
      detail: note,
    },
  )
}

export function assignTask(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  assignee: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      task.assignee = assignee
    },
    { action: '分派履约任务', operator, detail: `任务 ${taskId} 分派给 ${assignee}。` },
  )
}

export function taskAction(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  action: 'start' | 'complete' | 'block',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份未核验通过，不能推进履约任务')
      }
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      if (action === 'start') {
        task.status = 'active'
        task.exceptionReason = ''
      } else if (action === 'complete') {
        const openItem = request.batches
          .flatMap((batch) => batch.items)
          .find((item) => item.taskId === task.id && item.status === 'sent')
        if (openItem) {
          throw new Error('该系统已纳入执行批次等待回执，请登记系统回执而非手动完成')
        }
        task.status = 'completed'
        task.completedAt = now()
        task.exceptionReason = ''
        const nextTask = request.tasks.find((item) => item.status === 'pending')
        if (nextTask) nextTask.status = 'active'
      } else {
        task.status = 'blocked'
        task.exceptionReason = note
        request.status = 'review-required'
        request.conflicts.push(`任务阻塞：${task.name}，${note}`)
      }
      const executableTasks = request.tasks.filter((item) => !item.id.endsWith('-close'))
      if (executableTasks.every((item) => item.status === 'completed')) {
        request.status = 'pending-close'
      } else if (action !== 'block') {
        request.status = 'processing'
      }
    },
    {
      action:
        action === 'start' ? '开始履约任务' : action === 'complete' ? '完成履约任务' : '阻断履约任务',
      operator,
      detail: note || `${taskId} 状态更新为 ${action}。`,
    },
  )
}

export function dispatchBatch(
  state: WorkspaceState,
  requestId: string,
  operator: string,
): WorkspaceState {
  let info: DispatchInfo = { sequence: 0, itemCount: 0, retried: 0, superseded: 0 }
  return mutateRequest(
    state,
    requestId,
    (request, draft) => {
      info = dispatchBatchInternal(request, draft, operator)
      if (!request.conflicts.length) request.status = 'processing'
    },
    () => ({
      action: '派发执行批次',
      operator,
      detail:
        `第 ${info.sequence} 批覆盖 ${info.itemCount} 个系统` +
        `${info.retried ? `，其中重试 ${info.retried} 项` : ''}` +
        `${info.superseded ? `，${info.superseded} 项旧范围在途回执作废` : ''}` +
        '；已成功的回执与完成时间保持不变。',
    }),
  )
}

export function recordReceipt(
  state: WorkspaceState,
  requestId: string,
  itemId: string,
  outcome: 'success' | 'failure',
  failureReason: string,
  operator: string,
): WorkspaceState {
  let auditAction = '登记系统回执'
  let auditDetail = ''
  return mutateRequest(
    state,
    requestId,
    (request, draft) => {
      if (['completed', 'rejected'].includes(request.status)) {
        throw new Error('请求已关闭，不能登记回执')
      }
      let located: { batch: ExecutionBatch; item: BatchItem } | null = null
      for (const batch of request.batches) {
        const item = batch.items.find((entry) => entry.id === itemId)
        if (item) located = { batch, item }
      }
      if (!located) throw new Error('批次项不存在')
      const { batch, item } = located
      if (item.status === 'succeeded' || item.status === 'failed') {
        throw new Error(`该系统已留下最终回执 ${item.receipt?.receiptNo ?? ''}，不能重复登记或覆盖`)
      }
      const reason = failureReason.trim()
      if (outcome === 'failure' && !reason) {
        throw new Error('失败回执必须填写失败原因')
      }
      const systemName =
        draft.systems.find((entry) => entry.id === item.systemId)?.name ?? item.systemId
      const receipt: BatchReceipt = {
        receiptNo: `RCPT-${request.code}-B${batch.sequence}-${item.systemId
          .replace(/^sys-/, '')
          .toUpperCase()}-A${item.attempt}`,
        outcome,
        failureReason: outcome === 'failure' ? reason : '',
        receivedAt: now(),
        completedAt: outcome === 'success' ? now() : undefined,
      }
      const scopeCurrent = isItemScopeCurrent(request, batch, item)
      if (item.status === 'superseded' || !scopeCurrent) {
        if (item.voidedReceipt) {
          throw new Error(`迟到回执 ${item.voidedReceipt.receiptNo} 已作废登记，不能重复处理`)
        }
        item.voidedReceipt = receipt
        item.status = 'superseded'
        item.updatedAt = now()
        refreshBatchStatus(batch)
        request.conflicts.push(
          `迟到回执作废：${systemName} 回执 ${receipt.receiptNo} 到达时请求范围已更新，结果未并入，转入复核。`,
        )
        request.status = 'review-required'
        auditAction = '迟到回执作废'
        auditDetail = `${systemName} 回执 ${receipt.receiptNo} 对应第 ${batch.sequence} 批旧范围，已作废并转入复核，未覆盖新安排。`
        return
      }
      item.receipt = receipt
      item.updatedAt = now()
      if (outcome === 'success') {
        item.status = 'succeeded'
        const task = request.tasks.find((entry) => entry.id === item.taskId)
        if (task && task.status !== 'completed') {
          task.status = 'completed'
          task.completedAt = receipt.completedAt
          task.exceptionReason = ''
        }
        auditDetail = `${systemName} 回执 ${receipt.receiptNo} 登记成功，完成时间 ${receipt.completedAt}。`
      } else {
        item.status = 'failed'
        item.failureReason = reason
        const task = request.tasks.find((entry) => entry.id === item.taskId)
        if (task) {
          task.status = 'blocked'
          task.exceptionReason = `系统回执失败：${reason}`
        }
        request.conflicts.push(`批次回执失败：${systemName} —— ${reason}`)
        request.status = 'review-required'
        auditAction = '批次回执失败'
        auditDetail = `${systemName} 回执 ${receipt.receiptNo} 失败：${reason}，已转入复核。`
      }
      refreshBatchStatus(batch)
      if (outcome === 'success' && !request.conflicts.length) {
        const conclusion = getBatchConclusion(request, draft.systems)
        const executableTasks = request.tasks.filter((entry) => !entry.id.endsWith('-close'))
        if (
          conclusion.allSucceeded &&
          executableTasks.every((entry) => entry.status === 'completed')
        ) {
          request.status = 'pending-close'
        } else if (request.status !== 'review-required') {
          request.status = 'processing'
        }
      }
    },
    () => ({ action: auditAction, operator, detail: auditDetail }),
  )
}

export function addEvidence(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  name: string,
  evidenceType: 'execution-log' | 'screenshot' | 'signed-record' | 'system-response',
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      request.evidence.push({
        id: id('evidence'),
        stepId: taskId,
        name,
        evidenceType,
        digest: digest(`${name}-${now()}`),
        uploadedBy: operator,
        uploadedAt: now(),
        protected: true,
      })
    },
    {
      action: '上传执行证据',
      operator,
      detail: `${name} 已按受保护附件登记，保存摘要而非明文材料。`,
    },
  )
}

export function addConflict(
  state: WorkspaceState,
  requestId: string,
  conflict: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      request.conflicts.push(conflict)
      request.status = 'review-required'
    },
    { action: '标记冲突或例外', operator, detail: conflict },
  )
}

export function resolveConflict(
  state: WorkspaceState,
  requestId: string,
  conflictIndex: number,
  resolution: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request, draft) => {
      const conflict = request.conflicts[conflictIndex]
      if (!conflict) throw new Error('冲突项不存在')
      request.conflicts.splice(conflictIndex, 1)
      if (!request.conflicts.length && request.identity.status === 'verified') {
        request.status = 'processing'
        if (!request.batches.length && request.affectedSystemIds.length) {
          const info = dispatchBatchInternal(request, draft, operator)
          appendAudit(
            draft,
            request,
            '派发执行批次',
            operator,
            `复核清结后自动派发第 ${info.sequence} 批，覆盖 ${info.itemCount} 个系统。`,
          )
        }
      } else {
        request.status = 'review-required'
      }
    },
    { action: '复核处理冲突', operator, detail: resolution },
  )
}

export function extendRequest(
  state: WorkspaceState,
  requestId: string,
  days: number,
  reason: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const base = new Date(request.dueAt) > new Date() ? new Date(request.dueAt) : new Date()
      request.dueAt = addDays(base, days).toISOString()
      request.extendedDays += days
      request.status = 'extended'
    },
    { action: '延期请求处理', operator, detail: `延期 ${days} 天：${reason}` },
  )
}

export function closeRequest(
  state: WorkspaceState,
  requestId: string,
  resultSummary: string,
  closureReason: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request, draft) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份核验尚未通过，不能关闭请求')
      }
      if (request.batches.length) {
        const conclusion = getBatchConclusion(request, draft.systems)
        if (!conclusion.allSucceeded) {
          throw new Error(`执行批次未全部结清，不能关闭。批次结论：${conclusion.summary}`)
        }
      }
      const requiredTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
      if (requiredTasks.some((task) => task.status !== 'completed')) {
        throw new Error('仍有未完成任务，不能关闭请求')
      }
      if (request.conflicts.length) {
        throw new Error('仍有未解决冲突，不能关闭请求')
      }
      if (new Date(request.dueAt) > new Date() && !closureReason.trim()) {
        throw new Error('截止时间前关闭必须填写提前关闭理由')
      }
      request.resultSummary = resultSummary
      request.closureReason = closureReason
      request.status = 'completed'
      const closeTask = request.tasks.find((task) => task.id.endsWith('-close'))
      if (closeTask) {
        closeTask.status = 'completed'
        closeTask.completedAt = now()
      }
    },
    {
      action: '完成并关闭请求',
      operator,
      detail: closureReason ? `提前关闭理由：${closureReason}` : '截止时间后完成关闭。',
    },
  )
}

export function addComment(
  state: WorkspaceState,
  requestId: string,
  content: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  draft.comments.unshift({
    id: id('comment'),
    requestId,
    author: operator,
    content,
    createdAt: now(),
  })
  appendAudit(draft, request, '提交处理意见', operator, content)
  draft.revision += 1
  return draft
}

export function recordExport(
  state: WorkspaceState,
  scope: string,
  count: number,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  draft.audit.unshift({
    id: id('audit'),
    action: '导出处理包',
    operator,
    detail: `导出范围：${scope}，包含 ${count} 条请求。`,
    createdAt: now(),
  })
  draft.revision += 1
  return draft
}
