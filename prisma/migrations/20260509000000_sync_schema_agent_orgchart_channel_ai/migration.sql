-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'AI_TOOL_FAILURE';

-- DropForeignKey
ALTER TABLE "messages" DROP CONSTRAINT "messages_revoked_by_fkey";

-- AlterTable
ALTER TABLE "ai_agents" ADD COLUMN     "department" TEXT,
ADD COLUMN     "operational_context" TEXT,
ADD COLUMN     "operational_context_updated_at" TIMESTAMP(3),
ADD COLUMN     "parent_agent_id" TEXT,
ADD COLUMN     "squad" TEXT;

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "ai_enabled" BOOLEAN;

-- CreateIndex
CREATE INDEX "idx_ai_agent_parent" ON "ai_agents"("parent_agent_id");

-- CreateIndex
CREATE INDEX "idx_ai_agent_org_dept" ON "ai_agents"("organization_id", "department");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_parent_agent_id_fkey" FOREIGN KEY ("parent_agent_id") REFERENCES "ai_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

