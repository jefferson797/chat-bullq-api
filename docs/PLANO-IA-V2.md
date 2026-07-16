# IA v2 — diagnóstico e plano de reconstrução cirúrgica

> Raio-X de 2026-07-16. IA desligada em prod (`org.aiEnabled=false`) porque "erra muito".
> Este documento explica **por que** erra, o que se aproveita, e a ordem certa de religar.

## Por que a IA erra no contexto Exatek (causa raiz)

Não é o modelo, nem um bug isolado: **o subsistema inteiro foi escrito para outra empresa**
(Bravy — venda de cursos/mentoria) **e nunca foi reparametrizado**. Camada por camada:

1. **Conhecimento de negócio errado, chumbado em código.** O prompt de produção instrui um
   vendedor de infoproduto: "bônus D+7 no portal Bravy", "a Maestria... R$97", venda consultiva
   de curso (`runner/prompt-builder.service.ts:48-433`, esp. `:122-143,342-349,329-396`).
   Cliente pergunta de impressão UV/DTF e recebe um agente treinado pra qualificar lead de curso.
2. **Classifier roteia para agentes que não existem.** Prompt chumbado com "Daniel Souza (tráfego),
   André Silva (contabilidade), Bruno Costa (advocacia)" e intents de curso
   (`classifier/classifier.prompt.ts:9-42`); roteamento por **nome literal** (`agent-router.service.ts:113-118`).
   Na Exatek, quase tudo cai em AMBIGUOUS → orchestrator genérico com o prompt contaminado.
3. **Catálogo aponta pra empresa errada.** `lookupOffering`/catalog-sync batem no Trivapp tenant
   Bravy (`get-product-pitch.tool.ts:60-92`, `catalog-sync.service.ts:42-66`) → retorna nada → o
   modelo alucina preço/produto sob pressão. O `Product` local existe e **não é usado pelo runner**.
4. **RAG está morto.** Pipeline completo (embeddings OpenAI, pgvector, retrieval, reranker) mas a
   migration `20260508120100_pgvector_rag` **não existe** — todo retrieve falha em tabela inexistente
   e o erro é engolido (`agent-runner.service.ts:958-960`). Zero memória de longo prazo; só 30 mensagens.
5. **Handoff furado agrava tudo.** `transferToHuman` só cria PendingAction — a conversa continua com
   `aiEnabled=true` até um operador aprovar, então **a IA segue respondendo depois de o cliente pedir
   humano** (`transfer-to-human.tool.ts:87-159` vs `pending-action-executor.processor.ts:135-144`).
6. **Evals não protegem nada.** Testam personas Bravy E usam um sistema de prompt (PromptComposer)
   **diferente do de produção** (PromptBuilder) — `prompts.module.ts:16-18`. Eval verde ≠ produção boa.
7. **Debounce in-memory** (`inbound-message.processor.ts:80,650-748`): com réplicas, respostas duplicadas.

## Bugs de segurança a corrigir ANTES de religar (mesmo em piloto)

- **Skills SQL furam o gate de aprovação**: o executor HTTP checa `requiresApproval`
  (`http-tool-executor.service.ts:84-92`); o SQL **não checa nada** e executa direto
  (`sql-tool-executor.service.ts:24-112`). Skill SQL marcada "requer aprovação" roda sem revisão.
- **`transferToHuman` não silencia a IA na hora** (item 5 acima) — pausar `aiEnabled` da conversa
  no momento do pedido, mantendo a aprovação só para efetivar a atribuição.

## Veredicto peça a peça

**Aproveitar como está (infra neutra, boa):** cliente Anthropic (`llm/llm.service.ts` — caching,
custo, sanitização), mecânica do gate `shouldHandle` (tri-state + horário + token cap), esqueleto do
runner (loop de tools máx. 8, retry transiente, delegação), mecânica do prompt-builder (merge de
turnos, vision), sistema de PendingAction/confirmations, tool-registry, tools genéricas
(reply/tag/transfer/delegate/handBack).

**Aproveitar com ajuste:** transferToHuman (pausa imediata), sql-executor (gate), Security Layer
(90% boa; tirar resíduos `security.layer.ts:101,125`), mecânica do classifier (regenerar prompt
data-driven, rotear por ID), debounce → Redis, catálogo → `Product` local.

**Refazer (conteúdo do negócio):** `SYSTEM_TEMPLATE` inteiro, `classifier.prompt.ts`, tools de
negócio Bravy (product-pitch/bonus/members-access/client-ops), catalog-sync, evals, seed, agentes.

**Decidir/cortar:** RAG (recomendo **cortar no v1** e reintroduzir com volume real — tira a única
dependência OpenAI de raciocínio), PromptComposer vs PromptBuilder (**consolidar em UM** — motivo
dos evals inúteis), modo COPILOT (implementar de verdade — ver plano), org-chart matricial de
agentes (`parentAgentId/department/squad` — metadado nunca lido: implementar ou remover).

## Plano de reconstrução (ordem de execução)

**Fase 0 — Higiene e segurança** *(pré-requisito, junto com a Onda 2/3 do PLANO-LIMPEZA-DNA)*
1. Corrigir gate SQL + transferToHuman pausar IA na hora.
2. Consolidar num único sistema de prompt (recomendo o composer em camadas); apagar o outro; evals passam a testar o prompt de produção.
3. Remover tudo que é Bravy/Trivapp/client-ops do registry de tools.

**Fase 1 — Conhecimento Exatek em DADOS, não código**
4. Popular `aiBusinessNotes`, `Product` local (UV, DTF, brindes: preço/prazo/condições reais), `systemPrompt`/`operationalContext` dos agentes. Template genérico; conteúdo vem do DB.
5. Ligar o catálogo do runner ao `Product` local (aposentar Trivapp de vez).

**Fase 2 — Classificação e roteamento**
6. Criar os agentes reais da Exatek (orquestrador + workers: orçamento, arte/pré-impressão, pós-venda).
7. Classifier data-driven (intents e agentes do DB, roteamento por ID); calibrar `aiClassifierThreshold`.

**Fase 3 — Religar em modo COPILOT (o pulo do gato)**
8. Implementar COPILOT: IA gera **rascunho**, Juliana aprova/edita/envia. Valor da IA sem risco de falar besteira com cliente. É também a máquina de coletar dados reais de qualidade.
9. Construir evals do negócio Exatek a partir das conversas reais do COPILOT.

**Fase 4 — Autonomia gradual**
10. Debounce/dedup em Redis (pré-requisito multi-réplica) + circuit breaker real (auto-desliga após N falhas).
11. Promover COPILOT → AUTONOMOUS canal por canal, só com evals verdes.

**Fase 5 — Inteligência extra (só com volume)**
12. RAG: criar a migration pgvector, ligar indexer/retrieval; decidir provedor de embeddings.

**Racional:** estancar o dano (F0) → dar o conhecimento certo (F1-2) → religar sem risco via
rascunhos (F3) → endurecer (F4) → memória de longo prazo (F5). A Exatek volta a ter IA cedo
(como assistente da Juliana), e a autonomia só volta quando os dados provarem que ela acerta.
