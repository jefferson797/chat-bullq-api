import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RatingsController } from './ratings.controller';
import { RatingsService } from './ratings.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'outbound-messages' })],
  controllers: [RatingsController],
  providers: [RatingsService],
  exports: [RatingsService],
})
export class RatingsModule {}
