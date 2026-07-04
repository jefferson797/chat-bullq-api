import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PublicMeController } from './controllers/public-me.controller';
import { PublicDashboardController } from './controllers/public-dashboard.controller';
import { PublicContactsController } from './controllers/public-contacts.controller';
import { PublicMessagesController } from './controllers/public-messages.controller';
import { PublicMessagesService } from './services/public-messages.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    DashboardModule,
    BullModule.registerQueue({ name: 'outbound-messages' }),
  ],
  controllers: [
    PublicMeController,
    PublicDashboardController,
    PublicContactsController,
    PublicMessagesController,
  ],
  providers: [PublicMessagesService],
})
export class PublicApiModule {}
