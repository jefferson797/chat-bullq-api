import { Module } from '@nestjs/common';
import { DailyReminderService } from './daily-reminder.service';

@Module({
  providers: [DailyReminderService],
})
export class DailyReminderModule {}
