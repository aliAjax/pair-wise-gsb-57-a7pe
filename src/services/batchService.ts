import type {
  BatchConclusion,
  ExecutionBatch,
  PrivacyRequest,
} from '@/types/domain'

/**
 * 计算请求范围摘要。该摘要在批次发出时固化到批次上；
 * 之后请求范围（类型/涉及系统/履约任务构成）发生变化，旧批次的摘要即与当前不一致，
 * 迟到回执据此判定为旧版本结果并作废。
 */
export function scopeDigestOf(request: {
  type: string
  affectedSystemIds: string[]
  tasks: { id: string; systemId?: string }[]
}): string {
  const payload = JSON.stringify({
    type: request.type,
    systems: [...request.affectedSystemIds].sort(),
    tasks: request.tasks
      .map((task) => ({ id: task.id, systemId: task.systemId ?? '' }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })
  let hash = 2166136261
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `SC-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

/** 按当前范围版本判定批次是否已经过期；过期批次的任何迟到回执都只能作废。 */
export function isBatchStale(batch: ExecutionBatch, request: PrivacyRequest): boolean {
  return batch.scopeVersion !== request.scopeVersion || batch.scopeDigest !== scopeDigestOf(request)
}

/** 当前仍在执行中（未被新版本替代、尚未全部结清）的批次。 */
export function activeBatch(request: PrivacyRequest): ExecutionBatch | undefined {
  return request.batches.find((batch) => batch.status === 'running')
}

/**
 * 跨系统执行批次的同一份结论。
 * 详情页、复核队列、审计导出和关闭判断都只允许读取这一结论，避免各页面口径不一致。
 */
export function batchConclusion(request: PrivacyRequest): BatchConclusion {
  const batches = request.batches
  if (!batches.length) {
    return {
      kind: 'none',
      label: '尚未发出执行批次',
      detail: '跨系统处理必须先建成可追踪的执行批次。',
      settleable: true,
    }
  }

  const batch = batches[0]
  if (isBatchStale(batch, request)) {
    const voided = batch.items.filter((item) => item.status === 'voided').length
    return {
      kind: 'superseded',
      label: '旧批次已作废，等待新批次',
      detail: `批次 ${batch.code} 发出后请求范围或履约任务已更新（第 ${request.scopeVersion} 版范围），${voided} 份迟到回执已作废并转入复核，需要按新范围重新发出批次。`,
      settleable: false,
      batch,
    }
  }

  const failed = batch.items.filter((item) => item.status === 'failed').length
  const pending = batch.items.filter((item) => item.status === 'pending').length
  if (batch.status === 'running' || failed > 0 || pending > 0) {
    return {
      kind: 'has-failures',
      label: failed > 0 ? '部分系统失败，重试只处理失败项' : '批次执行中，等待系统回执',
      detail:
        failed > 0
          ? `批次 ${batch.code}：${failed} 个系统失败、${pending} 个系统待回执；已成功系统的回执与完成时间保持不变。`
          : `批次 ${batch.code}：${pending} 个系统待回执，成功回执将原样留痕。`,
      settleable: false,
      batch,
    }
  }

  return {
    kind: 'all-succeeded',
    label: '全部系统结清',
    detail: `批次 ${batch.code} 的 ${batch.items.length} 个系统均已成功回执，回执编号与完成时间已冻结。`,
    settleable: true,
    batch,
  }
}

/** 关闭判断专用：全部系统结清前一律拒绝关闭。 */
export function isBatchSettled(request: PrivacyRequest): boolean {
  return batchConclusion(request).settleable
}
