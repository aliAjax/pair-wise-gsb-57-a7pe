/* 验证跨系统执行批次的核心规则 */
import { createInitialState } from '@/services/mockData'
import {
  closeRequest,
  createRequest,
  dispatchBatch,
  recordReceipt,
  saveRequest,
  taskAction,
  verifyIdentity,
} from '@/services/requestService'
import { getBatchConclusion } from '@/services/batchService'
import type { WorkspaceState } from '@/types/domain'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

function expectThrow(fn: () => unknown, includes: string) {
  try {
    fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(includes)) {
      throw new Error(`错误信息不含「${includes}」，实际：${message}`)
    }
    return
  }
  throw new Error(`预期抛出包含「${includes}」的错误，但未抛出`)
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const state0 = createInitialState()

console.log('场景 1：批次结论（一家成功、一家失败、一家在途）')
check('req-001 结论：2/3 成功，客服工单在途', () => {
  const req = state0.requests.find((r) => r.id === 'req-001')!
  const c = getBatchConclusion(req, state0.systems)
  assert(c.succeededCount === 2 && c.awaitingCount === 1, `结论计数错误：${c.summary}`)
  assert(!c.allSucceeded && !c.settled, '未结清却判定可关闭')
})
check('req-003 结论：风控失败原因保留', () => {
  const req = state0.requests.find((r) => r.id === 'req-003')!
  const c = getBatchConclusion(req, state0.systems)
  const risk = c.systems.find((s) => s.systemId === 'sys-risk')!
  assert(risk.state === 'failed' && risk.failureReason?.includes('法务保留'), '失败原因丢失')
  assert(c.summary.includes('法务保留'), `结论摘要未含失败原因：${c.summary}`)
})

console.log('场景 2：登记回执 → 全部结清进入待关闭')
{
  let state: WorkspaceState = state0
  const item = state.requests
    .find((r) => r.id === 'req-001')!
    .batches[0].items.find((i) => i.systemId === 'sys-support')!
  state = recordReceipt(state, 'req-001', item.id, 'success', '', '数据管理员')
  check('成功回执登记后任务完成且时间来自回执', () => {
    const req = state.requests.find((r) => r.id === 'req-001')!
    const c = getBatchConclusion(req, state.systems)
    assert(c.allSucceeded, `应全部结清：${c.summary}`)
    const task = req.tasks.find((t) => t.id === 'req-001-execute-sys-support')!
    assert(task.status === 'completed' && task.completedAt, '执行任务未完成')
  })
  check('合并与复核任务完成后进入待关闭', () => {
    const req = state.requests.find((r) => r.id === 'req-001')!
    assert(req.status === 'processing', '合并复核未完成前不应待关闭')
    state = taskAction(state, 'req-001', 'req-001-merge', 'complete', '', '隐私运营')
    state = taskAction(state, 'req-001', 'req-001-review', 'complete', '', '隐私负责人')
    const after = state.requests.find((r) => r.id === 'req-001')!
    assert(after.status === 'pending-close', `状态应为待关闭，实际 ${after.status}`)
  })
  check('重复登记最终回执被拒绝', () => {
    expectThrow(
      () => recordReceipt(state, 'req-001', item.id, 'success', '', '数据管理员'),
      '不能重复登记或覆盖',
    )
  })
}

