import type {
  BatchAttemptResult,
  ExecutionBatch,
  IdentityCheck,
  PrivacyRequest,
  RequestStatus,
  RequestType,
  WorkspaceState,
} from '@/types/domain'
import { addDays, buildWorkflowSteps, responseDays } from './workflow'
import { activeBatch, isBatchStale, scopeDigestOf } from './batchService'
import { regionLabels, requestTypeLabels } from '@/lib/schemas'

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
  audit: { action: string; operator: string; detail: string },
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  mutation(request, draft)
  appendAudit(draft, request, audit.action, audit.operator, audit.detail)
  draft.revision += 1
  return draft
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
    scopeVersion: 1,
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
    evidence: [],
    conflicts: [],
    batches: [],
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
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')

  const before = {
    type: request.type,
    affectedSystemIds: request.affectedSystemIds,
    tasks: request.tasks,
  }
  const digestBefore = scopeDigestOf(before)
  const changedFields: string[] = []
  if (patch.type !== undefined && patch.type !== before.type) {
    changedFields.push(`请求类型 ${requestTypeLabels[before.type]} → ${requestTypeLabels[patch.type]}`)
  }
  if (patch.region !== undefined && patch.region !== request.region) {
    changedFields.push(`地区 ${regionLabels[request.region]} → ${regionLabels[patch.region]}`)
  }
  if (
    patch.affectedSystemIds !== undefined &&
    JSON.stringify(patch.affectedSystemIds) !== JSON.stringify(before.affectedSystemIds)
  ) {
    changedFields.push(
      `涉及系统 ${before.affectedSystemIds.length} 个 → ${patch.affectedSystemIds.length} 个`,
    )
  }
  if (patch.tasks !== undefined && patch.tasks !== before.tasks) {
    changedFields.push('履约任务构成已调整')
  }

  // 批次、证据、审计、冲突等受保护结构不允许通过通用编辑补丁写入
  if (patch.requesterName !== undefined) request.requesterName = patch.requesterName
  if (patch.requesterContact !== undefined) request.requesterContact = patch.requesterContact
  if (patch.region !== undefined) request.region = patch.region
  if (patch.type !== undefined) request.type = patch.type
  if (patch.affectedSystemIds !== undefined) request.affectedSystemIds = patch.affectedSystemIds
  if (patch.tasks !== undefined) request.tasks = patch.tasks

  const digestAfter = scopeDigestOf(request)
  const scopeChanged = digestBefore !== digestAfter
  let detail = '更新请求基本信息。'

  if (scopeChanged) {
    // 范围已经进入新版本：执行中的旧批次立即作废，迟到回执只能进复核
    request.scopeVersion += 1
    const running = request.batches.find((batch) => batch.status === 'running')
    if (running) {
      running.status = 'superseded'
      const pendingNames = running.items
        .filter((item) => item.status === 'pending')
        .map((item) => systemName(draft, item.systemId))
      if (pendingNames.length) {
        running.items = running.items.map((item) =>
          item.status === 'pending' ? { ...item, status: 'voided' } : item,
        )
      }
      request.conflicts.push(
        `批次 ${running.code} 已被第 ${request.scopeVersion} 版范围替代：该批次此后到达的系统回执一律作废并转入复核，需按新范围重新发出批次。`,
      )
      if (request.identity.status === 'verified') request.status = 'review-required'
      detail = `请求范围更新（${changedFields.join('；') || '履约任务调整'}），执行中批次 ${running.code} 已作废，未决项与迟到回执转入复核。`
    } else {
      detail = `请求范围更新（${changedFields.join('；') || '履约任务调整'}），范围版本升至第 ${request.scopeVersion} 版。`
    }
  } else if (changedFields.length) {
    detail = `更新请求信息：${changedFields.join('；')}（范围摘要未变）。`
  }

  appendAudit(draft, request, '更新请求信息', operator, detail)
  draft.revision += 1
  return draft
}

