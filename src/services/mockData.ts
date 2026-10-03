import type { DataSystem, PrivacyRequest, WorkflowStep, WorkspaceState } from '@/types/domain'
import { computeScopeHash } from './batchService'
import { addDays, buildWorkflowSteps } from './workflow'

const systems: DataSystem[] = [
  {
    id: 'sys-crm',
    name: '客户关系管理系统',
    owner: '客户平台组',
    dataDomain: '客户身份、联系信息、服务记录',
    transferMethod: '受控接口导出',
    slaDays: 5,
    requestTypes: ['access', 'rectification', 'deletion', 'restriction'],
    status: 'active',
  },
  {
    id: 'sys-order',
    name: '订单与交易平台',
    owner: '交易系统组',
    dataDomain: '订单、支付标识、收货信息',
    transferMethod: '离线加密包',
    slaDays: 7,
    requestTypes: ['access', 'deletion'],
    status: 'active',
  },
  {
    id: 'sys-marketing',
    name: '营销自动化平台',
    owner: '增长技术组',
    dataDomain: '同意记录、标签、触达历史',
    transferMethod: '消息队列同步',
    slaDays: 3,
    requestTypes: ['access', 'deletion', 'withdraw-consent', 'restriction'],
    status: 'active',
  },
  {
    id: 'sys-archive',
    name: '电子档案库',
    owner: '档案管理组',
    dataDomain: '合同、凭证、历史记录',
    transferMethod: '双人复核导出',
    slaDays: 10,
    requestTypes: ['access', 'rectification', 'restriction'],
    status: 'maintenance',
  },
  {
    id: 'sys-support',
    name: '客服工单系统',
    owner: '服务运营组',
    dataDomain: '沟通记录、身份核验材料、附件',
    transferMethod: '脱敏下载',
    slaDays: 5,
    requestTypes: ['access', 'rectification', 'deletion', 'restriction'],
    status: 'active',
  },
  {
    id: 'sys-risk',
    name: '风控决策平台',
    owner: '风险技术组',
    dataDomain: '设备指纹、风险标签、决策结果',
    transferMethod: '隔离区核验',
    slaDays: 8,
    requestTypes: ['access', 'rectification', 'restriction'],
    status: 'active',
  },
]

function audit(
  id: string,
  action: string,
  operator: string,
  detail: string,
  createdAt: string,
) {
  return { id, action, operator, detail, createdAt }
}

function patchTasks(
  tasks: WorkflowStep[],
  patches: Record<string, Partial<WorkflowStep>>,
): WorkflowStep[] {
  return tasks.map((task) => (patches[task.id] ? { ...task, ...patches[task.id] } : task))
}

