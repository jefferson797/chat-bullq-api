# Plano de Limpeza do DNA herdado (Bravy/Trivapp/Hoppe)

> Inventário exaustivo de 2026-07-16. Contexto: o código foi construído para a **Bravy**
> (mentoria/infoprodutos) integrada ao **Trivapp** (área de membros), **Hoppe** (gerenciador
> de projetos, `hoppe-api.bravy.com.br`) e conta Google **asv.digital**. "Sofia" é um agente
> de IA de implementação (`agent_sofia_001`), não uma pessoa. Nada disso pertence à Exatek.
>
> **Boa notícia estrutural:** a herança está concentrada no módulo `ai-agents` (tools, evals,
> classifier, prompts), no `daily-reminder`, em seeds/envs e em strings de exemplo. O core do
> produto (inbox, CRM, automações, filas, realtime) está limpo — inclusive **não há canais-fachada**
> no front (Telegram/Email/SMS não existem; só WhatsApp Official/Zappfy/Instagram, todos reais).

## ⚠️ Alerta de segurança (fazer antes de tudo)

Os `.env` locais (api e mcp) contêm **chaves reais herdadas do dev anterior**: `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, JWT secrets e `CHAT_BULLQ_API_KEY`. Estão no `.gitignore` (não versionadas),
mas foram geradas em conta de terceiro → **rotacionar todas** e passar a usar contas próprias.

## Onda 1 — deletar hoje, sem medo (morto/cosmético)

| # | Item | Onde | Status |
|---|---|---|---|
| 1 | Evals Bravy inteiras (personas Daniel/André/Bruno/Augusto/Lívia, venda de mentoria) | `src/modules/ai-agents/evals/datasets/*.eval.ts`, `datasets/index.ts`, `fixtures/conversations.ts` | MORTO em prod (só CLI) |
| 2 | Placeholders no front ("Vendas Mentoria", "Lead Bravy School", "MAESTRIA", `bravy.co`, `api.trivapp.com.br`) | `settings/ai/page.tsx:403-457`, `pipelines/page.tsx:89`, `card-dialog.tsx:120`, `create-agent-dialog.tsx:138`, `jarvis/tool-dialog.tsx`, `tools-tab.tsx:79`, `ai-catalog.service.ts:9` | cosmético |
| 3 | Comentários com exemplos Bravy no schema (`AiTool:923-928`, `AiAgent.operationalContext:861-867`, `Product`) e `personality.layer.ts:9` | `prisma/schema.prisma` | cosmético |
| 4 | Seed `admin@bravy.com`/"Bravy HQ" → dados Exatek via env | `prisma/seed.ts` | vivo (dev) |
| 5 | `.env.example` (`bravy:bravy123`, `MINIO_ACCESS_KEY=bravy`) + exemplos Swagger `joao@bravy.com` | `.env.example`, `auth/dto/*`, `organizations/dto/*` | cosmético |
| 6 | Docs desatualizadas (`SETUP-LOCAL.md`, `DEPLOY-COOLIFY.md` com login bravy; arquivar `docs/orchestration-improvements-from-bullq.md`) | raiz + docs | doc |
| 7 | baseUrl default `api.chat.bravy.com.br` do MCP → domínio Exatek/env obrigatória | `chat-bullq-mcp/src/config.ts:2` | vivo (fallback) |

## Onda 2 — deletar com atenção (dormente; tirar código + módulos + envs)

| # | Item | Onde | Cuidado |
|---|---|---|---|
| 8 | Módulo **daily-reminder** inteiro (lembrete 8:50 "Meta do dia R$1.000" da equipe Bravy; número já foi pra env, resta o módulo) | `daily-reminder/*` + `app.module.ts:21,68` + envs `REMINDER_*` | cron roda no boot |
| 9 | Bloco **client-ops** da Sofia: Hoppe + Google Calendar/Drive + ClickUp/n8n do cliente | `tools/client-ops/*` (8 services) + 5 builtin tools (`agendar-reuniao`, `consultar-clickup-cliente`, `consultar-n8n-cliente`, `listar-reunioes-cliente`, `ler-transcricao-reuniao`) + `tools.module.ts` + `tool-registry.service.ts:15-19,51-55,83-88` + envs `HOPPE_*`, `GOOGLE_OAUTH_*`, `SOFIA_*`, `DRIVE_*`, `CLIENT_OPS_AGENT_IDS` | **o registry injeta as tools no construtor — remover arquivo sem tirar a injeção quebra o boot** |
| 10 | Tools **Trivapp**: `get-product-pitch.tool.ts` (lookupOffering), `check-members-access.tool.ts`, `check-bonus-eligibility.tool.ts` (regra "bônus D+7 portal Bravy"), `runner/catalog-sync.service.ts` + refs em `http-tool-executor.service.ts:72,253,355` + envs `MEMBERS_*` | módulo ai-agents | são **ofertadas ao LLM** hoje; ao religar a IA, apontar catálogo pro `ProductsModule` local (já religado) |

## Onda 3 — precisa decisão de produto / migration

| # | Item | Onde | Decisão |
|---|---|---|---|
| 11 | **`classifier.prompt.ts`** inteiro ("empresa que vende cursos online", agentes nominais Daniel Souza etc.) — VIVO em todo run de IA | `classifier/classifier.prompt.ts:9-42` | reescrever data-driven (intents/agentes do DB, roteamento por ID) — faz parte do PLANO-IA-V2 |
| 12 | Linguagem de venda de infoproduto chumbada no runner/prompt-builder (pitch/checkout/lookupOffering) | `agent-runner.service.ts:50-51,148-149,356`, `prompt-builder.service.ts:26,95,292` | reescrever no PLANO-IA-V2 |
| 13 | Modelo **`InternalNote`** órfão (zero referências em código) | `schema.prisma:528-539` + relação em Conversation | remover via migration OU implementar a feature (notas internas é joia desejada) |
| 14 | **Web Push morto**: `PushSubscription`/`NotificationPreference.browserPush` nunca lidos/escritos, VAPID vazio | schema + envs | implementar ou remover (migration) |

**Ordem de execução recomendada:** rotação de chaves → Onda 1 (1 sessão, risco ~zero) → Onda 2 (1 sessão, testar boot + smoke) → Onda 3 junto com a reconstrução da IA (PLANO-IA-V2) pra não mexer no mesmo código duas vezes.
