import { Module } from '@nestjs/common';
import { DiskMonitorService } from './disk-monitor.service';

@Module({
  providers: [DiskMonitorService],
})
export class DiskMonitorModule {}
