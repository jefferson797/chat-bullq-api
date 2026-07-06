import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import { RatingsService } from './ratings.service';
import { SubmitRatingDto } from './dto/submit-rating.dto';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import { CurrentOrg, Public } from '../../common/decorators';

@ApiTags('Ratings')
@Controller('ratings')
export class RatingsController {
  constructor(private readonly service: RatingsService) {}

  @Public()
  @Get('public/:token/branding')
  @ApiOperation({ summary: 'Get org branding (name + logo) for the public rating page' })
  getBranding(@Param('token') token: string) {
    return this.service.getBranding(token);
  }

  @Public()
  @Post('public/:token')
  @ApiOperation({ summary: 'Submit CSAT rating using a public token (no auth)' })
  submit(@Param('token') token: string, @Body() dto: SubmitRatingDto) {
    return this.service.submitByToken(token, dto.score, dto.comment);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, OrgGuard)
  @ApiOperation({ summary: 'List recent answered ratings for the current org' })
  @ApiQuery({ name: 'limit', required: false })
  list(@CurrentOrg('id') orgId: string, @Query('limit') limit?: string) {
    return this.service.listForOrg(orgId, limit ? parseInt(limit, 10) : 50);
  }
}
