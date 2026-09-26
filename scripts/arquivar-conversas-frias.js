#!/usr/bin/env node
/**
 * Arquiva conversas frias — as que ninguém toca há muito tempo.
 *
 * Por quê: a caixa da Exatek tem ~1.080 conversas "ativas" acumuladas desde
 * junho/2026. O que chega hoje se perde no meio do que morreu em julho, e o
 * cartão "Conversas ativas" do painel vira um número sem significado.
 *
 * Arquivar NÃO é fechar nem apagar: o status (PENDING/OPEN) é preservado, a
 * conversa continua pesquisável, e **se o cliente escrever de novo ela volta
 * sozinha pra caixa** (o inbound desarquiva — ver `unarchiveOnInbound` no
 * inbound-message.processor). Por isso é seguro fazer em lote.
 *
 * Usa a API (não o banco) de propósito: passa pelo serviço, grava quem
 * arquivou e emite os eventos de tempo real que a interface escuta.
 *
 * Uso:
 *   set -a; . ~/.config/tuner/secrets.env; set +a
 *   DIAS=60 node scripts/arquivar-conversas-frias.js           # ensaio
 *   DIAS=60 APPLY=1 node scripts/arquivar-conversas-frias.js   # aplica
 */
const API = (process.env.CONVERSAS_API_URL || 'https://conversas-api.tunergroup.com.br/api/v1').replace(/\/$/, '');
const ORG = process.env.CONVERSAS_ORG_ID || 'cmqed6hn90001pb07bnd6ires'; // Exatek
const EMAIL = process.env.CONVERSAS_ADMIN_EMAIL;
const SENHA = process.env.CONVERSAS_ADMIN_PASSWORD;
const DIAS = Math.min(Math.max(parseInt(process.env.DIAS || '60', 10) || 60, 7), 365);
const APPLY = process.env.APPLY === '1';

if (!EMAIL || !SENHA) {
  console.error('Faltam CONVERSAS_ADMIN_EMAIL / CONVERSAS_ADMIN_PASSWORD (carregue o cofre).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: SENHA }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  const d = await r.json();
  return (d.data || d).accessToken;
}

(async () => {
  const token = await login();
  const h = { Authorization: `Bearer ${token}`, 'x-organization-id': ORG };
  const limite = new Date(Date.now() - DIAS * 86_400_000);

  // Varre a caixa toda (não arquivadas). Páginas de 100.
  const frias = [];
  const quentes = [];
  for (let page = 1; page <= 40; page++) {
    const r = await fetch(`${API}/conversations?limit=100&page=${page}&archived=exclude`, { headers: h });
    if (!r.ok) throw new Error(`listar ${r.status}`);
    const cs = (await r.json()).data.conversations || [];
    if (!cs.length) break;
    for (const c of cs) {
      const quando = new Date(c.lastMessageAt || c.createdAt);
      const alvo = { id: c.id, nome: c.contact?.name || c.contact?.phone || c.id, em: quando, status: c.status };
      // BOT = triagem em andamento; nunca arquivar no meio do atendimento.
      if (c.status === 'BOT') continue;
      (quando < limite ? frias : quentes).push(alvo);
    }
  }

  console.log(`conversas na caixa: ${frias.length + quentes.length}`);
  console.log(`  paradas há mais de ${DIAS} dias: ${frias.length}  ← seriam arquivadas`);
  console.log(`  com movimento recente:           ${quentes.length}  ← ficam`);
  if (frias.length) {
    const ord = [...frias].sort((a, b) => a.em - b.em);
    console.log(`  mais antiga: ${ord[0].em.toISOString().slice(0, 10)} (${ord[0].nome})`);
    console.log(`  mais nova:   ${ord[ord.length - 1].em.toISOString().slice(0, 10)} (${ord[ord.length - 1].nome})`);
    const porStatus = frias.reduce((a, c) => ((a[c.status] = (a[c.status] || 0) + 1), a), {});
    console.log('  por status:', porStatus);
  }
  if (!APPLY) {
    console.log('\nensaio — nada arquivado. Rode com APPLY=1 para aplicar.');
    return;
  }

  let ok = 0, falhas = 0;
  for (const c of frias) {
    try {
      const r = await fetch(`${API}/conversations/${c.id}/archive`, { method: 'POST', headers: h });
      if (!r.ok) throw new Error(`${r.status}`);
      ok++;
      if (ok % 50 === 0) console.log(`  ...${ok}/${frias.length}`);
    } catch (e) {
      falhas++;
      console.warn(`  falhou ${c.nome}: ${e.message}`);
    }
    await sleep(40);
  }
  console.log(`\narquivadas: ${ok} | falhas: ${falhas}`);
  console.log('Se algum desses clientes escrever de novo, a conversa volta pra caixa sozinha.');
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
