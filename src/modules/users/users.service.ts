import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { TuneridService } from '../tunerid/tunerid.service';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tunerid: TuneridService,
  ) {}

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (dto.name !== undefined) {
      const atual = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
      // O nome é o da ficha no TunerID: mudar aqui seria desfeito na próxima
      // consulta. A foto continua sendo daqui.
      if (atual && atual.name !== dto.name && !this.tunerid.senhaLiberadaPara(atual.email)) {
        throw new ForbiddenException('Seu nome vem do TunerID. Para corrigir, peça na sua ficha de lá.');
      }
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
    });

    const { password: _, ...sanitized } = user;
    return sanitized;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }
    if (!this.tunerid.senhaLiberadaPara(user.email)) {
      throw new ForbiddenException('Você entra pelo TunerID: a senha que vale é a de lá. Troque por lá.');
    }

    const isValid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    this.logger.log(`Password changed for user ${userId}`);
  }

  async getPreferences(userId: string, organizationId: string) {
    const membership = await this.prisma.userOrganization.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { preferences: true },
    });

    if (!membership) {
      throw new NotFoundException('Membership not found');
    }

    return (membership.preferences ?? {}) as Record<string, unknown>;
  }

  async updatePreferences(
    userId: string,
    organizationId: string,
    patch: Record<string, unknown>,
  ) {
    const current = await this.getPreferences(userId, organizationId);
    const merged = { ...current, ...patch };

    await this.prisma.userOrganization.update({
      where: { userId_organizationId: { userId, organizationId } },
      data: { preferences: merged as Prisma.InputJsonValue },
    });

    return merged;
  }
}
