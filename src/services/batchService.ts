import type { BatchItem, DataSystem, ExecutionBatch, PrivacyRequest } from '@/types/domain'

export type RequestScope = Pick<PrivacyRequest, 'type' | 'affectedSystemIds' | 'tasks'>

/**
 * 范围指纹：请求类型 + 涉及系统 + 执行类任务。
 * 批次发出时记录指纹；此后请求范围或履约任务被更新，指纹即变化，
 * 迟到的回执会被作废并转入复核，避免旧结果覆盖新安排。
 */
export function computeScopeHash(request: RequestScope): string {
  const executeTaskIds = request.tasks
    .filter((task) => task.id.includes('-execute-'))
    .map((task) => task.id)
    .sort()
  const payload = JSON.stringify({
    type: request.type,
    systems: [...request.affectedSystemIds].sort(),
    executeTaskIds,
  })
  let hash = 2166136261
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `SC-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

export function latestItemForSystem(
  request: PrivacyRequest,
  systemId: string,
): { batch: ExecutionBatch; item: BatchItem } | null {
  let found: { batch: ExecutionBatch; item: BatchItem } | null = null
  for (const batch of request.batches) {
    for (const item of batch.items) {
      if (item.systemId !== systemId) continue
      if (
        !found ||
        batch.sequence > found.batch.sequence ||
        (batch.sequence === found.batch.sequence && item.attempt > found.item.attempt)
      ) {
        found = { batch, item }
      }
    }
  }
  return found
}

/**
 * 逐系统判定批次项是否仍对应当前安排：
 * 请求类型变更、系统被移出范围、或其执行任务被替换时，
 * 该项即过期——迟到的回执作废转复核；未受影响的系统不受牵连。
 */
export function isItemScopeCurrent(
  request: RequestScope,
  batch: ExecutionBatch,
  item: BatchItem,
): boolean {
  return (
    batch.scopeSnapshot.type === request.type &&
    request.affectedSystemIds.includes(item.systemId) &&
    request.tasks.some((task) => task.id === item.taskId)
  )
}

export type SystemConclusionState =
  | 'not-dispatched'
  | 'awaiting'
  | 'succeeded'
  | 'failed'
  | 'superseded'

export interface SystemConclusion {
  systemId: string
  systemName: string
  state: SystemConclusionState
  /** 对应批次发出后范围已更新，旧结果不能代表新安排 */
  stale: boolean
  attempt: number
  batchSequence: number
  receiptNo?: string
  completedAt?: string
  failureReason?: string
  voidedReceiptNo?: string
}

export interface BatchConclusion {
  requestId: string
  scopeHash: string
  latestBatchSequence: number
  systems: SystemConclusion[]
  totalCount: number
  succeededCount: number
  failedCount: number
  awaitingCount: number
  supersededCount: number
  notDispatchedCount: number
  voidedReceiptCount: number
  /** 每个系统都在当前范围下留下终态回执（成功或失败） */
  settled: boolean
  /** 每个系统都在当前范围下成功结清，关闭判断以此为准 */
  allSucceeded: boolean
  needsReview: boolean
  summary: string
}

/**
 * 批次结论的唯一来源：详情页、复核队列、审计导出和关闭判断都使用这一份结论，
 * 保证全部系统结清前各入口看到完全一致的状态。
 */
export function getBatchConclusion(
  request: PrivacyRequest,
  systems: DataSystem[],
): BatchConclusion {
  const scopeHash = computeScopeHash(request)
  const latestBatchSequence = request.batches.reduce(
    (max, batch) => Math.max(max, batch.sequence),
    0,
  )

  const conclusions: SystemConclusion[] = request.affectedSystemIds.map((systemId) => {
    const systemName = systems.find((system) => system.id === systemId)?.name ?? systemId
    const located = latestItemForSystem(request, systemId)
    if (!located) {
      return {
        systemId,
        systemName,
        state: 'not-dispatched' as const,
        stale: false,
        attempt: 0,
        batchSequence: 0,
      }
    }
    const { batch, item } = located
    const stale = !isItemScopeCurrent(request, batch, item)
    const base = {
      systemId,
      systemName,
      stale,
      attempt: item.attempt,
      batchSequence: batch.sequence,
    }
    if (item.status === 'sent') {
      return { ...base, state: 'awaiting' as const }
    }
    if (item.status === 'succeeded') {
      return {
        ...base,
        state: 'succeeded' as const,
        receiptNo: item.receipt?.receiptNo,
        completedAt: item.receipt?.completedAt,
      }
    }
    if (item.status === 'failed') {
      return {
        ...base,
        state: 'failed' as const,
        receiptNo: item.receipt?.receiptNo,
        failureReason: item.failureReason || item.receipt?.failureReason || '未注明原因',
      }
    }
    return {
      ...base,
      state: 'superseded' as const,
      voidedReceiptNo: item.voidedReceipt?.receiptNo,
    }
  })

  const totalCount = conclusions.length
  const succeededCount = conclusions.filter(
    (item) => item.state === 'succeeded' && !item.stale,
  ).length
  const failedCount = conclusions.filter((item) => item.state === 'failed').length
  const awaitingCount = conclusions.filter((item) => item.state === 'awaiting').length
  const supersededCount = conclusions.filter((item) => item.state === 'superseded').length
  const notDispatchedCount = conclusions.filter((item) => item.state === 'not-dispatched').length
  const voidedReceiptCount = request.batches.reduce(
    (total, batch) => total + batch.items.filter((item) => item.voidedReceipt).length,
    0,
  )

  const settled =
    totalCount > 0 &&
    conclusions.every(
      (item) => (item.state === 'succeeded' || item.state === 'failed') && !item.stale,
    )
  const allSucceeded =
    totalCount > 0 && conclusions.every((item) => item.state === 'succeeded' && !item.stale)
  const needsReview =
    failedCount > 0 ||
    supersededCount > 0 ||
    voidedReceiptCount > 0 ||
    conclusions.some((item) => item.stale)

  let summary: string
  if (!request.batches.length) {
    summary = '尚未派发执行批次'
  } else if (allSucceeded) {
    summary = `全部 ${totalCount} 个系统已成功结清（最新第 ${latestBatchSequence} 批）`
  } else {
    const parts = [`成功 ${succeededCount}/${totalCount}`]
    for (const item of conclusions) {
      if (item.state === 'succeeded' && item.stale) {
        parts.push(`${item.systemName}成功回执对应旧范围，待按新范围重派`)
      } else if (item.state === 'failed') {
        parts.push(`${item.systemName}回执失败（${item.failureReason}）`)
      } else if (item.state === 'awaiting') {
        parts.push(
          item.stale
            ? `${item.systemName}等待回执（范围已更新，旧回执将作废）`
            : `${item.systemName}等待回执`,
        )
      } else if (item.state === 'superseded') {
        parts.push(`${item.systemName}回执已作废，待重派`)
      } else if (item.state === 'not-dispatched') {
        parts.push(`${item.systemName}未派发`)
      }
    }
    if (voidedReceiptCount) {
      parts.push(`${voidedReceiptCount} 项迟到回执已作废转复核`)
    }
    summary = parts.join('；')
  }

  return {
    requestId: request.id,
    scopeHash,
    latestBatchSequence,
    systems: conclusions,
    totalCount,
    succeededCount,
    failedCount,
    awaitingCount,
    supersededCount,
    notDispatchedCount,
    voidedReceiptCount,
    settled,
    allSucceeded,
    needsReview,
    summary,
  }
}
