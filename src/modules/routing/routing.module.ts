import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DepartmentsController } from './departments/departments.controller';
import { DepartmentsService } from './departments/departments.service';
import { DepartmentsRepository } from './departments/departments.repository';
import { RouterService } from './router.service';
import { SlaModule } from './sla/sla.module';
import { WatchdogModule } from './watchdog/watchdog.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'conversation-router' }),
    MessagingModule,
    NotificationsModule,
    SlaModule,
    WatchdogModule,
  ],
  controllers: [DepartmentsController],
  providers: [DepartmentsRepository, DepartmentsService, RouterService],
  exports: [DepartmentsService, DepartmentsRepository, RouterService, SlaModule],
})
export class RoutingModule {}
