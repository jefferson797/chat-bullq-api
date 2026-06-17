import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AutoRepliesController } from './auto-replies.controller';
import { AutoRepliesService } from './auto-replies.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'outbound-messages' })],
  controllers: [AutoRepliesController],
  providers: [AutoRepliesService],
  exports: [AutoRepliesService],
})
export class AutoRepliesModule {}
