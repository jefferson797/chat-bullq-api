import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsModule } from '../../notifications/notifications.module';
import { SlaService } from './sla.service';
import { SlaTimerProcessor } from './sla-timer.processor';

/**
 * SLA module — timers de primeira resposta e resolução por setor.
 *
 * Espelha o padrão do WatchdogModule: exporta `SlaService` pra que o
 * Messaging arme os timers (`scheduleFirstResponseTimer` /
 * `scheduleResolutionTimer`) nas mensagens INBOUND e cancele
 * (`cancelFirstResponseTimer` quando o vendedor responde, `cancelTimers`
 * quando a conversa é encerrada). O `SlaTimerProcessor` roda em background
 * e notifica no estouro.
 *
 * Módulo próprio pra evitar dependência circular: RoutingModule importa
 * MessagingModule, logo o Messaging NÃO pode importar RoutingModule — mas
 * pode importar este SlaModule isolado (que só depende de Notifications).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: 'sla-timers' }),
    NotificationsModule,
  ],
  providers: [SlaService, SlaTimerProcessor],
  exports: [SlaService, BullModule],
})
export class SlaModule {}
