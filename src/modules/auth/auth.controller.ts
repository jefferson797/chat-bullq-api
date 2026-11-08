import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { SsoTunerIdDto } from './dto/sso-tunerid.dto';
import { TuneridService } from '../tunerid/tunerid.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tunerid: TuneridService,
  ) {}

  /**
   * Como se entra aqui — a tela de login se monta com isto. Público de
   * propósito: diz só se a senha local está aberta a todos (transição) ou só à
   * emergência, e se o login único está configurado. Nenhum nome de conta.
   */
  @Get('modo')
  @ApiOperation({ summary: 'Como se entra neste sistema (TunerID e/ou senha)' })
  modo() {
    return {
      tunerid: this.tunerid.configurado(),
      senha: this.tunerid.gestaoLocalLiberada() ? 'todos' : 'emergencia',
    };
  }

  @Post('register')
  @ApiOperation({ summary: 'Register new user + organization' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with email/password' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('sso/tunerid')
  @ApiOperation({ summary: 'Entra com o login único do grupo (bilhete do TunerID)' })
  ssoTunerId(@Body() dto: SsoTunerIdDto) {
    return this.authService.loginPorTunerId(dto.codigo);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile + organizations' })
  getMe(@CurrentUser('id') userId: string) {
    return this.authService.getMe(userId);
  }
}
