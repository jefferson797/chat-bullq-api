import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { SignOptions } from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { OrgRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { TuneridService, type IdentidadeTunerId, type Via } from '../tunerid/tunerid.service';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tunerid: TuneridService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // Cadastro aberto (criar workspace novo sem convite) é DESABILITADO por
    // padrão — só quem tem convite válido entra. Para reabrir (ex: bootstrap
    // do primeiro usuário), setar ALLOW_OPEN_SIGNUP=true. Bloqueia inclusive
    // chamadas diretas à API, não só a UI.
    if (!dto.inviteToken && process.env.ALLOW_OPEN_SIGNUP !== 'true') {
      throw new ForbiddenException(
        'Cadastro aberto está desabilitado. Solicite um convite ao administrador.',
      );
    }

    // Fora da transição, contas nascem pelo TunerID. Convite aceito aqui
    // criaria uma conta com senha local — uma porta lateral ao centro de acesso.
    if (!this.tunerid.senhaLiberadaPara(dto.email)) {
      throw new ForbiddenException(
        'Contas do Conversas nascem pelo TunerID: peça para liberarem o Conversas na sua ficha. ' +
          'A conta é criada sozinha no primeiro acesso.',
      );
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Check if registering via invitation
    if (dto.inviteToken) {
      return this.registerWithInvite(dto, hashedPassword);
    }

    return this.registerNewWorkspace(dto, hashedPassword);
  }

  private async registerNewWorkspace(dto: RegisterDto, hashedPassword: string) {
    const slug = this.generateSlug(dto.name);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          password: hashedPassword,
        },
      });

      const organization = await tx.organization.create({
        data: {
          name: `${dto.name}'s Workspace`,
          slug,
        },
      });

      await tx.userOrganization.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          role: 'OWNER',
        },
      });

      const defaultDepartment = await tx.department.create({
        data: {
          organizationId: organization.id,
          name: 'Geral',
          description: 'Departamento padrão',
          isDefault: true,
        },
      });

      const userOrg = await tx.userOrganization.findUnique({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: organization.id,
          },
        },
      });

      if (userOrg) {
        await tx.departmentAgent.create({
          data: {
            departmentId: defaultDepartment.id,
            userOrganizationId: userOrg.id,
          },
        });
      }

      return { user, organization };
    });

    const tokens = await this.generateTokens(result.user.id, result.user.email, 'senha');
    this.logger.log(`User registered (new workspace): ${result.user.email}`);

    return {
      user: this.sanitizeUser(result.user),
      organizations: [{
        id: result.organization.id,
        name: result.organization.name,
        slug: result.organization.slug,
        role: 'OWNER',
        accessibleChannelIds: 'ALL' as const,
      }],
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  private async registerWithInvite(dto: RegisterDto, hashedPassword: string) {
    // Validate the invitation
    const invitation = await this.prisma.invitation.findUnique({
      where: { token: dto.inviteToken },
      include: { organization: true },
    });

    if (!invitation) {
      throw new BadRequestException('Invalid invitation token');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`Invitation has already been ${invitation.status.toLowerCase()}`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }
    if (invitation.email !== dto.email) {
      throw new BadRequestException('Email does not match the invitation');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          password: hashedPassword,
        },
      });

      // Add user to the invited organization
      const membership = await tx.userOrganization.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          role: invitation.role,
        },
      });

      // Add to default department
      const defaultDept = await tx.department.findFirst({
        where: { organizationId: invitation.organizationId, isDefault: true },
      });

      if (defaultDept) {
        await tx.departmentAgent.create({
          data: {
            departmentId: defaultDept.id,
            userOrganizationId: membership.id,
          },
        });
      }

      // Mark invitation as accepted
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

      // Also accept any other pending invitations for this email
      await tx.invitation.updateMany({
        where: {
          email: dto.email,
          status: 'PENDING',
          id: { not: invitation.id },
        },
        data: { status: 'EXPIRED' },
      });

      return { user, organization: invitation.organization };
    });

    const tokens = await this.generateTokens(result.user.id, result.user.email, 'senha');
    this.logger.log(`User registered via invitation: ${result.user.email} -> org ${result.organization.name}`);

    return {
      user: this.sanitizeUser(result.user),
      organizations: [{
        id: result.organization.id,
        name: result.organization.name,
        slug: result.organization.slug,
        role: invitation.role,
        // New invited members start with no channel grants (deny-by-default).
        // OWNER/ADMIN bypass; AGENT must be explicitly granted by an admin.
        accessibleChannelIds:
          invitation.role === 'OWNER' || invitation.role === 'ADMIN'
            ? ('ALL' as const)
            : ([] as string[]),
      }],
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async login(dto: LoginDto) {
    // A entrada normal é pelo TunerID. A senha daqui é da conta de emergência
    // (e de todo mundo só durante a transição). Recusar ANTES de conferir a
    // senha: quem não pode entrar por aqui não ganha um lugar para testar senha.
    if (!this.tunerid.senhaLiberadaPara(dto.email)) {
      throw new ForbiddenException('Neste sistema a entrada é pelo TunerID. Use o botão "Entrar com TunerID".');
    }
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    this.logger.log(`User logged in: ${user.email}`);
    return this.montarSessao(user, 'senha');
  }

  /**
   * A sessão que o front recebe. Vale para QUALQUER porta de entrada: senha
   * daqui ou login único do TunerID. Está num método só de propósito — duas
   * cópias disto é garantir que um dia elas divergem, e aí uma das portas
   * passa a devolver permissão diferente da outra.
   */
  private async montarSessao(user: { id: string; email: string } & Record<string, any>, via: Via) {
    const memberships = await this.prisma.userOrganization.findMany({
      where: { userId: user.id },
      include: {
        organization: true,
        channelAgents: { select: { channelId: true } },
      },
    });

    const tokens = await this.generateTokens(user.id, user.email, via);

    return {
      user: this.sanitizeUser(user as never),
      organizations: memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
        accessibleChannelIds:
          m.role === 'OWNER' || m.role === 'ADMIN'
            ? ('ALL' as const)
            : m.channelAgents.map((c) => c.channelId),
      })),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  /**
   * Renova a sessão. É a porta que mais importa no Conversas: o token dura 15
   * minutos e o de renovação, 7 dias — sem perguntar ao TunerID AQUI, quem foi
   * cortado continuaria renovando a sessão por uma semana.
   */
  async refresh(refreshToken: string) {
    let payload: { sub: string; via?: Via };
    try {
      payload = this.jwt.verify<{ sub: string; via?: Via }>(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (this.tunerid.exigeTunerId(user.email, payload.via)) {
      // 503 do TunerID fora do ar sobe como está: não é "token inválido", e o
      // front não deve deslogar a pessoa por causa disso.
      const { identidade, fresca } = await this.tunerid.verificar(user.email);
      if (!identidade) throw new UnauthorizedException('Seu acesso ao Conversas foi encerrado no TunerID.');
      if (fresca) await this.sincronizar(identidade);
    }

    return this.generateTokens(user.id, user.email, payload.via ?? 'senha');
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) throw new UnauthorizedException();

    const memberships = await this.prisma.userOrganization.findMany({
      where: { userId },
      include: {
        organization: true,
        channelAgents: { select: { channelId: true } },
      },
    });

    return {
      user: this.sanitizeUser(user),
      organizations: memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
        // 'ALL' for OWNER/ADMIN — they bypass the per-channel allowlist.
        accessibleChannelIds:
          m.role === 'OWNER' || m.role === 'ADMIN'
            ? ('ALL' as const)
            : m.channelAgents.map((c) => c.channelId),
      })),
    };
  }

  /** `via` vai nos dois tokens: é como a revalidação sabe, na transição, se a sessão precisa do TunerID. */
  private async generateTokens(userId: string, email: string, via: Via) {
    const payload = { sub: userId, email, via };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('JWT_SECRET'),
        expiresIn: this.config.get<string>('JWT_EXPIRATION', '15m') as SignOptions['expiresIn'],
      }),
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRATION', '7d') as SignOptions['expiresIn'],
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private sanitizeUser(user: { password: string; [key: string]: unknown }) {
    const { password: _, ...rest } = user;
    return rest;
  }

  private generateSlug(name: string): string {
    const base = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    return `${base}-${Date.now().toString(36)}`;
  }

  /**
   * Entrada pelo login único do grupo (TunerID).
   *
   * O TunerID é quem decide: só emite o bilhete para quem tem o Conversas
   * liberado e diz em quais empresas, com qual papel. A conta daqui NASCE neste
   * momento se ainda não existir, e se já existir é ajustada ao que o TunerID
   * mandou. Os CANAIS que cada atendente enxerga continuam sendo decididos aqui.
   */
  async loginPorTunerId(codigo: string) {
    const identidade = await this.tunerid.trocar(codigo);
    const user = await this.sincronizar(identidade);
    if (!user.isActive) throw new UnauthorizedException('Account is deactivated');
    this.logger.log(`User logged in via TunerID: ${user.email}`);
    return this.montarSessao(user, 'tunerid');
  }

  /**
   * Põe a conta daqui de acordo com o TunerID: cria, reativa, ajusta nome,
   * empresas e papéis. Empresa que o TunerID não liberou SAI (e com ela os
   * canais e departamentos do atendente naquela empresa — cascata do banco).
   * Empresa que continua com o mesmo papel fica intocada: os canais liberados
   * aqui para o atendente são preservados.
   */
  async sincronizar(identidade: IdentidadeTunerId) {
    const empresas = await this.prisma.organization.findMany({
      where: { deletedAt: null },
      select: { id: true, slug: true },
    });
    const desejado = new Map<string, OrgRole>();
    for (const e of identidade.acesso.empresas) {
      const daqui = this.tunerid.empresaDaqui(e.slug, empresas);
      if (!daqui || !(Object.values(OrgRole) as string[]).includes(e.perfil)) {
        this.logger.warn(
          `TunerID liberou ${identidade.email} em "${e.slug}" como ${e.perfil}, ` +
            (daqui ? 'mas esse papel não existe aqui.' : 'mas essa empresa não existe aqui (confira TUNERID_EMPRESAS).'),
        );
        continue;
      }
      desejado.set(daqui.id, e.perfil as OrgRole);
    }
    if (desejado.size === 0) {
      throw new ForbiddenException('O TunerID liberou o Conversas, mas para uma empresa que ele não conhece.');
    }

    const email = identidade.email.toLowerCase().trim();
    // E-mail aqui pode ter sido gravado com maiúscula: procura sem ligar para isso,
    // senão a conta antiga da pessoa ficaria órfã e nasceria uma segunda.
    const existente = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      include: { organizations: true },
    });

    const igual =
      existente &&
      existente.isActive &&
      !existente.deletedAt &&
      existente.name === identidade.name &&
      existente.organizations.length === desejado.size &&
      existente.organizations.every((m) => desejado.get(m.organizationId) === m.role);

    if (!igual) {
      await this.prisma.$transaction(async (tx) => {
        const user = existente
          ? await tx.user.update({
              where: { id: existente.id },
              data: { name: identidade.name, isActive: true, deletedAt: null },
            })
          : await tx.user.create({
              data: {
                name: identidade.name,
                email,
                // Senha impossível: ninguém sabe, ninguém usa. A entrada é pelo TunerID.
                password: await bcrypt.hash(randomBytes(32).toString('base64url'), BCRYPT_ROUNDS),
              },
            });
        await tx.userOrganization.deleteMany({
          where: { userId: user.id, organizationId: { notIn: [...desejado.keys()] } },
        });
        for (const [organizationId, role] of desejado) {
          await tx.userOrganization.upsert({
            where: { userId_organizationId: { userId: user.id, organizationId } },
            create: { userId: user.id, organizationId, role },
            update: { role },
          });
        }
      });
      this.logger.log(
        `${existente ? 'Conta ajustada' : 'Conta criada'} pelo TunerID: ${email} → ` +
          [...desejado].map(([o, r]) => `${o}:${r}`).join(', '),
      );
    }

    return this.prisma.user.findFirstOrThrow({ where: { email: { equals: email, mode: 'insensitive' } } });
  }
}
