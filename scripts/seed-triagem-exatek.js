/* eslint-disable no-console */
/**
 * SEED DO FLUXO "Triagem Exatek" (chatbot de regras) — idempotente.
 *
 * O que faz: cria (ou atualiza) o fluxo, grava os nós com ids fixos, vincula ao
 * canal e (opcionalmente) ativa. Roda contra a API pública com login de admin.
 *
 * Uso:
 *   API_URL=https://conversas-api.tunergroup.com.br/api/v1 \
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... [CHANNEL_NAME=exatek] [ACTIVATE=1] \
 *     node scripts/seed-triagem-exatek.js
 *
 * Regras de negócio (Jefferson, 2026-09-20):
 *   - só impressão DTF (filme): mínimo 0,5 m, R$ 39/m
 *   - camiseta pronta (impressão + camiseta + prensa): mínimo 10 unidades
 */
const API = (process.env.API_URL || 'https://conversas-api.tunergroup.com.br/api/v1').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const CHANNEL_NAME = (process.env.CHANNEL_NAME || 'exatek').toLowerCase();
const ACTIVATE = process.env.ACTIVATE === '1';
const FLOW_NAME = 'Triagem Exatek';

// ids fixos (as edges apontam pra eles; o backend preserva ids enviados)
const N = {
  start: 'triagem-exatek-start',
  menu: 'triagem-exatek-menu',
  impressaoMsg: 'triagem-exatek-impressao-msg',
  impressaoTransfer: 'triagem-exatek-impressao-transfer',
  camisetaMenu: 'triagem-exatek-camiseta-menu',
  camisetaOkMsg: 'triagem-exatek-camiseta-ok-msg',
  camisetaOkTransfer: 'triagem-exatek-camiseta-ok-transfer',
  camisetaMinMsg: 'triagem-exatek-camiseta-min-msg',
  end: 'triagem-exatek-end',
  fallbackTransfer: 'triagem-exatek-fallback-transfer',
};

const nodes = [
  { id: N.start, type: 'START', name: 'Início', positionX: 0, positionY: 0, data: {}, edges: [{ targetNodeId: N.menu }] },
  {
    id: N.menu, type: 'MENU', name: 'O que você precisa?', positionX: 0, positionY: 120,
    data: {
      title: 'Oi! Aqui é a Exatek 👋 Pra te atender rápido, me diz o que você precisa:',
      options: [
        { label: 'Só a impressão DTF (a gente imprime o filme, você aplica)', value: 'impressao',
          keywords: ['impress', 'filme', 'dtf', 'metro', 'transfer', 'so a impressao', 'apenas'] },
        { label: 'Camiseta pronta (impressa e prensada)', value: 'camiseta',
          keywords: ['camiseta', 'camisa', 'pronta', 'prensad', 'blusa', 'uniforme', 'peca', 'moletom'] },
      ],
      invalidMessage: 'Não entendi 😅 Responde com 1 (só impressão) ou 2 (camiseta pronta).',
    },
    edges: [
      { targetNodeId: N.impressaoMsg, condition: 'impressao' },
      { targetNodeId: N.camisetaMenu, condition: 'camiseta' },
      { targetNodeId: N.fallbackTransfer, condition: 'fallback' },
    ],
  },
  {
    id: N.impressaoMsg, type: 'MESSAGE', name: 'Impressão: instruções', positionX: -220, positionY: 260,
    data: { message: 'Perfeito! Trabalhamos a partir de meio metro (R$ 39/m). Me manda a arte e a quantidade que já te passo valor e prazo. 🙂' },
    edges: [{ targetNodeId: N.impressaoTransfer }],
  },
  { id: N.impressaoTransfer, type: 'TRANSFER', name: 'Humano (impressão)', positionX: -220, positionY: 380, data: { message: '' }, edges: [] },
  {
    id: N.camisetaMenu, type: 'MENU', name: 'Quantas camisetas?', positionX: 220, positionY: 260,
    data: {
      title: 'Camiseta pronta a gente faz a partir de 10 unidades (impressão + camiseta + prensa). Quantas você precisa?',
      options: [
        { label: '10 ou mais', value: 'dez_ou_mais', keywords: ['10', 'dez', 'mais', 'muitas', 'varias', 'lote'] },
        { label: 'Menos de 10', value: 'menos_de_dez', keywords: ['menos', 'uma', '1 ', 'so uma', 'duas', 'tres', 'poucas', 'unidade'] },
      ],
      invalidMessage: 'Não entendi 😅 Responde com 1 (10 ou mais) ou 2 (menos de 10).',
    },
    edges: [
      { targetNodeId: N.camisetaOkMsg, condition: 'dez_ou_mais' },
      { targetNodeId: N.camisetaMinMsg, condition: 'menos_de_dez' },
      { targetNodeId: N.fallbackTransfer, condition: 'fallback' },
    ],
  },
  {
    id: N.camisetaOkMsg, type: 'MESSAGE', name: 'Camiseta ok', positionX: 120, positionY: 400,
    data: { message: 'Ótimo! Me manda a arte, a quantidade por tamanho e a cor da camiseta que já monto o orçamento. 🙂' },
    edges: [{ targetNodeId: N.camisetaOkTransfer }],
  },
  { id: N.camisetaOkTransfer, type: 'TRANSFER', name: 'Humano (camiseta)', positionX: 120, positionY: 520, data: { message: '' }, edges: [] },
  {
    id: N.camisetaMinMsg, type: 'MESSAGE', name: 'Abaixo do mínimo', positionX: 360, positionY: 400,
    data: { message: 'Entendi! Pra menos de 10 peças não conseguimos atender com camiseta pronta. Uma saída boa: a gente imprime só o filme DTF a partir de meio metro (R$ 39/m) e qualquer estamparia perto de você aplica na hora. Se quiser seguir assim, é só responder aqui. Obrigado pelo contato! 🙏' },
    edges: [{ targetNodeId: N.end }],
  },
  { id: N.end, type: 'END_FLOW', name: 'Encerra (abaixo do mínimo)', positionX: 360, positionY: 520, data: {}, edges: [] },
  { id: N.fallbackTransfer, type: 'TRANSFER', name: 'Humano (não entendeu)', positionX: 0, positionY: 640, data: { message: 'Sem problema, já te passo pra alguém da equipe. 🙂' }, edges: [] },
];