function systemName(state: WorkspaceState, systemId: string): string {
  return state.systems.find((system) => system.id === systemId)?.name ?? systemId
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
    (request) => {
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
    (request) => {
      const conflict = request.conflicts[conflictIndex]
      if (!conflict) throw new Error('冲突项不存在')
      request.conflicts.splice(conflictIndex, 1)
      if (!request.conflicts.length && request.identity.status === 'verified') {
        request.status = 'processing'
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
    (request) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份核验尚未通过，不能关闭请求')
      }
      if (!request.batches.length) {
        throw new Error('尚未发出跨系统执行批次，全部系统结清前不能关闭请求')
      }
      const running = activeBatch(request)
      if (!running || isBatchStale(running, request)) {
        throw new Error('执行批次已被新版本范围替代，需按新范围重新发出并结清后才能关闭')
      }
      if (running.items.some((item) => item.status !== 'succeeded')) {
        const failed = running.items.filter((item) => item.status === 'failed').length
        const pending = running.items.filter((item) => item.status === 'pending').length
        throw new Error(
          `执行批次尚未全部结清（${failed} 个失败、${pending} 个待回执），失败项可重试，不能关闭请求`,
        )
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

export function dispatchBatch(
  state: WorkspaceState,
  requestId: string,
  note: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  if (request.identity.status !== 'verified') {
    throw new Error('身份未核验通过，不能发出执行批次')
  }
  if (!request.affectedSystemIds.length) throw new Error('请求范围未包含任何系统')
  const running = request.batches.find((batch) => batch.status === 'running')
  if (running) throw new Error(`执行批次 ${running.code} 仍在执行中，需先结清或作废后才能重新发出`)

  const nextNumber = request.batches.length + 1
  const timestamp = now()
  const batch: ExecutionBatch = {
    id: id('batch'),
    code: `${request.code}-B${String(nextNumber).padStart(2, '0')}`,
    createdAt: timestamp,
    createdBy: operator,
    requestType: request.type,
    systemIds: [...request.affectedSystemIds],
    scopeDigest: scopeDigestOf(request),
    scopeVersion: request.scopeVersion,
    status: 'running',
    note: note.trim(),
    items: request.affectedSystemIds.map((systemId) => ({
      systemId,
      status: 'pending',
      attempts: [],
    })),
  }
  request.batches.unshift(batch)
  request.status = 'processing'
  appendAudit(
    draft,
    request,
    '发出跨系统执行批次',
    operator,
    `批次 ${batch.code} 已发出，覆盖 ${batch.items.length} 个系统（范围版本第 ${batch.scopeVersion} 版，${batch.scopeDigest}）；各系统回执分别留痕。`,
  )
  draft.revision += 1
  return draft
}

export function registerBatchReceipt(
  state: WorkspaceState,
  requestId: string,
  batchId: string,
  systemId: string,
  result: BatchAttemptResult,
  receiptRef: string,
  failureReason: string,
  legalHold: boolean | undefined,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  const batch = request.batches.find((item) => item.id === batchId)
  if (!batch) throw new Error('执行批次不存在')
  const item = batch.items.find((entry) => entry.systemId === systemId)
  if (!item) throw new Error('该系统不在批次执行范围内')
  if (item.status === 'succeeded') {
    throw new Error('该系统回执已成功并冻结，不能覆盖或重发；重试只处理失败项')
  }
  const name = systemName(draft, systemId)
  const timestamp = now()
  const stale = isBatchStale(batch, request)

  if (stale && batch.status !== 'superseded') batch.status = 'superseded'

  if (stale) {
    // 范围或履约任务已更新：迟到的结果一律作废，绝不允许覆盖新安排
    item.attempts.push({
      id: id('attempt'),
      startedAt: timestamp,
      finishedAt: timestamp,
      result,
      voided: true,
      receiptRef: receiptRef.trim() || undefined,
      failureReason: failureReason.trim() || undefined,
      legalHold: legalHold || undefined,
    })
    if (item.status === 'pending') item.status = 'voided'
    const prefix = `迟到回执作废（批次 ${batch.code} · ${name}）`
    request.conflicts = request.conflicts.filter(
      (conflict) => !conflict.startsWith(prefix),
    )
    request.conflicts.push(
      `${prefix}：批次发出后请求范围已更新到第 ${request.scopeVersion} 版，${result === 'succeeded' ? '迟到的成功回执' : '迟到的失败结果'}不覆盖新安排，已转人工复核。`,
    )
    request.status = 'review-required'
    appendAudit(
      draft,
      request,
      '迟到回执作废并转复核',
      operator,
      `${name} 的${result === 'succeeded' ? '成功回执' : '失败结果'}属于旧批次 ${batch.code}（第 ${batch.scopeVersion} 版范围），已作废并转入复核队列。`,
    )
    draft.revision += 1
    return draft
  }

  if (result === 'succeeded' && !receiptRef.trim()) {
    throw new Error('成功回执必须填写最终回执编号')
  }
  if (result === 'failed' && !failureReason.trim()) {
    throw new Error('失败必须登记失败原因')
  }

  const openAttempt = [...item.attempts].reverse().find((entry) => !entry.finishedAt)
  const attempt = {
    id: openAttempt?.id ?? id('attempt'),
    startedAt: openAttempt?.startedAt ?? timestamp,
    finishedAt: timestamp,
    result,
    voided: false,
    receiptRef: result === 'succeeded' ? receiptRef.trim() : undefined,
    failureReason: result === 'failed' ? failureReason.trim() : undefined,
    legalHold: result === 'failed' ? legalHold || undefined : undefined,
  }
  if (openAttempt) {
    item.attempts[item.attempts.lastIndexOf(openAttempt)] = attempt
  } else {
    item.attempts.push(attempt)
  }

  if (result === 'succeeded') {
    // 成功回执与完成时间只在首次成功时落定，之后任何操作都不得替换
    item.status = 'succeeded'
    item.receiptRef = receiptRef.trim()
    item.receiptAt = timestamp
    item.failureReason = undefined
    item.legalHold = undefined
    const prefix = `系统执行失败（批次 ${batch.code} · ${name}）`
    request.conflicts = request.conflicts.filter(
      (conflict) => !conflict.startsWith(prefix),
    )
    if (batch.items.every((entry) => entry.status === 'succeeded')) {
      batch.status = 'completed'
      const executableTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
      if (!request.conflicts.length && executableTasks.every((task) => task.status === 'completed')) {
        request.status = 'pending-close'
      } else if (!request.conflicts.length) {
        request.status = 'processing'
      }
    } else {
      request.status = 'processing'
    }
    appendAudit(
      draft,
      request,
      '登记系统成功回执',
      operator,
      `${name} 成功回执 ${receiptRef.trim()} 已冻结（${timestamp}）；批次 ${batch.code} 其余系统继续执行。`,
    )
  } else {
    item.status = 'failed'
    item.failureReason = failureReason.trim()
    item.legalHold = legalHold || undefined
    const prefix = `系统执行失败（批次 ${batch.code} · ${name}）`
    request.conflicts = request.conflicts.filter(
      (conflict) => !conflict.startsWith(prefix),
    )
    request.conflicts.push(
      `${prefix}：${failureReason.trim()}${legalHold ? '（该系统处于法务保留）' : ''}；重试只处理该失败项。`,
    )
    request.status = 'review-required'
    appendAudit(
      draft,
      request,
      '登记系统执行失败',
      operator,
      `${name} 执行失败：${failureReason.trim()}${legalHold ? '（法务保留）' : ''}；批次 ${batch.code} 其余系统不受影响。`,
    )
  }

  draft.revision += 1
  return draft
}

export function retryFailedItems(
  state: WorkspaceState,
  requestId: string,
  batchId: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  const batch = request.batches.find((item) => item.id === batchId)
  if (!batch) throw new Error('执行批次不存在')
  if (isBatchStale(batch, request) || batch.status === 'superseded') {
    throw new Error('该批次已被新版本范围替代，不能重试旧批次，请按新范围重新发出批次')
  }
  const failedItems = batch.items.filter((item) => item.status === 'failed')
  if (!failedItems.length) throw new Error('批次没有失败项，无需重试')

  for (const item of failedItems) {
    // 只重置失败项：成功项的回执与完成时间原样保留，不参与重试
    item.status = 'pending'
    item.failureReason = undefined
    item.legalHold = undefined
    // 重试开启一条新的尝试，回执到达时闭合；历史失败尝试原样保留
    item.attempts.push({ id: id('attempt'), startedAt: now() })
    const name = systemName(draft, item.systemId)
    const prefix = `系统执行失败（批次 ${batch.code} · ${name}）`
    request.conflicts = request.conflicts.filter(
      (conflict) => !conflict.startsWith(prefix),
    )
  }
  if (!request.conflicts.length && request.identity.status === 'verified') {
    request.status = 'processing'
  }
  appendAudit(
    draft,
    request,
    '重试批次失败项',
    operator,
    `批次 ${batch.code} 对 ${failedItems.length} 个失败系统发起重试，已成功系统的回执与完成时间保持不变。`,
  )
  draft.revision += 1
  return draft
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
