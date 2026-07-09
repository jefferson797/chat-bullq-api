import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConversationStatus, Prisma } from '@prisma/client';
import type { Job } from 'bullmq';

import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { HttpToolExecutorService } from '../tools/http-tool-executor.service';
import type { ToolContext } from '../tools/tool.types';
import { PendingActionStorage } from './pending-action.storage';
import {
  PENDING_ACTION_EXECUTOR_QUEUE,
  PENDING_EXPIRE_JOB,
} from './queue-names';

export {
  PENDING_ACTION_EXECUTOR_QUEUE,
  PENDING_EXECUTE_JOB,
  PENDING_EXPIRE_JOB,
} from './queue-names';

type ExecutorJobData =
  | { pendingActionId: string }
  | Record<string, never>;

/**
 * Fase 2.5: executor pós-aprovação.
 *
 * Quando o operador aprova um `AiPendingAction`, o `PendingActionService`
 * enfileira aqui. Esse worker:
 *   - resolve a tool original (built-in `transferToHuman` ou skill HTTP)
 *   - executa de fato (HTTP com `bypassPendingGate: true` pra evitar loop)
 *   - grava `executionResult` e marca status `EXECUTED`
 *
 * Falhas resultam em status PENDING + executionResult com error → operador
 * pode re-aprovar. Não bloqueia outras pendings.
 */
@Processor(PENDING_ACTION_EXECUTOR_QUEUE, { concurrency: 4 })
export class PendingActionExecutorProcessor extends WorkerHost {
  private readonly logger = new Logger(PendingActionExecutorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpExecutor: HttpToolExecutorService,
    private readonly storage: PendingActionStorage,
    private readonly realtime: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<ExecutorJobData>): Promise<unknown> {
    if (job.name === PENDING_EXPIRE_JOB) {
      return this.expireOverdueActions();
    }
    const { pendingActionId } = job.data as { pendingActionId: string };
    const action = await this.storage.get(pendingActionId);

    if (!action) {
      this.logger.warn(`Pending action ${pendingActionId} not found`);
      return { skipped: true, reason: 'not_found' };
    }
    if (action.status !== 'APPROVED') {
      this.logger.warn(
        `Pending action ${pendingActionId} status=${action.status} (skipping execution)`,
      );
      return { skipped: true, reason: `status_${action.status}` };
    }

    let result: unknown;
    let success = true;

    try {
      if (action.toolName === 'transferToHuman') {
        result = await this.executeTransferToHuman(action);
      } else {
        result = await this.executeHttpSkill(action);
      }
    } catch (err: any) {
      success = false;
      result = { ok: false, error: err?.message ?? String(err) };
      this.logger.error(
        `Pending action ${pendingActionId} (${action.toolName}) failed: ${err?.message ?? err}`,
      );
    }

    await this.prisma.aiPendingAction.update({
      where: { id: pendingActionId },
      data: {
        status: success ? 'EXECUTED' : 'APPROVED', // re-tentável se falhou
        executionResult: (result as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });

    this.logger.log({
      msg: 'pending_action_executed',
      pendingActionId,
      toolName: action.toolName,
      success,
    });

    return result;
  }

  /**
   * Cron-style cleanup: marca como EXPIRED qualquer PendingAction que
   * passou do `expiresAt` sem ser aprovado/rejeitado. Disparado por
   * repeatable job (a cada 5min) registrado em `confirmations.module`.
   */
  private async expireOverdueActions(): Promise<{ expired: number }> {
    const result = await this.prisma.aiPendingAction.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) {
      this.logger.log({
        msg: 'pending_actions_expired',
        count: result.count,
      });
    }
    return { expired: result.count };
  }

  private async executeTransferToHuman(action: {
    conversationId: string;
    args: Record<string, unknown>;
    approvedBy?: string;
  }): Promise<unknown> {
    // Efetiva a transferência: pausa a IA, joga a conversa na FILA (PENDING,
    // sem agente ativo) E ATRIBUI a quem aprovou — quem aprova o handoff
    // assume a conversa (sai de "Sem dono" e vai pra "Minhas"). Sem isso a
    // conversa ficava em limbo, muda e sem dono, e ninguém a assumia.
    const conv = await this.prisma.conversation.update({
      where: { id: action.conversationId },
      data: {
        aiEnabled: false,
        status: ConversationStatus.PENDING,
        activeAgentId: null,
        ...(action.approvedBy ? { assignedToId: action.approvedBy } : {}),
      },
      select: { id: true, channelId: true, assignedToId: true },
    });

    // Atualiza o inbox ao vivo pra a conversa aparecer na fila / em "Minhas"
    // na hora, já com o novo dono.
    this.realtime.emitToChannel(conv.channelId, 'conversation:updated', {
      conversationId: conv.id,
      status: ConversationStatus.PENDING,
      aiEnabled: false,
      assignedToId: conv.assignedToId,
    });

    return {
      ok: true,
      transferredAt: new Date().toISOString(),
      reason: action.args?.reason ?? null,
    };
  }

  private async executeHttpSkill(action: {
    agentRunId: string;
    conversationId: string;
    agentId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<unknown> {
    const skill = await this.prisma.aiSkill.findFirst({
      where: { name: action.toolName, isActive: true, deletedAt: null },
    });
    if (!skill) {
      throw new Error(`Skill ${action.toolName} not found or inactive`);
    }
    if (!skill.toolId) {
      throw new Error(`Skill ${action.toolName} has no bound tool`);
    }
    const tool = await this.prisma.aiTool.findUnique({
      where: { id: skill.toolId },
    });
    if (!tool) {
      throw new Error(`Tool ${skill.toolId} not found for skill ${skill.name}`);
    }

    const run = await this.prisma.aiAgentRun.findUnique({
      where: { id: action.agentRunId },
      select: { organizationId: true, triggerMessageId: true },
    });
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: action.conversationId },
      select: { contactId: true, channelId: true },
    });
    if (!run || !conversation) {
      throw new Error('Run or conversation no longer exists');
    }

    const ctx: ToolContext = {
      organizationId: run.organizationId,
      conversationId: action.conversationId,
      contactId: conversation.contactId,
      channelId: conversation.channelId,
      agentId: action.agentId,
      runId: action.agentRunId,
      triggerMessageId: run.triggerMessageId ?? '',
    };

    const result = await this.httpExecutor.execute(
      skill,
      tool,
      action.args,
      ctx,
      { bypassPendingGate: true },
    );
    return result.output;
  }
}
