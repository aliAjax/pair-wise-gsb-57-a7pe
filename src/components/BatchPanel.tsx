'use client'

import { useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  FormLabel,
  Heading,
  HStack,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Select,
  SimpleGrid,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tr,
  VStack,
  useDisclosure,
  useToast,
} from '@chakra-ui/react'
import { Layers, RefreshCw, Send } from 'lucide-react'
import {
  useBatchReceiptMutation,
  useDispatchBatchMutation,
  useRetryBatchMutation,
} from '@/lib/hooks'
import {
  batchItemStatusLabels,
  batchStatusLabels,
  type BatchItem,
  type ExecutionBatch,
  type PrivacyRequest,
  type WorkspaceState,
} from '@/lib/schemas'
import { batchConclusion, isBatchStale } from '@/services/batchService'
const itemBadge: Record<BatchItem['status'], string> = {
  pending: 'gray',
  succeeded: 'green',
  failed: 'red',
  voided: 'purple',
}

export function BatchPanel({
  request,
  workspace,
}: {
  request: PrivacyRequest
  workspace: WorkspaceState
}) {
  const toast = useToast()
  const dispatchBatch = useDispatchBatchMutation()
  const registerReceipt = useBatchReceiptMutation()
  const retryBatch = useRetryBatchMutation()
  const dispatchDialog = useDisclosure()
  const receiptDialog = useDisclosure()
  const [selectedBatchId, setSelectedBatchId] = useState('')
  const [selectedSystemId, setSelectedSystemId] = useState('')
  const [dispatchNote, setDispatchNote] = useState('')
  const [receiptResult, setReceiptResult] = useState<'succeeded' | 'failed'>('succeeded')
  const [receiptRef, setReceiptRef] = useState('')
  const [failureReason, setFailureReason] = useState('')
  const [legalHold, setLegalHold] = useState(false)

  const conclusion = batchConclusion(request)
  const currentBatch: ExecutionBatch | undefined =
    request.batches.find((batch) => batch.id === selectedBatchId) ?? request.batches[0]
  const systemName = (systemId: string) =>
    workspace.systems.find((system) => system.id === systemId)?.name ?? systemId

  function openReceipt(batchId: string, systemId: string) {
    setSelectedBatchId(batchId)
    setSelectedSystemId(systemId)
    const item = request.batches
      .find((batch) => batch.id === batchId)
      ?.items.find((entry) => entry.systemId === systemId)
    setReceiptResult(item?.status === 'failed' ? 'failed' : 'succeeded')
    setReceiptRef('')
    setFailureReason('')
    setLegalHold(false)
    receiptDialog.onOpen()
  }

  function openDispatch() {
    setDispatchNote('')
    dispatchDialog.onOpen()
  }

  async function submitDispatch() {
    try {
      await dispatchBatch.mutateAsync({
        requestId: request.id,
        note: dispatchNote.trim(),
        operator: '隐私运营',
      })
      toast({ title: '执行批次已发出', status: 'success' })
      dispatchDialog.onClose()
    } catch (error) {
      toast({
        title: '批次未能发出',
        description: error instanceof Error ? error.message : '请检查前置条件',
        status: 'error',
      })
    }
  }

  async function submitReceipt() {
    if (!currentBatch) return
    try {
      await registerReceipt.mutateAsync({
        requestId: request.id,
        batchId: currentBatch.id,
        systemId: selectedSystemId,
        result: receiptResult,
        receiptRef: receiptRef.trim(),
        failureReason: failureReason.trim(),
        legalHold: receiptResult === 'failed' ? legalHold : undefined,
        operator: '数据管理员',
      })
      toast({
        title: receiptResult === 'succeeded' ? '成功回执已冻结' : '失败原因已登记',
        status: 'success',
      })
      receiptDialog.onClose()
    } catch (error) {
      toast({
        title: '回执未被接受',
        description: error instanceof Error ? error.message : '请检查批次状态',
        status: 'error',
      })
    }
  }

  async function retry(batch: ExecutionBatch) {
    try {
      await retryBatch.mutateAsync({
        requestId: request.id,
        batchId: batch.id,
        operator: '隐私运营',
      })
      toast({ title: '已只重试失败项，成功回执保持不变', status: 'success' })
    } catch (error) {
      toast({
        title: '重试未执行',
        description: error instanceof Error ? error.message : '请检查批次状态',
        status: 'error',
      })
    }
  }

  const alertStatus =
    conclusion.kind === 'all-succeeded'
      ? 'success'
      : conclusion.kind === 'none'
        ? 'info'
        : 'error'

  return (
    <Box className="panel">
      <Flex className="panel-title">
        <HStack>
          <Layers size={17} color="#237b78" />
          <Heading size="sm">跨系统执行批次</Heading>
        </HStack>
        <HStack>
          {request.batches.length > 1 && currentBatch ? (
            <Select
              width="240px"
              size="xs"
              value={currentBatch.id}
              onChange={(event) => setSelectedBatchId(event.target.value)}
            >
              {request.batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.code} · {batchStatusLabels[batch.status]}
                </option>
              ))}
            </Select>
          ) : null}
          {!request.batches.some((batch) => batch.status === 'running') ? (
            <Button
              size="xs"
              colorScheme="brand"
              leftIcon={<Send size={13} />}
              isDisabled={request.identity.status !== 'verified'}
              onClick={openDispatch}
            >
              {request.batches.length ? '按当前范围发出新批次' : '发出执行批次'}
            </Button>
          ) : (
            <Badge colorScheme="blue">批次执行中</Badge>
          )}
        </HStack>
      </Flex>

      <Alert status={alertStatus} mb="4" borderRadius="5px">
        <VStack align="stretch" spacing="1">
          <Text fontWeight="700">{conclusion.label}</Text>
          <Text fontSize="sm">{conclusion.detail}</Text>
        </VStack>
      </Alert>

      {currentBatch ? (
        <>
          <SimpleGrid columns={4} spacing="3" mb="3">
            <Box>
              <Text color="gray.500" fontSize="xs">
                批次编号
              </Text>
              <Text className="mono" fontWeight="600" fontSize="sm">
                {currentBatch.code}
              </Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                批次状态
              </Text>
              <Badge
                mt="1"
                colorScheme={
                  currentBatch.status === 'completed'
                    ? 'green'
                    : currentBatch.status === 'superseded'
                      ? 'purple'
                      : 'blue'
                }
              >
                {batchStatusLabels[currentBatch.status]}
              </Badge>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                发出时间
              </Text>
              <Text fontSize="sm">{new Date(currentBatch.createdAt).toLocaleString('zh-CN')}</Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                范围版本 / 摘要
              </Text>
              <Text className="mono" fontSize="sm">
                v{currentBatch.scopeVersion} · {currentBatch.scopeDigest}
              </Text>
            </Box>
          </SimpleGrid>

          {isBatchStale(currentBatch, request) ? (
            <Alert status="warning" mb="3" borderRadius="5px">
              当前请求处于第 {request.scopeVersion} 版范围，本批次固化的是第{' '}
              {currentBatch.scopeVersion} 版。任何迟到回执都会自动作废并转入复核，不会覆盖新安排。
            </Alert>
          ) : null}

          <TableContainer>
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>系统</Th>
                  <Th>状态</Th>
                  <Th>最终回执 / 失败原因</Th>
                  <Th>完成时间</Th>
                  <Th>尝试</Th>
                  <Th>操作</Th>
                </Tr>
              </Thead>
              <Tbody>
                {currentBatch.items.map((item) => {
                  const stale = isBatchStale(currentBatch, request)
                  const canRegister =
                    !stale &&
                    currentBatch.status === 'running' &&
                    (item.status === 'pending' || item.status === 'failed')
                  return (
                    <Tr key={item.systemId}>
                      <Td>
                        <Text fontWeight="600">{systemName(item.systemId)}</Text>
                        {item.legalHold ? <Badge colorScheme="orange">法务保留</Badge> : null}
                      </Td>
                      <Td>
                        <Badge colorScheme={itemBadge[item.status]}>
                          {batchItemStatusLabels[item.status]}
                        </Badge>
                      </Td>
                      <Td maxW="300px">
                        {item.status === 'succeeded' ? (
                          <Text className="mono" fontSize="sm">
                            {item.receiptRef}
                          </Text>
                        ) : item.status === 'failed' ? (
                          <Text color="red.600" fontSize="sm">
                            {item.failureReason}
                          </Text>
                        ) : item.status === 'voided' ? (
                          <Text color="purple.600" fontSize="sm">
                            {item.attempts.find((attempt) => attempt.voided)?.receiptRef
                              ? `迟到回执 ${item.attempts.find((attempt) => attempt.voided)?.receiptRef} 已作废`
                              : '迟到结果已作废，转复核'}
                          </Text>
                        ) : (
                          <Text color="gray.500" fontSize="sm">
                            等待系统回执
                          </Text>
                        )}
                      </Td>
                      <Td whiteSpace="nowrap">
                        {item.receiptAt
                          ? new Date(item.receiptAt).toLocaleString('zh-CN')
                          : '—'}
                      </Td>
                      <Td>{item.attempts.length}</Td>
                      <Td>
                        <HStack>
                          {canRegister ? (
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => openReceipt(currentBatch.id, item.systemId)}
                            >
                              登记回执
                            </Button>
                          ) : null}
                          {item.status === 'succeeded' ? (
                            <Text color="gray.400" fontSize="xs">
                              已冻结
                            </Text>
                          ) : null}
                        </HStack>
                      </Td>
                    </Tr>
                  )
                })}
              </Tbody>
            </Table>
          </TableContainer>

          {currentBatch.status === 'running' &&
          currentBatch.items.some((item) => item.status === 'failed') &&
          !isBatchStale(currentBatch, request) ? (
            <Flex mt="3" justify="flex-end">
              <Button
                size="sm"
                colorScheme="orange"
                leftIcon={<RefreshCw size={14} />}
                onClick={() => void retry(currentBatch)}
              >
                只重试 {currentBatch.items.filter((item) => item.status === 'failed').length} 个失败项
              </Button>
            </Flex>
          ) : null}
        </>
      ) : (
        <Text color="gray.500" fontSize="sm">
          身份核验通过后发出执行批次；发出后各系统分别登记最终回执与失败原因。
        </Text>
      )}

      <Modal isOpen={dispatchDialog.isOpen} onClose={dispatchDialog.onClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>发出跨系统执行批次</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Alert status="info" mb="3" borderRadius="5px">
              批次将固化当前范围（{request.affectedSystemIds.length} 个系统、第{' '}
              {request.scopeVersion} 版）。发出后范围再有更新，旧批次迟到回执将作废并转复核。
            </Alert>
            <FormControl>
              <FormLabel>批次说明（可选）</FormLabel>
              <Textarea
                value={dispatchNote}
                onChange={(event) => setDispatchNote(event.target.value)}
                placeholder="例如 本轮按客户补充材料后的范围执行清除/更正"
              />
            </FormControl>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={dispatchDialog.onClose}>
              取消
            </Button>
            <Button colorScheme="brand" isLoading={dispatchBatch.isPending} onClick={submitDispatch}>
              发出批次
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={receiptDialog.isOpen} onClose={receiptDialog.onClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>
            登记 {selectedSystemId ? systemName(selectedSystemId) : ''} 的最终回执
          </ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack align="stretch" spacing="4">
              <FormControl>
                <FormLabel>执行结果</FormLabel>
                <Select
                  value={receiptResult}
                  onChange={(event) =>
                    setReceiptResult(event.target.value as 'succeeded' | 'failed')
                  }
                >
                  <option value="succeeded">成功（冻结最终回执与完成时间）</option>
                  <option value="failed">失败（登记失败原因，可仅重试本项）</option>
                </Select>
              </FormControl>
              {receiptResult === 'succeeded' ? (
                <FormControl isRequired>
                  <FormLabel>最终回执编号</FormLabel>
                  <Input
                    value={receiptRef}
                    onChange={(event) => setReceiptRef(event.target.value)}
                    placeholder="例如 CRM-ACK-77421"
                  />
                </FormControl>
              ) : (
                <>
                  <FormControl isRequired>
                    <FormLabel>失败原因</FormLabel>
                    <Textarea
                      value={failureReason}
                      onChange={(event) => setFailureReason(event.target.value)}
                      placeholder="说明失败原因，例如法务保留、系统异常、数据定位失败"
                    />
                  </FormControl>
                  <Checkbox isChecked={legalHold} onChange={(event) => setLegalHold(event.target.checked)}>
                    因法务保留（Legal Hold）停止执行
                  </Checkbox>
                </>
              )}
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={receiptDialog.onClose}>
              取消
            </Button>
            <Button colorScheme="brand" isLoading={registerReceipt.isPending} onClick={submitReceipt}>
              提交回执
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}
