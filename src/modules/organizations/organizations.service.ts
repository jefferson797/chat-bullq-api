import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { OrgRole, Prisma } from '@prisma/client';
import { OrganizationsRepository } from './organizations.repository';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { TuneridService } from '../tunerid/tunerid.service';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly repository: OrganizationsRepository,
    private readonly tunerid: TuneridService,
  ) {}

  /**
   * Conta que o TunerID governa: quem entra, em quais empresas, com qual papel,
   * ativa ou não. Fora da transição, só a conta de emergência é gerida aqui.
   * Os CANAIS de cada atendente continuam sendo daqui.
   */
  private geridaPeloTunerId(email: string) {
    return !this.tunerid.gestaoLocalLiberada() && !this.tunerid.contaDeEmergencia(email);
  }

  /**
   * Recebe SEMPRE o userId da participação já encontrada — nunca o id que veio
   * da tela. A tela manda o id da participação, o repositório aceita os dois, e
   * procurar usuário com id de participação não acha ninguém: a trava passaria
   * em branco.
   */
  private async exigirGestaoLocal(userId: string, oQue: string) {
    const user = await this.repository.findUserById(userId);
    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (user && this.geridaPeloTunerId(user.email)) {
      throw new ForbiddenException(`${oQue} de ${user.name} é decidido no TunerID, na ficha da pessoa. Aqui ficam os canais.`);
    }
  }

  async getOrganization(orgId: string) {
    const org = await this.repository.findById(orgId);
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async updateOrganization(orgId: string, dto: UpdateOrganizationDto) {
    await this.getOrganization(orgId);
    const {
      aiBusinessHours,
      watchdogBusinessHours,
      watchdogConfig,
      allowedUrlDomains,
      ...rest
    } = dto;
    return this.repository.update(orgId, {
      ...rest,
      ...(aiBusinessHours !== undefined
        ? { aiBusinessHours: aiBusinessHours as object }
        : {}),
      ...(watchdogBusinessHours !== undefined
        ? { watchdogBusinessHours: watchdogBusinessHours as object }
        : {}),
      ...(watchdogConfig !== undefined
        ? { watchdogConfig: watchdogConfig as object }
        : {}),
      ...(allowedUrlDomains !== undefined
        ? {
            allowedUrlDomains:
              allowedUrlDomains === null
                ? Prisma.JsonNull
                : (allowedUrlDomains as Prisma.InputJsonValue),
          }
        : {}),
    });
  }

  async getMembers(orgId: string) {
    const membros = await this.repository.findMembers(orgId);
    // A tela usa isto para travar o que é decidido no TunerID.
    return membros.map((m) => ({ ...m, geridoPeloTunerId: this.geridaPeloTunerId(m.user.email) }));
  }

  async inviteMember(orgId: string, dto: InviteMemberDto, inviterId: string) {
    if (this.geridaPeloTunerId(dto.email)) {
      throw new ForbiddenException(
        'Contas do Conversas nascem pelo TunerID: libere o Conversas na ficha da pessoa, aba Acessos, ' +
          'escolhendo a empresa e o papel. A conta é criada sozinha no primeiro acesso.',
      );
    }
    // Check if user already exists and is already a member
    const existingUser = await this.repository.findUserByEmail(dto.email);
    if (existingUser) {
      const existingMembership = await this.repository.findMembership(existingUser.id, orgId);
      if (existingMembership) {
        throw new ConflictException('User is already a member of this organization');
      }
    }

    // Create invitation (works for both existing and non-existing users)
    const invitation = await this.repository.createInvitation(orgId, dto.email, dto.role, inviterId);
    this.logger.log(`Invitation sent to ${dto.email} for org ${orgId} by ${inviterId}`);

    // If user already exists, auto-accept: add them to org immediately
    if (existingUser) {
      await this.repository.addMember(orgId, existingUser.id, dto.role);
      await this.repository.acceptInvitation(invitation.id);
      this.logger.log(`User ${dto.email} auto-added to org ${orgId} (already registered)`);
      return { ...invitation, status: 'ACCEPTED' as const, autoAccepted: true };
    }

    return { ...invitation, autoAccepted: false };
  }

  async validateInvitation(token: string) {
    const invitation = await this.repository.findInvitationByToken(token);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`Invitation has already been ${invitation.status.toLowerCase()}`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }
    return {
      email: invitation.email,
      role: invitation.role,
      organization: invitation.organization,
    };
  }

  async getInvitations(orgId: string) {
    return this.repository.findInvitationsByOrg(orgId);
  }

  async revokeInvitation(orgId: string, invitationId: string) {
    const invitations = await this.repository.findInvitationsByOrg(orgId);
    const invitation = invitations.find((i) => i.id === invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found in this organization');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('Only pending invitations can be revoked');
    }
    return this.repository.revokeInvitation(invitationId);
  }

  async updateMemberRole(orgId: string, memberId: string, dto: UpdateMemberRoleDto, actorRole: OrgRole) {
    const membership = await this.repository.findMembership(memberId, orgId);
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (membership.role === 'OWNER' && dto.role !== 'OWNER') {
      throw new ForbiddenException('Cannot change the role of the organization owner');
    }
    await this.exigirGestaoLocal(membership.userId, 'O papel');

    if (actorRole === 'ADMIN' && dto.role === 'OWNER') {
      throw new ForbiddenException('Only owners can assign the owner role');
    }

    return this.repository.updateMemberRole(membership.id, dto.role);
  }

  async removeMember(orgId: string, memberId: string, actorId: string) {
    const membership = await this.repository.findMembership(memberId, orgId);
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (membership.role === 'OWNER') {
      throw new ForbiddenException('Cannot remove the organization owner');
    }
    await this.exigirGestaoLocal(membership.userId, 'Tirar o acesso');

    if (memberId === actorId) {
      throw new BadRequestException('Cannot remove yourself. Transfer ownership first.');
    }

    await this.repository.removeMember(membership.id);
    this.logger.log(`Member ${memberId} removed from org ${orgId} by ${actorId}`);
  }

  /** Edita o membro (nome / ativo). ADMIN não mexe no OWNER. */
  async updateMember(
    orgId: string,
    memberId: string,
    dto: UpdateMemberDto,
    actorRole: OrgRole,
  ) {
    const membership = await this.repository.findMembership(memberId, orgId);
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }
    if (membership.role === 'OWNER' && actorRole === 'ADMIN') {
      throw new ForbiddenException('Only the owner can edit the owner');
    }
    if (dto.name !== undefined || dto.isActive !== undefined) {
      await this.exigirGestaoLocal(membership.userId, 'Nome e ativo/inativo');
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nothing to update');
    }

    const user = await this.repository.updateUser(membership.userId, data);
    this.logger.log(`Member ${memberId} (user ${membership.userId}) updated in org ${orgId}`);
    const { password: _pw, ...sanitized } = user;
    return sanitized;
  }

  /**
   * Redefine a senha de um membro (admin não sabe a senha antiga — por isso
   * NÃO exige a atual, diferente do change-password do próprio usuário).
   * ADMIN não pode redefinir a senha do OWNER.
   */
  async resetMemberPassword(
    orgId: string,
    memberId: string,
    newPassword: string,
    actorRole: OrgRole,
  ) {
    const membership = await this.repository.findMembership(memberId, orgId);
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }
    if (membership.role === 'OWNER' && actorRole === 'ADMIN') {
      throw new ForbiddenException('Only the owner can reset the owner password');
    }
    await this.exigirGestaoLocal(membership.userId, 'A senha');

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.repository.updateUser(membership.userId, { password: hashedPassword });
    this.logger.log(`Password reset for member ${memberId} (user ${membership.userId}) in org ${orgId}`);
    return { ok: true };
  }
}