export function createInitialState(): WorkspaceState {
  const request1At = '2026-09-25T02:30:00.000Z'
  const request2At = '2026-09-18T06:20:00.000Z'
  const request3At = '2026-09-21T03:10:00.000Z'
  const request4At = '2026-09-24T05:40:00.000Z'
  const request5At = '2026-09-05T01:00:00.000Z'
  const request1Due = addDays(new Date(request1At), 30).toISOString()
  const request2Due = addDays(new Date(request2At), 30).toISOString()
  const request3Due = addDays(new Date(request3At), 45).toISOString()
  const request4Due = addDays(new Date(request4At), 30).toISOString()
  const request5Due = addDays(new Date(request5At), 30).toISOString()

  const request1Tasks = patchTasks(
    buildWorkflowSteps({
      requestId: 'req-001',
      type: 'access',
      systemIds: ['sys-crm', 'sys-order', 'sys-support'],
      requestedAt: request1At,
      dueAt: request1Due,
      initialStatus: 'processing',
      systems,
    }),
    {
      'req-001-locate-sys-crm': { status: 'completed', completedAt: '2026-09-25T06:00:00.000Z' },
      'req-001-execute-sys-crm': { status: 'completed', completedAt: '2026-09-26T09:00:00.000Z' },
      'req-001-locate-sys-order': { status: 'completed', completedAt: '2026-09-25T07:00:00.000Z' },
      'req-001-execute-sys-order': { status: 'completed', completedAt: '2026-09-27T11:00:00.000Z' },
      'req-001-locate-sys-support': { status: 'completed', completedAt: '2026-09-26T02:00:00.000Z' },
      'req-001-execute-sys-support': { status: 'active' },
    },
  )
  const request1Scope = computeScopeHash({
    type: 'access',
    affectedSystemIds: ['sys-crm', 'sys-order', 'sys-support'],
    tasks: request1Tasks,
  })

  const request3Tasks = patchTasks(
    buildWorkflowSteps({
      requestId: 'req-003',
      type: 'rectification',
      systemIds: ['sys-crm', 'sys-risk', 'sys-support'],
      requestedAt: request3At,
      dueAt: request3Due,
      initialStatus: 'processing',
      systems,
    }),
    {
      'req-003-locate-sys-crm': { status: 'completed', completedAt: '2026-09-21T07:00:00.000Z' },
      'req-003-execute-sys-crm': { status: 'completed', completedAt: '2026-09-22T10:00:00.000Z' },
      'req-003-locate-sys-risk': { status: 'completed', completedAt: '2026-09-21T08:00:00.000Z' },
      'req-003-execute-sys-risk': {
        status: 'blocked',
        exceptionReason: '系统回执失败：法务保留：反欺诈风险标签需例外审查，暂缓更正。',
      },
      'req-003-locate-sys-support': { status: 'completed', completedAt: '2026-09-22T03:00:00.000Z' },
      'req-003-execute-sys-support': { status: 'active' },
    },
  )
  const request3Scope = computeScopeHash({
    type: 'rectification',
    affectedSystemIds: ['sys-crm', 'sys-risk', 'sys-support'],
    tasks: request3Tasks,
  })

  const request4Tasks = patchTasks(
    buildWorkflowSteps({
      requestId: 'req-004',
      type: 'withdraw-consent',
      systemIds: ['sys-marketing'],
      requestedAt: request4At,
      dueAt: request4Due,
      initialStatus: 'pending-close',
      systems,
    }),
    {
      'req-004-execute-sys-marketing': { completedAt: '2026-09-28T09:00:00.000Z' },
      'req-004-merge': { completedAt: '2026-09-28T09:10:00.000Z' },
      'req-004-review': { completedAt: '2026-09-28T09:10:00.000Z' },
    },
  )
  const request4Scope = computeScopeHash({
    type: 'withdraw-consent',
    affectedSystemIds: ['sys-marketing'],
    tasks: request4Tasks,
  })

  const request5Tasks = patchTasks(
    buildWorkflowSteps({
      requestId: 'req-005',
      type: 'deletion',
      systemIds: ['sys-crm', 'sys-marketing'],
      requestedAt: request5At,
      dueAt: request5Due,
      initialStatus: 'completed',
      systems,
    }),
    {
      'req-005-locate-sys-crm': { completedAt: '2026-09-06T02:00:00.000Z' },
      'req-005-execute-sys-crm': { completedAt: '2026-09-08T05:00:00.000Z' },
      'req-005-locate-sys-marketing': { completedAt: '2026-09-06T03:00:00.000Z' },
      'req-005-execute-sys-marketing': { completedAt: '2026-09-09T06:00:00.000Z' },
      'req-005-merge': { completedAt: '2026-09-09T08:00:00.000Z' },
      'req-005-review': { completedAt: '2026-09-10T01:00:00.000Z' },
      'req-005-close': { completedAt: '2026-09-10T02:00:00.000Z' },
    },
  )
  const request5Scope = computeScopeHash({
    type: 'deletion',
    affectedSystemIds: ['sys-crm', 'sys-marketing'],
    tasks: request5Tasks,
  })

  const requests: PrivacyRequest[] = [
    {
      id: 'req-001',
      code: 'DSR-2026-001',
      requesterName: '张晨',
      requesterContact: 'zh***@example.com',
      region: 'cn',
      type: 'access',
      status: 'processing',
      identity: {
        status: 'verified',
        materialType: 'masked-id',
        maskedReference: '310***********1234',
        protectedDigest: 'ID-74A1B2',
        note: '证件影像已核验，原始文件未进入业务库。',
        reviewedAt: '2026-09-25T04:10:00.000Z',
      },
      requestedAt: request1At,
      dueAt: request1Due,
      extendedDays: 0,
      affectedSystemIds: ['sys-crm', 'sys-order', 'sys-support'],
      tasks: request1Tasks,
      batches: [
        {
          id: 'batch-001-1',
          requestId: 'req-001',
          sequence: 1,
          scopeHash: request1Scope,
          scopeSnapshot: {
            type: 'access',
            systemIds: ['sys-crm', 'sys-order', 'sys-support'],
            taskIds: [
              'req-001-execute-sys-crm',
              'req-001-execute-sys-order',
              'req-001-execute-sys-support',
            ],
          },
          status: 'in-flight',
          dispatchedAt: '2026-09-25T04:20:00.000Z',
          dispatchedBy: '隐私运营',
          items: [
            {
              id: 'item-001-crm-1',
              batchId: 'batch-001-1',
              systemId: 'sys-crm',
              taskId: 'req-001-execute-sys-crm',
              attempt: 1,
              status: 'succeeded',
              receipt: {
                receiptNo: 'RCPT-DSR-2026-001-B1-CRM-A1',
                outcome: 'success',
                failureReason: '',
                receivedAt: '2026-09-26T09:00:00.000Z',
                completedAt: '2026-09-26T09:00:00.000Z',
              },
              failureReason: '',
              updatedAt: '2026-09-26T09:00:00.000Z',
            },
            {
              id: 'item-001-order-1',
              batchId: 'batch-001-1',
              systemId: 'sys-order',
              taskId: 'req-001-execute-sys-order',
              attempt: 1,
              status: 'succeeded',
              receipt: {
                receiptNo: 'RCPT-DSR-2026-001-B1-ORDER-A1',
                outcome: 'success',
                failureReason: '',
                receivedAt: '2026-09-27T11:00:00.000Z',
                completedAt: '2026-09-27T11:00:00.000Z',
              },
              failureReason: '',
              updatedAt: '2026-09-27T11:00:00.000Z',
            },
            {
              id: 'item-001-support-1',
              batchId: 'batch-001-1',
              systemId: 'sys-support',
              taskId: 'req-001-execute-sys-support',
              attempt: 1,
              status: 'sent',
              failureReason: '',
              updatedAt: '2026-09-25T04:20:00.000Z',
            },
          ],
        },
      ],
      evidence: [
        {
          id: 'evidence-001-a',
          stepId: 'req-001-identity',
          name: '身份核验记录',
          evidenceType: 'signed-record',
          digest: '9A11-77D2',
          uploadedBy: '当前客服',
          uploadedAt: '2026-09-25T04:10:00.000Z',
          protected: true,
        },
      ],
      conflicts: [],
      resultSummary: '',
      closureReason: '',
      audit: [
        audit(
          'req-audit-001',
          '登记请求',
          '客服专员',
          '访问请求已登记，并生成 30 日流程。',
          request1At,
        ),
      ],
    },
    {
      id: 'req-002',
      code: 'DSR-2026-002',
      requesterName: '王宁',
      requesterContact: 'wa***@example.com',
      region: 'eu',
      type: 'deletion',
      status: 'review-required',
      identity: {
        status: 'insufficient',
        materialType: 'authorization-letter',
        maskedReference: '授权书仅含截图',
        protectedDigest: 'AUTH-11E9',
        note: '缺少委托关系证明，需进入身份材料复核。',
      },
      requestedAt: request2At,
      dueAt: request2Due,
      extendedDays: 0,
      duplicateOf: 'req-005',
      affectedSystemIds: ['sys-crm', 'sys-marketing', 'sys-support'],
      tasks: buildWorkflowSteps({
        requestId: 'req-002',
        type: 'deletion',
        systemIds: ['sys-crm', 'sys-marketing', 'sys-support'],
        requestedAt: request2At,
        dueAt: request2Due,
        initialStatus: 'review-required',
        systems,
      }),
      batches: [],
      evidence: [],
      conflicts: [
        '身份材料不足：授权书无法证明申请人与数据主体关系。',
        '疑似重复请求：与 DSR-2026-005 的请求人和处理类型相同。',
      ],
      resultSummary: '',
      closureReason: '',
      audit: [
        audit(
          'req-audit-002',
          '转入复核队列',
          '隐私运营',
          '身份材料不足且检测到疑似重复请求。',
          '2026-09-19T02:00:00.000Z',
        ),
      ],
    },
    {
      id: 'req-003',
      code: 'DSR-2026-003',
      requesterName: '刘晓',
      requesterContact: 'li***@example.com',
      region: 'us',
      type: 'rectification',
      status: 'review-required',
      identity: {
        status: 'verified',
        materialType: 'account-ownership',
        maskedReference: '账号所有权验证通过',
        protectedDigest: 'ACC-559A',
        note: '依据登录挑战与近期交易完成核验。',
        reviewedAt: '2026-09-21T05:30:00.000Z',
      },
      requestedAt: request3At,
      dueAt: request3Due,
      extendedDays: 0,
      affectedSystemIds: ['sys-crm', 'sys-risk', 'sys-support'],
      tasks: request3Tasks,
      batches: [
        {
          id: 'batch-003-1',
          requestId: 'req-003',
          sequence: 1,
          scopeHash: request3Scope,
          scopeSnapshot: {
            type: 'rectification',
            systemIds: ['sys-crm', 'sys-risk', 'sys-support'],
            taskIds: [
              'req-003-execute-sys-crm',
              'req-003-execute-sys-risk',
              'req-003-execute-sys-support',
            ],
          },
          status: 'in-flight',
          dispatchedAt: '2026-09-21T06:00:00.000Z',
          dispatchedBy: '隐私运营',
          items: [
            {
              id: 'item-003-crm-1',
              batchId: 'batch-003-1',
              systemId: 'sys-crm',
              taskId: 'req-003-execute-sys-crm',
              attempt: 1,
              status: 'succeeded',
              receipt: {
                receiptNo: 'RCPT-DSR-2026-003-B1-CRM-A1',
                outcome: 'success',
                failureReason: '',
                receivedAt: '2026-09-22T10:00:00.000Z',
                completedAt: '2026-09-22T10:00:00.000Z',
              },
              failureReason: '',
              updatedAt: '2026-09-22T10:00:00.000Z',
            },
            {
              id: 'item-003-risk-1',
              batchId: 'batch-003-1',
              systemId: 'sys-risk',
              taskId: 'req-003-execute-sys-risk',
              attempt: 1,
              status: 'failed',
              receipt: {
                receiptNo: 'RCPT-DSR-2026-003-B1-RISK-A1',
                outcome: 'failure',
                failureReason: '法务保留：反欺诈风险标签需例外审查，暂缓更正。',
                receivedAt: '2026-09-28T08:30:00.000Z',
              },
              failureReason: '法务保留：反欺诈风险标签需例外审查，暂缓更正。',
              updatedAt: '2026-09-28T08:30:00.000Z',
            },
            {
              id: 'item-003-support-1',
              batchId: 'batch-003-1',
              systemId: 'sys-support',
              taskId: 'req-003-execute-sys-support',
              attempt: 1,
              status: 'sent',
              failureReason: '',
              updatedAt: '2026-09-21T06:00:00.000Z',
            },
          ],
        },
      ],
      evidence: [],
      conflicts: [
        '批次回执失败：风控决策平台 —— 法务保留：反欺诈风险标签需例外审查，暂缓更正。',
        '跨系统结果冲突：客户系统中的姓名已更正，但风控平台仍保留旧值。',
      ],
      resultSummary: '',
      closureReason: '',
      audit: [
        audit(
          'req-audit-003',
          '发现跨系统冲突',
          '数据管理员',
          '风控平台拒绝更新风险标签关联姓名。',
          '2026-09-28T08:30:00.000Z',
        ),
      ],
    },
    {
      id: 'req-004',
      code: 'DSR-2026-004',
      requesterName: '陈妙',
      requesterContact: 'ch***@example.com',
      region: 'sg',
      type: 'withdraw-consent',
      status: 'pending-close',
      identity: {
        status: 'verified',
        materialType: 'account-ownership',
        maskedReference: '账号所有权验证通过',
        protectedDigest: 'ACC-880D',
        note: '账号双因素验证通过。',
        reviewedAt: '2026-09-24T07:00:00.000Z',
      },
      requestedAt: request4At,
      dueAt: request4Due,
      extendedDays: 0,
      affectedSystemIds: ['sys-marketing'],
      tasks: request4Tasks,
      batches: [
        {
          id: 'batch-004-1',
          requestId: 'req-004',
          sequence: 1,
          scopeHash: request4Scope,
          scopeSnapshot: {
            type: 'withdraw-consent',
            systemIds: ['sys-marketing'],
            taskIds: ['req-004-execute-sys-marketing'],
          },
          status: 'settled',
          dispatchedAt: '2026-09-24T07:10:00.000Z',
          dispatchedBy: '隐私运营',
          settledAt: '2026-09-28T09:00:00.000Z',
          items: [
            {
              id: 'item-004-marketing-1',
              batchId: 'batch-004-1',
              systemId: 'sys-marketing',
              taskId: 'req-004-execute-sys-marketing',
              attempt: 1,
              status: 'succeeded',
              receipt: {
                receiptNo: 'RCPT-DSR-2026-004-B1-MARKETING-A1',
                outcome: 'success',
                failureReason: '',
                receivedAt: '2026-09-28T09:00:00.000Z',
                completedAt: '2026-09-28T09:00:00.000Z',
              },
              failureReason: '',
              updatedAt: '2026-09-28T09:00:00.000Z',
            },
          ],
        },
      ],
      evidence: [
        {
          id: 'evidence-004-a',
          stepId: 'req-004-execute-sys-marketing',
          name: '同意状态变更日志',
          evidenceType: 'execution-log',
          digest: 'E31A-880D',
          uploadedBy: '增长技术组',
          uploadedAt: '2026-09-28T09:00:00.000Z',
          protected: true,
        },
      ],
      conflicts: [],
      resultSummary: '营销平台已撤回同意并停止后续自动化触达。',
      closureReason: '',
      audit: [
        audit(
          'req-audit-004',
          '待关闭复核',
          '隐私运营',
          '全部系统任务已完成，等待负责人确认结果。',
          '2026-09-28T09:10:00.000Z',
        ),
      ],
    },
    {
      id: 'req-005',
      code: 'DSR-2026-005',
      requesterName: '王宁',
      requesterContact: 'wa***@example.com',
      region: 'eu',
      type: 'deletion',
      status: 'completed',
      identity: {
        status: 'verified',
        materialType: 'masked-id',
        maskedReference: '310***********8832',
        protectedDigest: 'ID-771B',
        note: '身份核验已完成。',
        reviewedAt: '2026-09-05T03:30:00.000Z',
      },
      requestedAt: request5At,
      dueAt: request5Due,
      extendedDays: 0,
      affectedSystemIds: ['sys-crm', 'sys-marketing'],
      tasks: request5Tasks,
      batches: [
        {
          id: 'batch-005-1',
          requestId: 'req-005',
          sequence: 1,
          scopeHash: request5Scope,
          scopeSnapshot: {
            type: 'deletion',
            systemIds: ['sys-crm', 'sys-marketing'],
            taskIds: ['req-005-execute-sys-crm', 'req-005-execute-sys-marketing'],
          },
          status: 'settled',
          dispatchedAt: '2026-09-05T04:00:00.000Z',
          dispatchedBy: '隐私运营',
          settledAt: '2026-09-09T06:00:00.000Z',
          items: [
            {
              id: 'item-005-crm-1',
              batchId: 'batch-005-1',
              systemId: 'sys-crm',
              taskId: 'req-005-execute-sys-crm',
              attempt: 1,
              status: 'succeeded',
              receipt: {
                receiptNo: 'RCPT-DSR-2026-005-B1-CRM-A1',
                outcome: 'success',
                failureReason: '',
                receivedAt: '2026-09-08T05:00:00.000Z',
                completedAt: '2026-09-08T05:00:00.000Z',
              },
              failureReason: '',
              updatedAt: '2026-09-08T05:00:00.000Z',
            },
            {
              id: 'item-005-marketing-1',
              batchId: 'batch-005-1',
              systemId: 'sys-marketing',
              taskId: 'req-005-execute-sys-marketing',
              attempt: 1,
              status: 'succeeded',
              receipt: {
                receiptNo: 'RCPT-DSR-2026-005-B1-MARKETING-A1',
                outcome: 'success',
                failureReason: '',
                receivedAt: '2026-09-09T06:00:00.000Z',
                completedAt: '2026-09-09T06:00:00.000Z',
              },
              failureReason: '',
              updatedAt: '2026-09-09T06:00:00.000Z',
            },
          ],
        },
      ],
      evidence: [
        {
          id: 'evidence-005-a',
          stepId: 'req-005-execute-sys-crm',
          name: '删除执行回执',
          evidenceType: 'system-response',
          digest: 'E5A0-1201',
          uploadedBy: '客户平台组',
          uploadedAt: '2026-09-08T05:00:00.000Z',
          protected: true,
        },
      ],
      conflicts: [],
      resultSummary: '已完成请求主体在两个系统中的删除，并保留最小合规凭证。',
      closureReason: '期限已到且任务完整，经复核后关闭。',
      audit: [
        audit(
          'req-audit-005',
          '完成请求',
          '隐私负责人',
          '处理结果合并完成并生成操作审计。',
          '2026-09-10T02:00:00.000Z',
        ),
      ],
    },
  ]

  return {
    requests,
    systems,
    comments: [
      {
        id: 'comment-001',
        requestId: 'req-003',
        author: '风控平台管理员',
        content: '风险标签属于反欺诈例外审查范围，不能直接按普通资料更正。',
        createdAt: '2026-09-28T08:35:00.000Z',
      },
      {
        id: 'comment-002',
        requestId: 'req-002',
        author: '隐私运营',
        content: '请先确认该请求与 DSR-2026-005 是否属于重复申请。',
        createdAt: '2026-09-19T02:05:00.000Z',
      },
    ],
    audit: [
      {
        id: 'audit-global-1',
        requestId: 'req-001',
        action: '登记请求',
        operator: '客服专员',
        detail: '访问请求进入 30 日履约流程。',
        createdAt: request1At,
      },
      {
        id: 'audit-global-2',
        requestId: 'req-002',
        action: '身份材料复核',
        operator: '隐私运营',
        detail: '身份材料不足并检测到疑似重复请求。',
        createdAt: '2026-09-19T02:00:00.000Z',
      },
      {
        id: 'audit-global-3',
        requestId: 'req-003',
        action: '跨系统结果冲突',
        operator: '数据管理员',
        detail: '风控平台与客户系统结果不一致，进入复核队列。',
        createdAt: '2026-09-28T08:30:00.000Z',
      },
    ],
    revision: 1,
  }
}

export const requestTypeOptions = [
  { value: 'access', label: '访问' },
  { value: 'rectification', label: '更正' },
  { value: 'deletion', label: '删除' },
  { value: 'withdraw-consent', label: '撤回同意' },
  { value: 'restriction', label: '限制处理' },
] as const
