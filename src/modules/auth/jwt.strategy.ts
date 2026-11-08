import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { TuneridService, type Via } from '../tunerid/tunerid.service';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tunerid: TuneridService,
    private readonly auth: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET')!,
    });
  }

  async validate(payload: { sub: string; email: string; via?: Via }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }

    // O TunerID ainda deixa esta pessoa entrar? É o que faz cortar lá derrubar
    // quem já estava dentro. Resposta fresca é a hora de ajustar empresas e
    // papéis (o guard de empresa lê do banco a cada requisição).
    if (this.tunerid.exigeTunerId(user.email, payload.via)) {
      const { identidade, fresca } = await this.tunerid.verificar(user.email);
      if (!identidade) throw new UnauthorizedException('Seu acesso ao Conversas foi encerrado no TunerID.');
      if (fresca) await this.auth.sincronizar(identidade);
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    };
  }
}
