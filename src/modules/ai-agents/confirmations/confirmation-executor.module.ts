import { Module } from '@nestjs/common';

import { PrismaModule } from '../../../database/prisma.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ToolsModule } from '../tools/tools.module';
import { ConfirmationsModule } from './confirmations.module';
import { PendingActionExecutorProcessor } from './pending-action-executor.processor';
import { PendingActionCronService } from './pending-action-cron.service';

/**
 * Module separado pra quebrar ciclo de DI:
 *   ToolsModule → ConfirmationsModule (gating)
 *   ConfirmationExecutorModule → ToolsModule + ConfirmationsModule (executor)
 *
 * O processor + cron NÃO podem viver dentro do ConfirmationsModule porque
 * isso criaria ciclo (Tools → Confirmations → Tools). Mantendo aqui, Tools
 * importa Confirmations sem ciclo, e Executor importa ambos.
 *
 * AiAgentsModule importa este module — basta isso pro processor subir e
 * o cron registrar o repeatable job.
 */
@Module({
  imports: [PrismaModule, RealtimeModule, NotificationsModule, ToolsModule, ConfirmationsModule],
  providers: [PendingActionExecutorProcessor, PendingActionCronService],
})
export class ConfirmationExecutorModule {}
