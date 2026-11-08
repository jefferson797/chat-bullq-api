import {
  ForbiddenException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Quem é a pessoa e o que ela pode NESTE sistema, segundo o TunerID. */
export interface IdentidadeTunerId {
  id: string;
  name: string;
  email: string;
  acesso: {
    app: string;
    /** Empresas liberadas, pelo identificador do TunerID ("editacast"), com o papel. */
    empresas: { slug: string; nome: string; perfil: string }[];
  };
}

/** Por onde a sessão entrou. Vai dentro do token. */
export type Via = 'tunerid' | 'senha';

/**
 * A única porta deste sistema para o TunerID.
 *
 * O TunerID é o centro de controle de acesso do grupo: é lá que se decide quem
 * entra aqui, com qual papel, e é lá que se corta. Este serviço faz duas
 * perguntas a ele:
 *
 *   - `trocar`: na entrada, o bilhete de 60 segundos vira a identidade;
 *   - `verificar`: a cada requisição, "essa pessoa ainda pode entrar?".
 *
 * A segunda é guardada por `TUNERID_VALIDADE_SEGUNDOS` (60): é o tempo máximo
 * que alguém cortado no TunerID ainda fica aqui dentro. Se o TunerID estiver
 * fora do ar, quem já estava trabalhando segue por até 15 minutos — reiniciar
 * o TunerID não pode derrubar o trabalho de ninguém. Passou disso, 503: deixar
 * entrar sem saber quem é não é opção.
 *
 * A senha própria deste sistema só vale para as contas de EMERGÊNCIA
 * (`CONTAS_EMERGENCIA`), que existem para o dia em que o TunerID cair.
 * `LOGIN_SENHA=todos` é o modo de transição: enquanto as pessoas daqui ainda
 * não têm login no TunerID, a senha local continua valendo para todo mundo.
 */
@Injectable()
export class TuneridService {
  private readonly logger = new Logger('TunerID');
  private readonly guardado = new Map<string, { valor: IdentidadeTunerId | null; em: number }>();
  private readonly validadeMs: number;
  private readonly toleranciaMs = 15 * 60_000;
  readonly app = 'conversas';

  constructor(private readonly config: ConfigService) {
    this.validadeMs = Math.max(1, Number(config.get('TUNERID_VALIDADE_SEGUNDOS', 60))) * 1000;
  }

  private get base() {
    return (this.config.get<string>('TUNERID_API_URL') ?? '').replace(/\/$/, '');
  }

  private get segredo() {
    return this.config.get<string>('SSO_CONVERSAS_SECRET') ?? '';
  }

  configurado() {
    return !!this.base && this.segredo.length >= 32;
  }

  private chamar(caminho: string, corpo: unknown) {
    return fetch(`${this.base}${caminho}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sso-app': this.app, 'x-sso-secret': this.segredo },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(5000),
    });
  }

  /** O bilhete de uso único vira a identidade. Só o servidor fala com o TunerID. */
  async trocar(codigo: string): Promise<IdentidadeTunerId> {
    if (!this.configurado()) throw new ForbiddenException('Login único não está configurado neste ambiente');
    let r: Response;
    try {
      r = await this.chamar('/sso/trocar', { codigo });
    } catch (e) {
      this.logger.warn(`TunerID não respondeu na troca: ${(e as Error).message}`);
      throw new ForbiddenException('Não consegui confirmar o seu login com o TunerID. Tente de novo.');
    }
    if (r.status === 401 || r.status === 400) {
      throw new UnauthorizedException('Código de entrada inválido ou vencido. Tente entrar de novo.');
    }
    if (r.status === 403) {
      // O TunerID diz POR QUE recusou ("não tem acesso liberado", "login
      // desativado"). Repassar é o que deixa a pessoa saber o que pedir.
      const corpo = (await r.json().catch(() => null)) as { message?: string } | null;
      throw new ForbiddenException(corpo?.message ?? 'O TunerID não liberou a sua entrada neste sistema.');
    }
    if (!r.ok) throw new ForbiddenException('Não consegui confirmar o seu login com o TunerID. Tente de novo.');

    const identidade = (await r.json()) as IdentidadeTunerId;
    this.guardado.set(identidade.email.toLowerCase(), { valor: identidade, em: Date.now() });
    return identidade;
  }

  /**
   * "Essa pessoa ainda pode entrar aqui?" `identidade: null` = não pode mais:
   * a sessão dela deve cair. `fresca` = acabou de vir do TunerID (é a hora de
   * ajustar papel e nome, e não a cada requisição).
   */
  async verificar(email: string): Promise<{ identidade: IdentidadeTunerId | null; fresca: boolean }> {
    const chave = email.toLowerCase().trim();
    const agora = Date.now();
    const g = this.guardado.get(chave);
    if (g && agora - g.em < this.validadeMs) return { identidade: g.valor, fresca: false };

    try {
      if (!this.configurado()) throw new Error('TUNERID_API_URL/SSO_CONVERSAS_SECRET ausentes');
      const r = await this.chamar('/sso/verificar', { email: chave });
      if (r.status === 404) {
        this.guardado.set(chave, { valor: null, em: agora });
        return { identidade: null, fresca: true };
      }
      if (!r.ok) throw new Error(`status ${r.status}`);
      const identidade = (await r.json()) as IdentidadeTunerId;
      this.guardado.set(chave, { valor: identidade, em: agora });
      return { identidade, fresca: true };
    } catch (e) {
      // TunerID fora: quem estava dentro segue por um tempo. Quem estava
      // CORTADO continua cortado — a tolerância nunca reabre porta.
      if (g?.valor && agora - g.em < this.toleranciaMs) return { identidade: g.valor, fresca: false };
      this.logger.warn(`TunerID não respondeu: ${(e as Error).message}`);
      throw new ServiceUnavailableException('O login do grupo (TunerID) está fora do ar. Tente de novo em instantes.');
    }
  }

  /** Esquece o que estava guardado (logo depois de o próprio sistema mudar algo). */
  esquecer(email: string) {
    this.guardado.delete(email.toLowerCase().trim());
  }

  contaDeEmergencia(email: string) {
    const lista = (this.config.get<string>('CONTAS_EMERGENCIA') ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    return lista.includes(email.toLowerCase().trim());
  }

  /** `todos` só na transição; o padrão é só a emergência entrar por senha. */
  private get modoSenha(): 'todos' | 'emergencia' {
    return this.config.get<string>('LOGIN_SENHA') === 'todos' ? 'todos' : 'emergencia';
  }

  /** Pode entrar com a senha DAQUI? */
  senhaLiberadaPara(email: string) {
    return this.modoSenha === 'todos' || this.contaDeEmergencia(email);
  }

  /** Esta sessão precisa da bênção do TunerID a cada minuto? */
  exigeTunerId(email: string, via?: Via) {
    if (this.contaDeEmergencia(email)) return false;
    return this.modoSenha === 'emergencia' || via === 'tunerid';
  }

  /** Contas são do TunerID: criar ou mudar papel/estado aqui só na transição. */
  gestaoLocalLiberada() {
    return this.modoSenha === 'todos';
  }

  /**
   * Que empresa DAQUI corresponde a cada empresa do TunerID.
   *
   * Padrão: o mesmo identificador ("editacast" lá = "editacast" aqui). Quando
   * não bate, `TUNERID_EMPRESAS="editacast=<slug ou id daqui>,pro-eventos=…"`
   * diz explicitamente. Empresa do TunerID sem par aqui é ignorada — o sistema
   * não inventa empresa.
   */
  empresaDaqui(slugTunerId: string, empresas: { id: string; slug: string }[]) {
    const mapa = new Map(
      (this.config.get<string>('TUNERID_EMPRESAS') ?? '')
        .split(',')
        .map((par) => par.split('=').map((x) => x.trim()))
        .filter((par) => par.length === 2 && par[0] && par[1]) as [string, string][],
    );
    const alvo = mapa.get(slugTunerId) ?? slugTunerId;
    return empresas.find((e) => e.id === alvo || e.slug === alvo);
  }
}
