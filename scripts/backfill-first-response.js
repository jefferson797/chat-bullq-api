// Reconstrói `conversations.first_response_at` a partir do histórico de mensagens.
//
// Por que existe: até 25/09/2026 esse campo só era carimbado pelo `fsm.assign`
// (que roda em PENDING→OPEN), e o auto-assign atribui sem mexer no status — então
// ficava nulo em praticamente toda conversa. Resultado: os cartões "Tempo 1ª
// resposta" e "SLA Compliance" do dashboard nasciam vazios. O dado real sempre
// existiu na tabela de mensagens: a 1ª mensagem OUTBOUND com `sender_id` (isto é,
// escrita por uma pessoa, não pelo robô nem pela IA) É a primeira resposta.
//
// Faz duas coisas:
//   1. PREENCHE onde está nulo (a resposta tem que ser depois do início da conversa);
//   2. CORRIGE carimbo mentiroso. Na migração em massa de julho/2026 o `fsm.assign`
//      carimbou `first_response_at` com a hora da MIGRAÇÃO em conversas antigas —
//      viram "respostas" de 15 dias que destroem a média. Onde a 1ª mensagem humana
//      real é anterior ao carimbo, o carimbo é substituído por ela; onde não existe
//      mensagem humana nenhuma, o carimbo volta a ser nulo (nunca foi respondida).
//
// Uso (Terminal do Mac, com o cofre carregado):
//   set -a; . ~/.config/tuner/secrets.env; set +a
//   node scripts/backfill-first-response.js            # dry-run: só conta
//   APPLY=1 node scripts/backfill-first-response.js    # aplica
// Env opcional: ORG_ID (default: Exatek).
const { Client } = require('pg');

const C = 'http://76.13.175.154:8000/api/v1';
const DB = 'kka8xutfwwehe22em8cac1cf'; // chat-bullq-postgres no Coolify
const TOKEN = process.env.COOLIFY_TOKEN;
const ORG = process.env.ORG_ID || 'cmqed6hn90001pb07bnd6ires'; // Exatek
const APPLY = process.env.APPLY === '1';
const PUBLIC_PORT = 5434;

if (!TOKEN) {
  console.error('COOLIFY_TOKEN ausente. Rode: set -a; . ~/.config/tuner/secrets.env; set +a');
  process.exit(1);
}

const h = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setPublic(isPublic) {
  const body = isPublic ? { is_public: true, public_port: PUBLIC_PORT } : { is_public: false };
  const r = await fetch(`${C}/databases/${DB}`, { method: 'PATCH', headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH is_public=${isPublic}: ${r.status} ${await r.text()}`);
}

async function connectWithRetry(info) {
  for (let i = 0; i < 20; i++) {
    const client = new Client({
      host: '76.13.175.154', port: PUBLIC_PORT,
      user: info.postgres_user, password: info.postgres_password, database: info.postgres_db,
      connectionTimeoutMillis: 5000,
    });
    try { await client.connect(); return client; } catch { await sleep(3000); }
  }
  throw new Error('não conectou no banco (porta pública não abriu?)');
}

// 1ª mensagem escrita por gente (sender_id != null) em cada conversa
const PRIMEIRA_HUMANA = `
  SELECT conversation_id, MIN(created_at) AS em
  FROM messages
  WHERE direction = 'OUTBOUND' AND sender_id IS NOT NULL
  GROUP BY conversation_id`;

(async () => {
  const info = await (await fetch(`${C}/databases/${DB}`, { headers: h })).json();
  await setPublic(true);
  let client;
  try {
    client = await connectWithRetry(info);

    const suspeitos = await client.query(
      `SELECT count(*)::int AS n FROM conversations c
       LEFT JOIN (${PRIMEIRA_HUMANA}) m ON m.conversation_id = c.id
       WHERE c.organization_id = $1 AND c.first_response_at IS NOT NULL
         AND (m.em IS NULL OR m.em < c.first_response_at - interval '1 minute')`,
      [ORG],
    );
    console.log(`carimbos a corrigir (resíduo da migração): ${suspeitos.rows[0].n}`);

    const previa = await client.query(
      `SELECT count(*)::int AS n,
              round(avg(EXTRACT(EPOCH FROM (m.em - c.created_at)) / 60)::numeric, 1) AS media_min,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (m.em - c.created_at)) / 60))::numeric, 1) AS mediana_min
       FROM conversations c JOIN (${PRIMEIRA_HUMANA}) m ON m.conversation_id = c.id
       WHERE c.organization_id = $1 AND c.first_response_at IS NULL AND m.em > c.created_at`,
      [ORG],
    );
    const p = previa.rows[0];
    console.log(`a preencher: ${p.n} conversas | média ${p.media_min} min | mediana ${p.mediana_min} min`);
    if (!APPLY) {
      console.log('dry-run — nada alterado. Rode com APPLY=1 para aplicar.');
      return;
    }

    const upd = await client.query(
      `UPDATE conversations c
       SET first_response_at = m.em, updated_at = now()
       FROM (${PRIMEIRA_HUMANA}) m
       WHERE c.id = m.conversation_id
         AND c.organization_id = $1
         AND c.first_response_at IS NULL
         AND m.em > c.created_at`,
      [ORG],
    );
    console.log(`preenchidas: ${upd.rowCount}`);

    // 2) corrige quem foi carimbado pela migração
    const corr = await client.query(
      `UPDATE conversations c
       SET first_response_at = m.em, updated_at = now()
       FROM (${PRIMEIRA_HUMANA}) m
       WHERE c.id = m.conversation_id
         AND c.organization_id = $1
         AND c.first_response_at IS NOT NULL
         AND m.em < c.first_response_at - interval '1 minute'
         AND m.em > c.created_at`,
      [ORG],
    );
    const zerados = await client.query(
      `UPDATE conversations c
       SET first_response_at = NULL, updated_at = now()
       WHERE c.organization_id = $1
         AND c.first_response_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages m
           WHERE m.conversation_id = c.id AND m.direction = 'OUTBOUND' AND m.sender_id IS NOT NULL
         )`,
      [ORG],
    );
    console.log(`corrigidas: ${corr.rowCount} | zeradas (nunca respondidas de verdade): ${zerados.rowCount}`);

    const depois = await client.query(
      `SELECT count(*)::int AS total,
              count(first_response_at)::int AS com_carimbo,
              round(avg(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60)
                    FILTER (WHERE first_response_at IS NOT NULL)::numeric, 1) AS media_min,
              round((percentile_cont(0.5) WITHIN GROUP (
                      ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60))::numeric, 1) AS mediana_min
       FROM conversations WHERE organization_id = $1 AND deleted_at IS NULL`,
      [ORG],
    );
    const d = depois.rows[0];
    console.log(`agora: ${d.com_carimbo}/${d.total} conversas com 1ª resposta · média ${d.media_min} min · mediana ${d.mediana_min} min`);
  } catch (e) {
    throw e;
  } finally {
    if (client) await client.end().catch(() => {});
    await setPublic(false);
    console.log('porta pública do banco fechada');
  }
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
