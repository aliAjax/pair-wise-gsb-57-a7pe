import type { DataSystem, PrivacyRequest, WorkspaceState } from '@/types/domain'
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

  const requests: PrivacyRequest[] = [
    {
      id: 'req-001',
      code: 'DSR-2026-001',
      requesterName: '张晨',
      requesterContact: 'zh***@example.com',
      region: 'cn',
      type: 'access',
      status: 'review-required',
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
      scopeVersion: 1,
      affectedSystemIds: ['sys-crm', 'sys-order', 'sys-support'],
      tasks: buildWorkflowSteps({
        requestId: 'req-001',
        type: 'access',
        systemIds: ['sys-crm', 'sys-order', 'sys-support'],
        requestedAt: request1At,
        dueAt: request1Due,
        initialStatus: 'processing',
        systems,
      }),
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
      conflicts: [
        '系统执行失败（批次 DSR-2026-001-B01 · 订单与交易平台）：法务保留生效，离线加密包导出被阻断（保留案号 LH-2026-118）；重试只处理该失败项。',
      ],
      batches: [
        {
          id: 'batch-001',
          code: 'DSR-2026-001-B01',
          createdAt: '2026-09-25T06:00:00.000Z',
          createdBy: '隐私运营',
          requestType: 'access',
          systemIds: ['sys-crm', 'sys-order', 'sys-support'],
          scopeDigest: 'SC-5029BB3F',
          scopeVersion: 1,
          status: 'running',
          note: '跨系统访问请求统一批次，各系统分别回执。',
          items: [
            {
              systemId: 'sys-crm',
              status: 'succeeded',
              attempts: [
                {
                  id: 'attempt-001-crm',
                  startedAt: '2026-09-25T06:00:00.000Z',
                  finishedAt: '2026-09-26T03:12:00.000Z',
                  result: 'succeeded',
                  receiptRef: 'CRM-ACK-77421',
                },
              ],
              receiptRef: 'CRM-ACK-77421',
              receiptAt: '2026-09-26T03:12:00.000Z',
            },
            {
              systemId: 'sys-order',
              status: 'failed',
              attempts: [
                {
                  id: 'attempt-001-order',
                  startedAt: '2026-09-25T06:00:00.000Z',
                  finishedAt: '2026-09-27T08:45:00.000Z',
                  result: 'failed',
                  failureReason: '法务保留生效，离线加密包导出被阻断（保留案号 LH-2026-118）。',
                  legalHold: true,
                },
              ],
              failureReason: '法务保留生效，离线加密包导出被阻断（保留案号 LH-2026-118）。',
              legalHold: true,
            },
            {
              systemId: 'sys-support',
              status: 'succeeded',
              attempts: [
                {
                  id: 'attempt-001-support',
                  startedAt: '2026-09-25T06:00:00.000Z',
                  finishedAt: '2026-09-26T09:30:00.000Z',
                  result: 'succeeded',
                  receiptRef: 'SUP-RCP-3309',
                },
              ],
              receiptRef: 'SUP-RCP-3309',
              receiptAt: '2026-09-26T09:30:00.000Z',
            },
          ],
        },
      ],
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
        audit(
          'req-audit-001-batch',
          '发出跨系统执行批次',
          '隐私运营',
          '批次 DSR-2026-001-B01 已发出，覆盖 3 个系统（范围版本第 1 版，SC-5029BB3F）。',
          '2026-09-25T06:00:00.000Z',
        ),
        audit(
          'req-audit-001-fail',
          '登记系统执行失败',
          '交易系统组',
          '订单与交易平台执行失败：法务保留（LH-2026-118），其余系统不受影响。',
          '2026-09-27T08:45:00.000Z',
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
      scopeVersion: 1,
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
      evidence: [],
      conflicts: [
        '身份材料不足：授权书无法证明申请人与数据主体关系。',
        '疑似重复请求：与 DSR-2026-005 的请求人和处理类型相同。',
      ],
      batches: [],
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
      scopeVersion: 2,
      affectedSystemIds: ['sys-crm', 'sys-risk', 'sys-support'],
      tasks: (() => {
        const base = buildWorkflowSteps({
          requestId: 'req-003',
          type: 'rectification',
          systemIds: ['sys-crm', 'sys-risk', 'sys-support'],
          requestedAt: request3At,
          dueAt: request3Due,
          initialStatus: 'processing',
          systems,
        }).map((step, index) =>
          index === 1 ? { ...step, status: 'blocked' as const, exceptionReason: '风控平台返回值与客服系统不一致。' } : step,
        )
        const withLegalStep = base.flatMap((step) =>
          step.id === 'req-003-locate-sys-risk'
            ? [
                {
                  id: 'req-003-legal-review',
                  order: 0,
                  name: '风控标签更正法务例外复核',
                  role: '隐私负责人',
                  systemId: 'sys-risk',
                  status: 'blocked' as const,
                  assignee: '隐私负责人',
                  dueAt: request3Due,
                  exceptionReason: '范围更新后新增的法务例外复核任务。',
                },
                step,
              ]
            : [step],
        )
        return withLegalStep.map((step, index) => ({ ...step, order: index + 1 }))
      })(),
      evidence: [],
      conflicts: [
        '批次 DSR-2026-003-B01 已被第 2 版范围替代：该批次此后到达的系统回执一律作废并转入复核，需按新范围重新发出批次。',
        '迟到回执作废（批次 DSR-2026-003-B01 · 风控决策平台）：批次发出后请求范围已更新到第 2 版，迟到的成功回执不覆盖新安排，已转人工复核。',
      ],
      batches: [
        {
          id: 'batch-003',
          code: 'DSR-2026-003-B01',
          createdAt: '2026-09-22T03:00:00.000Z',
          createdBy: '隐私运营',
          requestType: 'rectification',
          systemIds: ['sys-crm', 'sys-risk', 'sys-support'],
          scopeDigest: 'SC-8EE4FE5E',
          scopeVersion: 1,
          status: 'superseded',
          note: '首版更正批次。',
          items: [
            {
              systemId: 'sys-crm',
              status: 'succeeded',
              attempts: [
                {
                  id: 'attempt-003-crm',
                  startedAt: '2026-09-22T03:00:00.000Z',
                  finishedAt: '2026-09-23T02:20:00.000Z',
                  result: 'succeeded',
                  receiptRef: 'CRM-UPD-2105',
                },
              ],
              receiptRef: 'CRM-UPD-2105',
              receiptAt: '2026-09-23T02:20:00.000Z',
            },
            {
              systemId: 'sys-risk',
              status: 'failed',
              attempts: [
                {
                  id: 'attempt-003-risk-fail',
                  startedAt: '2026-09-22T03:00:00.000Z',
                  finishedAt: '2026-09-28T08:30:00.000Z',
                  result: 'failed',
                  failureReason: '风控平台拒绝更新风险标签关联姓名，需走法务例外。',
                },
                {
                  id: 'attempt-003-risk-late',
                  startedAt: '2026-09-28T08:31:00.000Z',
                  finishedAt: '2026-09-29T07:55:00.000Z',
                  result: 'succeeded',
                  voided: true,
                  receiptRef: 'RSK-UPD-8842',
                },
              ],
              failureReason: '风控平台拒绝更新风险标签关联姓名，需走法务例外。',
            },
            {
              systemId: 'sys-support',
              status: 'voided',
              attempts: [
                {
                  id: 'attempt-003-support',
                  startedAt: '2026-09-22T03:00:00.000Z',
                  finishedAt: '2026-09-29T10:10:00.000Z',
                  result: 'succeeded',
                  voided: true,
                  receiptRef: 'SUP-UPD-5571',
                },
              ],
            },
          ],
        },
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
        audit(
          'req-audit-003-scope',
          '更新请求信息',
          '隐私运营',
          '请求范围更新（履约任务调整），执行中批次 DSR-2026-003-B01 已作废，未决项与迟到回执转入复核。',
          '2026-09-28T12:00:00.000Z',
        ),
        audit(
          'req-audit-003-void',
          '迟到回执作废并转复核',
          '风险技术组',
          '风控决策平台的成功回执属于旧批次 DSR-2026-003-B01（第 1 版范围），已作废并转入复核队列。',
          '2026-09-29T07:55:00.000Z',
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
      scopeVersion: 1,
      affectedSystemIds: ['sys-marketing'],
      tasks: buildWorkflowSteps({
        requestId: 'req-004',
        type: 'withdraw-consent',
        systemIds: ['sys-marketing'],
        requestedAt: request4At,
        dueAt: request4Due,
        initialStatus: 'pending-close',
        systems,
      }),
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
      batches: [
        {
          id: 'batch-004',
          code: 'DSR-2026-004-B01',
          createdAt: '2026-09-24T08:00:00.000Z',
          createdBy: '隐私运营',
          requestType: 'withdraw-consent',
          systemIds: ['sys-marketing'],
          scopeDigest: 'SC-0D42B36B',
          scopeVersion: 1,
          status: 'completed',
          note: '撤回同意批次，单系统回执。',
          items: [
            {
              systemId: 'sys-marketing',
              status: 'succeeded',
              attempts: [
                {
                  id: 'attempt-004-marketing',
                  startedAt: '2026-09-24T08:00:00.000Z',
                  finishedAt: '2026-09-28T09:00:00.000Z',
                  result: 'succeeded',
                  receiptRef: 'MKT-WD-1027',
                },
              ],
              receiptRef: 'MKT-WD-1027',
              receiptAt: '2026-09-28T09:00:00.000Z',
            },
          ],
        },
      ],
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
      scopeVersion: 1,
      affectedSystemIds: ['sys-crm', 'sys-marketing'],
      tasks: buildWorkflowSteps({
        requestId: 'req-005',
        type: 'deletion',
        systemIds: ['sys-crm', 'sys-marketing'],
        requestedAt: request5At,
        dueAt: request5Due,
        initialStatus: 'completed',
        systems,
      }),
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
      batches: [
        {
          id: 'batch-005',
          code: 'DSR-2026-005-B01',
          createdAt: '2026-09-06T02:00:00.000Z',
          createdBy: '隐私运营',
          requestType: 'deletion',
          systemIds: ['sys-crm', 'sys-marketing'],
          scopeDigest: 'SC-9C68A205',
          scopeVersion: 1,
          status: 'completed',
          note: '删除批次，全部系统成功。',
          items: [
            {
              systemId: 'sys-crm',
              status: 'succeeded',
              attempts: [
                {
                  id: 'attempt-005-crm',
                  startedAt: '2026-09-06T02:00:00.000Z',
                  finishedAt: '2026-09-08T05:00:00.000Z',
                  result: 'succeeded',
                  receiptRef: 'CRM-DEL-9910',
                },
              ],
              receiptRef: 'CRM-DEL-9910',
              receiptAt: '2026-09-08T05:00:00.000Z',
            },
            {
              systemId: 'sys-marketing',
              status: 'succeeded',
              attempts: [
                {
                  id: 'attempt-005-marketing',
                  startedAt: '2026-09-06T02:00:00.000Z',
                  finishedAt: '2026-09-09T03:40:00.000Z',
                  result: 'succeeded',
                  receiptRef: 'MKT-DEL-4412',
                },
              ],
              receiptRef: 'MKT-DEL-4412',
              receiptAt: '2026-09-09T03:40:00.000Z',
            },
          ],
        },
      ],
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
