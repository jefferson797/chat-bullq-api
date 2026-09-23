// Transfere a carteira de conversas ATIVAS (OPEN/PENDING) de um agente para outro, direto no banco prod.
// Por que no banco e não via PATCH /conversations/:id: o fsm.assign vira PENDING→OPEN e carimba
// firstResponseAt, o que poluiria SLA/1ª resposta de centenas de conversas antigas. Aqui só muda o dono
// (+ trilha ASSIGNED no audit log), status preservado. Abre a porta pública do Postgres no Coolify só
// durante a execução e fecha ao final (mesmo em erro).
//
// Uso (Terminal do Mac, com o cofre carregado):
//   set -a; . ~/.config/tuner/secrets.env; set +a
//   node scripts/reassign-agent-conversations.js                      # dry-run: só conta
//   APPLY=1 node scripts/reassign-agent-conversations.js              # aplica
// Env opcionais: FROM_USER, TO_USER, ORG_ID (defaults: Juliana → Jefferson, org Exatek, set/2026).
const { Client } = require('pg');

const C = 'http://76.13.175.154:8000/api/v1';
const DB = 'kka8xutfwwehe22em8cac1cf'; // chat-bullq-postgres no Coolify
const TOKEN = process.env.COOLIFY_TOKEN;
const ORG = process.env.ORG_ID || 'cmqed6hn90001pb07bnd6ires'; // Exatek
const FROM = process.env.FROM_USER || 'cmqzmj32o0i6oo707mugs481y'; // Juliana
const TO = process.env.TO_USER || 'cmqed6hn70000pb07yakldbpq'; // Jefferson (conta usada pela Priscila)
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
      host: '76.13.175.154',
      port: PUBLIC_PORT,
      user: info.postgres_user,
      password: info.postgres_password,
      database: info.postgres_db,
      connectionTimeoutMillis: 5000,
    });
    try {
      await client.connect();
      return client;
    } catch {
      await sleep(3000);
    }
  }
  throw new Error('não conectou no banco (porta pública não abriu?)');
}

(async () => {
  const info = await (await fetch(`${C}/databases/${DB}`, { headers: h })).json();
  await setPublic(true);
  let client;
  try {
    client = await connectWithRetry(info);
    const where = `organization_id=$1 AND assigned_to_id=$2 AND deleted_at IS NULL AND status IN ('OPEN','PENDING')`;
    const before = await client.query(
      `SELECT status, count(*)::int AS n FROM conversations WHERE ${where} GROUP BY status ORDER BY status`,
      [ORG, FROM],
    );
    console.log(`antes (dono ${FROM}):`, before.rows);
    if (!APPLY) {
      console.log('dry-run — nada alterado. Rode com APPLY=1 para aplicar.');
      return;
    }

    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE conversations SET assigned_to_id=$3, updated_at=now() WHERE ${where} RETURNING id`,
      [ORG, FROM, TO],
    );
    const ids = upd.rows.map((r) => r.id);
    // trilha de auditoria: um ASSIGNED por conversa (id só precisa ser único)
    const audit = await client.query(
      `INSERT INTO conversation_audit_logs (id, conversation_id, actor_id, action, from_value, to_value, created_at)
       SELECT 'mig' || substr(md5(id || clock_timestamp()::text), 1, 22), id, $1, 'ASSIGNED', $2, $3, now()
       FROM conversations WHERE id = ANY($4::text[])`,
      [TO, FROM, TO, ids],
    );
    await client.query('COMMIT');
    console.log(`migradas: ${ids.length} | audit rows: ${audit.rowCount}`);

    const after = await client.query(
      `SELECT assigned_to_id, status, count(*)::int AS n FROM conversations
       WHERE organization_id=$1 AND deleted_at IS NULL AND status IN ('OPEN','PENDING') AND is_group=false
       GROUP BY 1,2 ORDER BY 1,2`,
      [ORG],
    );
    console.log('depois (ativas por dono/status):', after.rows);
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
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
