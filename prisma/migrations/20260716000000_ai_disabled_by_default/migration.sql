-- IA desligada por padrão em orgs novas. Não altera linhas existentes —
-- o estado da Exatek é gerenciado em runtime (org.aiEnabled via UI/API).
ALTER TABLE "organizations" ALTER COLUMN "ai_enabled" SET DEFAULT false;