console.log('场景 3：失败 → 复核 → 重试只碰失败项')
{
  let state: WorkspaceState = state0
  const riskItem = state.requests
    .find((r) => r.id === 'req-003')!
    .batches[0].items.find((i) => i.systemId === 'sys-risk')!
  const crmReceiptBefore = state.requests
    .find((r) => r.id === 'req-003')!
    .batches[0].items.find((i) => i.systemId === 'sys-crm')!.receipt
  // 风控项已是失败态（mock），直接重试
  state = dispatchBatch(state, 'req-003', '隐私运营')
  check('重试只覆盖未结系统（风控+在途客服），成功项不动', () => {
    const req = state.requests.find((r) => r.id === 'req-003')!
    assert(req.batches.length === 2, `应有 2 个批次，实际 ${req.batches.length}`)
    const batch2 = req.batches[1]
    const systems = batch2.items.map((i) => i.systemId).sort()
    assert(!systems.includes('sys-crm'), '重试不应触碰已成功系统')
    const crmItem = req.batches[0].items.find((i) => i.systemId === 'sys-crm')!
    assert(
      crmItem.receipt?.receiptNo === crmReceiptBefore?.receiptNo &&
        crmItem.receipt?.completedAt === crmReceiptBefore?.completedAt,
      '成功回执或完成时间被改写',
    )
    const riskRetry = batch2.items.find((i) => i.systemId === 'sys-risk')!
    assert(riskRetry.attempt === 2 && riskRetry.retryOfItemId === riskItem.id, '重试项未关联上一尝试')
  })
  check('重试后登记成功回执，旧失败回执仍留痕', () => {
    const req = state.requests.find((r) => r.id === 'req-003')!
    const retry = req.batches[1].items.find((i) => i.systemId === 'sys-risk')!
    state = recordReceipt(state, 'req-003', retry.id, 'success', '', '数据管理员')
    const after = state.requests.find((r) => r.id === 'req-003')!
    const oldFailed = after.batches[0].items.find((i) => i.systemId === 'sys-risk')!
    assert(oldFailed.status === 'failed' && oldFailed.failureReason.includes('法务保留'), '旧失败回执被覆盖')
    const c = getBatchConclusion(after, state.systems)
    const risk = c.systems.find((s) => s.systemId === 'sys-risk')!
    assert(risk.state === 'succeeded' && risk.attempt === 2, '结论未取到最新尝试')
  })
}

console.log('场景 4a：新增系统不影响在途项，回执正常并入')
{
  let state: WorkspaceState = state0
  // req-001 客服工单系统在途；此时请求范围新增风控系统（类型不变）
  state = saveRequest(
    state,
    'req-001',
    { affectedSystemIds: ['sys-crm', 'sys-order', 'sys-support', 'sys-risk'] },
    '隐私运营',
  )
  const supportItem = state.requests
    .find((r) => r.id === 'req-001')!
    .batches[0].items.find((i) => i.systemId === 'sys-support')!
  state = recordReceipt(state, 'req-001', supportItem.id, 'success', '', '数据管理员')
  check('未受影响系统的回执正常登记', () => {
    const req = state.requests.find((r) => r.id === 'req-001')!
    const item = req.batches[0].items.find((i) => i.systemId === 'sys-support')!
    assert(item.status === 'succeeded' && item.receipt, '回执应正常并入')
    assert(!req.conflicts.length, '不应产生复核冲突')
  })
  check('重派只覆盖未派发的新系统，成功项不动', () => {
    state = dispatchBatch(state, 'req-001', '隐私运营')
    const req = state.requests.find((r) => r.id === 'req-001')!
    const latest = req.batches[req.batches.length - 1]
    const systems = latest.items.map((i) => i.systemId)
    assert(systems.length === 1 && systems[0] === 'sys-risk', `新批次应只含风控，实际 ${systems}`)
    const crm = req.batches[0].items.find((i) => i.systemId === 'sys-crm')!
    assert(
      crm.status === 'succeeded' && crm.receipt?.completedAt === '2026-09-26T09:00:00.000Z',
      '成功回执被改动',
    )
  })
}

