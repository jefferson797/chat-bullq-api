/**
 * Ponta a ponta entre o TunerID (local) e o Conversas — sem precisar do Redis.
 *
 * O Conversas inteiro não sobe sem Redis (filas, sessão do chatbot, memória da
 * IA). Mas nada do que decide QUEM ENTRA depende dele: aqui sobem só os módulos
 * de verdade que fazem isso — banco, autenticação e o cliente do TunerID — e
 * eles conversam com o TunerID local de verdade, pelo intermediário da porta
 * 3499 (que o teste desliga para simular o TunerID caindo).
 *
 * Também roda a reconferência da conexão ao vivo (o gateway) com conexões de
 * mentira, porque é ela que derruba quem foi cortado e está com a aba aberta.
 *
 *   SMOKE_TUNERID=http://localhost:3401/api/v1 npx ts-node -r tsconfig-paths/register scripts/e2e-tunerid.ts
 *
 * Precisa do .env local com TUNERID_API_URL apontando para a 3499,
 * TUNERID_VALIDADE_SEGUNDOS=2, CONTAS_EMERGENCIA e TUNERID_EMPRESAS.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaModule } from '../src/database/prisma.module';
import { PrismaService } from '../src/database/prisma.service';
import { TuneridModule } from '../src/modules/tunerid/tunerid.module';
import { TuneridService } from '../src/modules/tunerid/tunerid.service';
import { AuthModule } from '../src/modules/auth/auth.module';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';
import { OrganizationsRepository } from '../src/modules/organizations/organizations.repository';
import { ChannelAccessService } from '../src/modules/iam/channel-access/channel-access.service';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';

const TUNERID = process.env.SMOKE_TUNERID ?? 'http://localhost:3401/api/v1';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(TUNERID)) {
  console.error(`Recusado: ${TUNERID} não é local. Este teste ESCREVE.`);
  process.exit(1);
}
const ADMIN_EMAIL = process.env.SMOKE_EMAIL ?? 'ti.rossini@gmail.com';
const ADMIN_SENHA = process.env.SMOKE_SENHA ?? 'tunerid-local-0002';
const EMERG = { email: 'admin@conversas.local', senha: 'conversas-local-2026' };
const ESPERA = 2600; // TUNERID_VALIDADE_SEGUNDOS=2 + folga

/** Só o serviço de canais: o módulo real traz controladores que exigem o gateway (e o Redis). */
@Global()
@Module({ providers: [ChannelAccessService], exports: [ChannelAccessService] })
class CanaisDeTeste {}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, CanaisDeTeste, TuneridModule, AuthModule],
})
class ModuloDeTeste {}

