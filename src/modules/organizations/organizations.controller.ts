import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { OrganizationsService } from './organizations.service';
import { UploadsService } from '../messaging/messages/uploads.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { ResetMemberPasswordDto } from './dto/reset-member-password.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, CurrentOrg, Roles, Public } from '../../common/decorators';

const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5MB

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly service: OrganizationsService,
    private readonly uploads: UploadsService,
  ) {}

  @Get('current')
  @ApiOperation({ summary: 'Get current organization details' })
  getCurrent(@CurrentOrg('id') orgId: string) {
    return this.service.getOrganization(orgId);
  }

  @Patch('current')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Update current organization' })
  update(@CurrentOrg('id') orgId: string, @Body() dto: UpdateOrganizationDto) {
    return this.service.updateOrganization(orgId, dto);
  }

  @Post('current/logo')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload organization logo (image)' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_LOGO_BYTES } }))
  async uploadLogo(
    @CurrentOrg('id') orgId: string,
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; originalname?: string } | undefined,
  ) {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Nenhum arquivo enviado');
    }
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Envie uma imagem (PNG, JPG, WEBP…)');
    }
    const { url } = await this.uploads.saveMedia({
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
    await this.service.updateOrganization(orgId, { logoUrl: url });
    return { logoUrl: url };
  }

  @Get('members')
  @ApiOperation({ summary: 'List members of current organization' })
  getMembers(@CurrentOrg('id') orgId: string) {
    return this.service.getMembers(orgId);
  }

  @Post('members/invite')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Invite a member to the organization' })
  invite(
    @CurrentOrg('id') orgId: string,
    @Body() dto: InviteMemberDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.inviteMember(orgId, dto, userId);
  }

  @Get('invitations')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'List invitations for current organization' })
  getInvitations(@CurrentOrg('id') orgId: string) {
    return this.service.getInvitations(orgId);
  }

  @Delete('invitations/:invitationId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  revokeInvitation(
    @CurrentOrg('id') orgId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.service.revokeInvitation(orgId, invitationId);
  }

  @Get('invitations/validate')
  @Public()
  @ApiOperation({ summary: 'Validate an invitation token (public)' })
  validateInvitation(@Query('token') token: string) {
    return this.service.validateInvitation(token);
  }

  @Patch('members/:memberId/role')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Change member role' })
  updateRole(
    @CurrentOrg('id') orgId: string,
    @CurrentOrg('userRole') actorRole: OrgRole,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.service.updateMemberRole(orgId, memberId, dto, actorRole);
  }

  @Patch('members/:memberId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Edit a member (name / active status)' })
  updateMember(
    @CurrentOrg('id') orgId: string,
    @CurrentOrg('userRole') actorRole: OrgRole,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.service.updateMember(orgId, memberId, dto, actorRole);
  }

  @Post('members/:memberId/reset-password')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Reset a member password (admin sets a new one)' })
  resetMemberPassword(
    @CurrentOrg('id') orgId: string,
    @CurrentOrg('userRole') actorRole: OrgRole,
    @Param('memberId') memberId: string,
    @Body() dto: ResetMemberPasswordDto,
  ) {
    return this.service.resetMemberPassword(orgId, memberId, dto.newPassword, actorRole);
  }

  @Delete('members/:memberId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Remove a member from the organization' })
  removeMember(
    @CurrentOrg('id') orgId: string,
    @Param('memberId') memberId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.service.removeMember(orgId, memberId, actorId);
  }
}
