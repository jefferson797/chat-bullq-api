import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './database/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ChannelHubModule } from './modules/channel-hub/channel-hub.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RoutingModule } from './modules/routing/routing.module';
import { QuickRepliesModule } from './modules/quick-replies/quick-replies.module';
import { TagsModule } from './modules/tags/tags.module';
import { ChatbotModule } from './modules/chatbot/chatbot.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { AutoRepliesModule } from './modules/auto-replies/auto-replies.module';
import { DiskMonitorModule } from './modules/disk-monitor/disk-monitor.module';
import { DailyReminderModule } from './modules/daily-reminder/daily-reminder.module';
import { PublicApiModule } from './modules/public-api/public-api.module';
import { ChannelAccessModule } from './modules/iam/channel-access/channel-access.module';
import { AiAgentsModule } from './modules/ai-agents/ai-agents.module';
import { InboxViewsModule } from './modules/inbox-views/inbox-views.module';
import { PipelinesModule } from './modules/pipelines/pipelines.module';
import { AutomationsModule } from './modules/automations/automations.module';
// ProductsModule religado (2026-07-05) — catálogo LOCAL por org (CRUD +
// tela de cadastro). A IA ainda consome o catálogo externo legado via skill
// getProductPitch (remoção planejada — docs/PLANO-LIMPEZA-DNA.md, Onda 2);
// reapontá-la pro catálogo local é um passo separado (integração viva).
import { ProductsModule } from './modules/products/products.module';
import redisConfig from './config/redis.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host', 'localhost'),
          port: config.get<number>('redis.port', 6379),
          password: config.get<string>('redis.password') || undefined,
        },
      }),
    }),
    PrismaModule,
    // AutomationsModule is @Global — register early so every domain
    // module can inject OutboxService without explicit imports.
    AutomationsModule,
    ChannelAccessModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    RealtimeModule,
    ChannelHubModule,
    MessagingModule,
    NotificationsModule,
    RoutingModule,
    QuickRepliesModule,
    TagsModule,
    ChatbotModule,
    DashboardModule,
    RatingsModule,
    ApiKeysModule,
    AutoRepliesModule,
    DiskMonitorModule,
    DailyReminderModule,
    PublicApiModule,
    AiAgentsModule,
    InboxViewsModule,
    PipelinesModule,
    ProductsModule,
  ],
})
export class AppModule {}