async function api(path, init = {}, token, orgId) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { 'x-organization-id': orgId } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body?.data ?? body;
}

async function main() {
  if (!EMAIL || !PASSWORD) { console.error('Faltam ADMIN_EMAIL / ADMIN_PASSWORD'); process.exit(1); }
  const login = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const token = login.accessToken || login.access_token || login.token;
  const orgs = login.organizations || login.user?.organizations || [];
  const org = orgs.find((o) => /exatek/i.test(o.name || o.organization?.name || '')) || orgs[0];
  const orgId = org?.organizationId || org?.id || org?.organization?.id;
  if (!token || !orgId) { console.error('Login ok mas sem token/org:', JSON.stringify(login).slice(0, 300)); process.exit(1); }
  console.log(`org: ${orgId}`);

  const channels = await api('/channels', {}, token, orgId);
  const list = channels.channels || channels.items || channels;
  const channel = list.find((c) => (c.name || '').toLowerCase().includes(CHANNEL_NAME)) || list[0];
  if (!channel) { console.error('Nenhum canal encontrado'); process.exit(1); }
  console.log(`canal: ${channel.name} (${channel.id})`);

  const flows = await api('/chatbot-flows', {}, token, orgId);
  const flowList = flows.flows || flows.items || flows;
  let flow = flowList.find((f) => f.name === FLOW_NAME);
  const base = {
    name: FLOW_NAME,
    description: 'Triagem automática do lead: só impressão (min 0,5 m) vs camiseta pronta (min 10 un). Só pra contato novo; transfere pra humano ou encerra.',
    triggerType: 'FIRST_MESSAGE',
    triggerConfig: { onlyNewContacts: true },
  };
  if (!flow) {
    flow = await api('/chatbot-flows', { method: 'POST', body: JSON.stringify(base) }, token, orgId);
    console.log(`fluxo criado: ${flow.id}`);
  } else {
    await api(`/chatbot-flows/${flow.id}`, { method: 'PATCH', body: JSON.stringify(base) }, token, orgId);
    console.log(`fluxo atualizado: ${flow.id}`);
  }
  await api(`/chatbot-flows/${flow.id}/nodes`, { method: 'POST', body: JSON.stringify({ nodes }) }, token, orgId);
  console.log(`nós gravados: ${nodes.length}`);
  await api(`/chatbot-flows/${flow.id}/channels`, { method: 'POST', body: JSON.stringify({ channelIds: [channel.id] }) }, token, orgId);
  console.log('vinculado ao canal');
  if (ACTIVATE) {
    await api(`/chatbot-flows/${flow.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: true }) }, token, orgId);
    console.log('ATIVADO');
  } else {
    console.log('não ativado (ACTIVATE=1 pra ativar)');
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
