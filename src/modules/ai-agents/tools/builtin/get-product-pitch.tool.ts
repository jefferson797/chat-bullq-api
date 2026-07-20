import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Returns the full pitch + price + payment link for a product owned by
 * the org. Agents see a compact list of all products in their system
 * prompt and call this skill with a slug when actually recommending —
 * keeps the prompt small while letting the agent pull authoritative
 * copy on demand instead of inventing.
 *
 * Source of truth: catálogo LOCAL (tabela `products`, gerida em
 * Configurações → Produtos). Escopado por organizationId — multi-tenant
 * por construção.
 */
@Injectable()
export class GetProductPitchTool implements AiTool {
  private readonly logger = new Logger(GetProductPitchTool.name);

  // Nome neutro a propósito — a LLM tem tendência a "ecoar" o nome da
  // tool nas mensagens ao cliente. Nomes como `getProductPitch` faziam
  // ela soltar "vou te mandar o pitch" / "tem no catálogo". Renomeado
  // pra `lookupOffering` (e a description não usa pitch/catálogo/pack)
  // pra ela falar como gente.
  readonly name = 'lookupOffering';
  readonly description =
    'Busca os detalhes oficiais (preço, condições, link de pagamento, principais entregas) do que pode resolver pro cliente. SEMPRE use isto ANTES de citar valor, prazo ou link — nunca invente. Slug vem da lista de soluções no system prompt.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['slug'],
    properties: {
      slug: {
        type: 'string',
        description:
          'Identificador da solução (ex: "impressao-uv"). Lista disponível na seção "Soluções que oferecemos" do system prompt.',
        minLength: 1,
        maxLength: 80,
      },
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const slug = String(input.slug ?? '')
      .trim()
      .toLowerCase();
    if (!slug) {
      return { output: { ok: false, error: 'slug obrigatório' } };
    }

    const product = await this.prisma.product.findFirst({
      where: { organizationId: ctx.organizationId, slug, isActive: true },
      select: {
        slug: true,
        name: true,
        category: true,
        shortLine: true,
        pitch: true,
        price: true,
        paymentLink: true,
        targetAudience: true,
        differentiators: true,
      },
    });

    if (!product) {
      return {
        output: {
          ok: false,
          error: `Solução "${slug}" não encontrada. Confira os slugs na seção "Soluções que oferecemos" do system prompt.`,
        },
      };
    }

    this.logger.log(
      `lookupOffering served ${slug} (org=${ctx.organizationId})`,
    );
    return { output: { ok: true, product } };
  }
}