console.log('场景 4b：请求类型变更 → 迟到回执作废转复核')
{
  // 新请求核验通过自动派发首批，随后请求类型被更正（访问 → 删除）
  let state = createRequest(
    state0,
    {
      requesterName: '测试用户',
      requesterContact: 'te***@example.com',
      region: 'cn',
      type: 'access',
      affectedSystemIds: ['sys-crm', 'sys-support'],
      identityMaterialType: 'masked-id',
      identityReference: '310***********9999',
      note: '',
    },
    '客服专员',
  )
  const requestId = state.requests[0].id
  state = verifyIdentity(state, requestId, 'verified', '核验通过。', '隐私运营')
  state = saveRequest(state, requestId, { type: 'deletion' }, '隐私运营')
  const sentItem = state.requests.find((r) => r.id === requestId)!.batches[0].items[0]
  state = recordReceipt(state, requestId, sentItem.id, 'success', '', '数据管理员')
  check('迟到回执作废、转入复核，不覆盖新安排', () => {
    const req = state.requests.find((r) => r.id === requestId)!
    const item = req.batches[0].items[0]
    assert(item.status === 'superseded' && item.voidedReceipt, '迟到回执未作废')
    assert(!item.receipt, '作废回执不应并入正式回执')
    assert(req.status === 'review-required', '未转入复核')
    assert(req.conflicts.some((c) => c.includes('迟到回执作废')), '复核队列缺少作废记录')
    const task = req.tasks.find((t) => t.id === item.taskId)!
    assert(task.status !== 'completed', '作废回执不应完成任务')
  })
  check('结论提示作废且关闭判断给出同一份结论', () => {
    const req = state.requests.find((r) => r.id === requestId)!
    const c = getBatchConclusion(req, state.systems)
    assert(c.voidedReceiptCount === 1 && c.needsReview, '结论未反映作废回执')
    assert(!c.allSucceeded, '存在作废项时不应判定结清')
    expectThrow(
      () => closeRequest(state, requestId, '结果说明', '提前关闭理由', '隐私负责人'),
      c.summary,
    )
  })
  check('按新范围重派覆盖被作废系统，旧作废记录留痕', () => {
    state = dispatchBatch(state, requestId, '隐私运营')
    const req = state.requests.find((r) => r.id === requestId)!
    assert(req.batches.length === 2, '应产生第 2 批')
    const latest = req.batches[1]
    assert(latest.items.length === 2, '两个系统均需按新类型重派')
    assert(latest.items.every((i) => i.attempt === 2 && i.retryOfItemId), '应关联上一尝试')
    const old = req.batches[0].items[0]
    assert(old.voidedReceipt && old.status === 'superseded', '旧作废记录被覆盖')
  })
}

console.log('场景 5：关闭判断与批次结论一致')
check('req-004 全部结清可关闭', () => {
  const state = closeRequest(state0, 'req-004', '营销平台已撤回同意。', '全部系统结清，提前关闭。', '隐私负责人')
  const req = state.requests.find((r) => r.id === 'req-004')!
  assert(req.status === 'completed', '应已关闭')
})
check('req-001 未结清时关闭报错并带同一份结论', () => {
  const req = state0.requests.find((r) => r.id === 'req-001')!
  const c = getBatchConclusion(req, state0.systems)
  expectThrow(
    () => closeRequest(state0, 'req-001', '结果说明', '提前关闭理由', '隐私负责人'),
    c.summary,
  )
})

console.log('场景 6：新请求全流程（核验通过自动派发首批）')
{
  let state = createRequest(
    state0,
    {
      requesterName: '测试用户',
      requesterContact: 'te***@example.com',
      region: 'cn',
      type: 'deletion',
      affectedSystemIds: ['sys-crm', 'sys-support'],
      identityMaterialType: 'masked-id',
      identityReference: '310***********9999',
      note: '测试',
    },
    '客服专员',
  )
  const requestId = state.requests[0].id
  state = verifyIdentity(state, requestId, 'verified', '核验通过。', '隐私运营')
  check('身份核验通过后自动派发首批', () => {
    const req = state.requests.find((r) => r.id === requestId)!
    assert(req.batches.length === 1, '未自动派发')
    assert(req.batches[0].items.length === 2, '批次应覆盖 2 个系统')
    assert(req.batches[0].items.every((i) => i.status === 'sent'), '批次项应为等待回执')
  })
  check('在途批次项不允许手动完成任务', () => {
    const req = state.requests.find((r) => r.id === requestId)!
    const executeTask = req.tasks.find((t) => t.id.includes('-execute-'))!
    expectThrow(
      () => taskAction(state, requestId, executeTask.id, 'complete', '', '数据管理员'),
      '登记系统回执',
    )
  })
  check('身份未核验不能派发批次', () => {
    const s2 = createRequest(
      state0,
      {
        requesterName: '另一个用户',
        requesterContact: 'an***@example.com',
        region: 'eu',
        type: 'access',
        affectedSystemIds: ['sys-crm'],
        identityMaterialType: 'masked-id',
        identityReference: '310***********8888',
        note: '',
      },
      '客服专员',
    )
    expectThrow(() => dispatchBatch(s2, s2.requests[0].id, '隐私运营'), '身份核验')
  })
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
