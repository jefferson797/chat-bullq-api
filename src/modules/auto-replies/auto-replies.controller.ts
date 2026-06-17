import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { AutoRepliesService } from './auto-replies.service';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';

@ApiTags('Auto Replies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('auto-replies')
export class AutoRepliesController {
  constructor(private readonly service: AutoRepliesService) {}

  @Get()
  @ApiOperation({ summary: 'Get auto-reply config (greeting / lunch / off-hours)' })
  get(@CurrentOrg('id') organizationId: string) {
    return this.service.getConfig(organizationId);
  }

  @Put()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Update auto-reply config' })
  update(@CurrentOrg('id') organizationId: string, @Body() body: unknown) {
    return this.service.updateConfig(organizationId, body);
  }
}