// ───────────────────────────── intermediário que finge o TunerID cair
let ligado = true;
const destino = new URL(TUNERID);
const intermediario = http.createServer((req, res) => {
  if (!ligado) return void req.socket.destroy();
  const p = http.request(
    { host: destino.hostname, port: destino.port, path: req.url, method: req.method, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  p.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(p);
});

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passou = 0;
let falhou = 0;
function confere(nome: string, ok: boolean, detalhe = '') {
  if (ok) { passou++; console.log(`  ok      ${nome}`); }
  else { falhou++; console.log(`  FALHOU  ${nome}  ${detalhe.slice(0, 220)}`); }
}
async function tid(metodo: string, rota: string, corpo?: unknown, token?: string, orgId?: string) {
  const r = await fetch(TUNERID + rota, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { 'x-org-id': orgId } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let json: any = null;
  try { json = JSON.parse(txt); } catch { /* vazio */ }
  return { status: r.status, ok: r.ok, json, txt };
}
/** Executa e devolve o erro (ou null), para conferir recusas sem try/catch espalhado. */
async function falha(fn: () => Promise<unknown>) {
  try { await fn(); return null; } catch (e) { return e as { status?: number; message?: string; getStatus?: () => number }; }
}
const status = (e: any) => (e?.getStatus ? e.getStatus() : e?.status);

/** Uma conexão ao vivo de mentira: só o que o gateway lê e faz. */
function conexao(data: Record<string, unknown>) {
  const s = { data, eventos: [] as unknown[], caiu: false,
    emit(ev: string, d: unknown) { s.eventos.push([ev, d]); },
    disconnect() { s.caiu = true; } };
  return s;
}

async function main() {
  await new Promise<void>((ok) => intermediario.listen(3499, ok));
  const app = await NestFactory.createApplicationContext(ModuloDeTeste, { logger: ['error', 'warn'] });
  // O .env de OUTRO sistema exportado no shell vence o .env daqui (variável já
  // definida não é sobrescrita) — e aí este teste escreveria no banco errado.
  if (!/\/chat_bullq(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
    console.error(`Recusado: DATABASE_URL não é o banco do Conversas (${(process.env.DATABASE_URL ?? '').replace(/:[^:@/]+@/, ':***@')}).`);
    await app.close();
    intermediario.close();
    process.exit(1);
  }
  const prisma = app.get(PrismaService);
  const auth = app.get(AuthService);
  const tunerid = app.get(TuneridService);
  const jwt = app.get(JwtStrategy);
  const orgs = new OrganizationsService(new OrganizationsRepository(prisma), tunerid);
  const gateway = new RealtimeGateway(
    app.get(JwtService),
    app.get(ConfigService),
    { setOnline: async () => undefined, setOffline: async () => undefined } as never,
    prisma,
    new ChannelAccessService(prisma),
    tunerid,
    auth,
  );
  const reconferir = () => (gateway as any).reconferir() as Promise<void>;

  const exatekLocal = await prisma.organization.findUniqueOrThrow({ where: { slug: 'exatek-local-x1' } });
  const editacastLocal = await prisma.organization.findUniqueOrThrow({ where: { slug: 'editacast-local-x2' } });

  // ── TunerID: admin e pessoa de teste
  const adm = await tid('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_SENHA });
  if (!adm.ok) throw new Error(`login admin TunerID: ${adm.txt.slice(0, 160)}`);
  const admin = adm.json.token;
  const orgPor = (slug: string) => adm.json.user.memberships.find((m: any) => m.orgSlug === slug)?.orgId;
  const EXATEK = orgPor('exatek');
  const EDITACAST = orgPor('editacast');
  const carimbo = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const email = `zz.e2e.conversas.${carimbo}@teste.local`;
  const pessoa = await tid('POST', '/pessoas', { nome: `ZZ E2E conversas ${carimbo}` }, admin, EXATEK);
  const personId = pessoa.json.id;
  const prov = `provisoria-${carimbo}`;
  await tid('POST', `/pessoas/${personId}/acesso`, { email, senha: prov }, admin, EXATEK);
  let l = await tid('POST', '/auth/login', { email, password: prov });
  const senha = `definitiva-${carimbo}`;
  await tid('POST', '/auth/change-password', { currentPassword: prov, newPassword: senha }, l.json.token);
  l = await tid('POST', '/auth/login', { email, password: senha });
  const tokenPessoa = l.json.token;
  const recursos = await tid('GET', '/acessos/sistemas', undefined, admin, EXATEK);
  const recurso = recursos.json.find((s: any) => s.ssoApp === 'conversas').id;

  const bilhete = async () => {
    const r = await tid('POST', '/sso/codigo', { app: 'conversas', state: 'estado-e2e-conversas-1' }, tokenPessoa);
    return r.ok ? new URL(r.json.redirecionarPara).searchParams.get('code')! : null;
  };

  console.log('\n[conversas] entrada');
  confere('sem acesso liberado, o TunerID nem emite bilhete', (await bilhete()) === null);
  let g = await tid('POST', `/acessos/pessoas/${personId}/grants`, { systemId: recurso, orgId: EXATEK, perfil: 'AGENT' }, admin, EXATEK);
  confere('libera o Conversas da Exatek como Atendente', g.ok, g.txt);
  let grantId = g.json?.id;
  const sessao: any = await auth.loginPorTunerId((await bilhete())!);
  const org0 = sessao.organizations?.[0];
  confere('a conta nasce no Conversas, na empresa mapeada, como AGENT',
    sessao.organizations?.length === 1 && org0?.id === exatekLocal.id && org0?.role === 'AGENT', JSON.stringify(sessao.organizations));
  const user = await prisma.user.findFirstOrThrow({ where: { email } });
  const payloadTunerid = { sub: user.id, email, via: 'tunerid' as const };

  console.log('\n[conversas] senha local');
  let e = await falha(() => auth.login({ email, password: 'qualquer-123456' } as never));
  confere('senha daqui recusada para quem não é emergência (403)', status(e) === 403, String(e?.message));
  e = await falha(() => auth.login({ email: EMERG.email, password: EMERG.senha } as never));
  confere('conta de emergência entra com a senha daqui', e === null, String(e?.message));
  e = await falha(() => auth.register({ name: 'X', email: 'conv.x@teste.local', password: '12345678', inviteToken: 'qualquer' } as never));
  confere('convite não cria conta fora da transição (403)', status(e) === 403, String(e?.message));

  console.log('\n[conversas] papel decidido no TunerID');
  await tid('PATCH', `/acessos/grants/${grantId}/perfil`, { perfil: 'ADMIN' }, admin, EXATEK);
  await espera(ESPERA);
  await jwt.validate(payloadTunerid);
  let m = await prisma.userOrganization.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: exatekLocal.id } } });
  confere('na próxima requisição, o papel vira ADMIN', m?.role === 'ADMIN', JSON.stringify(m?.role));
  const renovado = await falha(() => auth.refresh(sessao.refreshToken));
  confere('a renovação de sessão segue funcionando', renovado === null, String(renovado?.message));

  console.log('\n[conversas] conexão ao vivo');
  let s = conexao({ userId: user.id, email, via: 'tunerid', organizationId: exatekLocal.id, role: 'AGENT', channelIds: [] });
  (gateway as any).server = { fetchSockets: async () => [s] };
  await reconferir();
  confere('papel mudou desde que conectou: a conexão cai para reconectar certa', s.caiu && JSON.stringify(s.eventos).includes('acesso-mudou'), JSON.stringify(s.eventos));
  s = conexao({ userId: user.id, email, via: 'tunerid', organizationId: exatekLocal.id, role: 'ADMIN', channelIds: [] });
  (gateway as any).server = { fetchSockets: async () => [s] };
  await reconferir();
  confere('nada mudou: a conexão fica', !s.caiu, JSON.stringify(s.eventos));

  console.log('\n[conversas] várias empresas');
  await tid('POST', `/pessoas/${personId}/vinculos`, { orgId: EDITACAST }, admin, EXATEK);
  const g2 = await tid('POST', `/acessos/pessoas/${personId}/grants`, { systemId: recurso, orgId: EDITACAST, perfil: 'AGENT' }, admin, EXATEK);
  confere('libera também o Conversas da EditaCast', g2.ok, g2.txt);
  await espera(ESPERA);
  await jwt.validate(payloadTunerid);
  let ms = await prisma.userOrganization.findMany({ where: { userId: user.id }, select: { organizationId: true, role: true } });
  confere('ganha a segunda empresa (mapeada)', ms.length === 2 && ms.some((x) => x.organizationId === editacastLocal.id && x.role === 'AGENT'), JSON.stringify(ms));
  await tid('PATCH', `/acessos/grants/${g2.json.id}/revogar`, {}, admin, EXATEK);
  await espera(ESPERA);
  await jwt.validate(payloadTunerid);
  ms = await prisma.userOrganization.findMany({ where: { userId: user.id }, select: { organizationId: true, role: true } });
  confere('cortar a EditaCast tira só ela', ms.length === 1 && ms[0].organizationId === exatekLocal.id, JSON.stringify(ms));

  console.log('\n[conversas] travas da tela Equipe');
  e = await falha(() => orgs.inviteMember(exatekLocal.id, { email: 'novo.conv@teste.local', role: 'AGENT' } as never, user.id));
  confere('convidar alguém novo: recusado (contas nascem no TunerID)', status(e) === 403, String(e?.message));
  e = await falha(() => orgs.updateMemberRole(exatekLocal.id, user.id, { role: 'AGENT' } as never, 'OWNER' as never));
  confere('mudar papel de quem é do TunerID: recusado', status(e) === 403, String(e?.message));
  e = await falha(() => orgs.updateMember(exatekLocal.id, user.id, { isActive: false } as never, 'OWNER' as never));
  confere('desativar quem é do TunerID: recusado', status(e) === 403, String(e?.message));
  e = await falha(() => orgs.resetMemberPassword(exatekLocal.id, user.id, 'nova-senha-123', 'OWNER' as never));
  confere('redefinir senha de quem é do TunerID: recusado', status(e) === 403, String(e?.message));
  // A tela manda o id da PARTICIPAÇÃO, não o do usuário: a trava tem de valer igual.
  const participacao = await prisma.userOrganization.findUniqueOrThrow({
    where: { userId_organizationId: { userId: user.id, organizationId: exatekLocal.id } },
  });
  e = await falha(() => orgs.updateMemberRole(exatekLocal.id, participacao.id, { role: 'AGENT' } as never, 'OWNER' as never));
  confere('pelo id da participação (como a tela manda): papel recusado', status(e) === 403, String(e?.message));
  e = await falha(() => orgs.removeMember(exatekLocal.id, participacao.id, 'outro-usuario'));
  confere('pelo id da participação: remover recusado', status(e) === 403, String(e?.message));
  e = await falha(() => orgs.updateMember(exatekLocal.id, participacao.id, { isActive: false } as never, 'OWNER' as never));
  confere('pelo id da participação: desativar recusado', status(e) === 403, String(e?.message));
  e = await falha(() => orgs.resetMemberPassword(exatekLocal.id, participacao.id, 'nova-senha-123', 'OWNER' as never));
  confere('pelo id da participação: redefinir senha recusado', status(e) === 403, String(e?.message));
  const membros: any[] = await orgs.getMembers(exatekLocal.id);
  confere('a lista marca quem é gerido e quem é emergência',
    membros.find((x) => x.user.email === email)?.geridoPeloTunerId === true &&
      membros.find((x) => x.user.email === EMERG.email)?.geridoPeloTunerId === false);

  console.log('\n[conversas] TunerID fora do ar');
  ligado = false;
  await espera(ESPERA);
  e = await falha(() => jwt.validate(payloadTunerid));
  confere('quem estava dentro segue trabalhando (tolerância)', e === null, String(e?.message));
  ligado = true;

  console.log('\n[conversas] cortar');
  await tid('PATCH', `/acessos/grants/${grantId}/revogar`, {}, admin, EXATEK);
  await espera(ESPERA);
  e = await falha(() => jwt.validate(payloadTunerid));
  confere('a requisição seguinte cai (401)', status(e) === 401, String(e?.message));
  e = await falha(() => auth.refresh(sessao.refreshToken));
  confere('e a renovação de sessão também (401) — não renova por 7 dias', status(e) === 401, String(e?.message));
  s = conexao({ userId: user.id, email, via: 'tunerid', organizationId: exatekLocal.id, role: 'ADMIN', channelIds: [] });
  (gateway as any).server = { fetchSockets: async () => [s] };
  await reconferir();
  confere('a conexão ao vivo aberta cai com "acesso-encerrado"', s.caiu && JSON.stringify(s.eventos).includes('acesso-encerrado'), JSON.stringify(s.eventos));
  ligado = false;
  await espera(ESPERA);
  e = await falha(() => jwt.validate(payloadTunerid));
  confere('com o TunerID fora, quem foi cortado continua cortado', status(e) === 401 || status(e) === 503, String(status(e)));
  ligado = true;

  console.log('\n[conversas] volta');
  g = await tid('POST', `/acessos/pessoas/${personId}/grants`, { systemId: recurso, orgId: EXATEK, perfil: 'AGENT' }, admin, EXATEK);
  grantId = g.json?.id;
  const volta: any = await auth.loginPorTunerId((await bilhete())!);
  confere('liberado de novo, entra na MESMA conta', (await prisma.user.count({ where: { email } })) === 1 && volta.organizations?.[0]?.role === 'AGENT');

  console.log(`\n${passou} ok, ${falhou} falha(s)`);
  await app.close();
  intermediario.close();
  process.exit(falhou ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nPAROU: ${err?.stack ?? err}`);
  intermediario.close();
  process.exit(1);
});
