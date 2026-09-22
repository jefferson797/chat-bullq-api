import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './node-executor.interface';

/** Normaliza pra comparar: minúsculo, sem acento, sem pontuação. */
function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_INVALID = 2;

/**
 * Menu numerado. Aceita o número, o texto exato da opção, ou qualquer
 * palavra-chave da opção (`options[].keywords`, comparação sem acento).
 * Depois de MAX_INVALID respostas inválidas segue pela edge `fallback`
 * (normalmente um TRANSFER) — nunca prende o cliente no menu.
 */
@Injectable()
export class MenuNodeExecutor implements NodeExecutor {
  readonly nodeType = 'MENU';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const { title, options, invalidMessage } = ctx.nodeData as {
      title: string;
      options: { label: string; value: string; keywords?: string[] }[];
      invalidMessage?: string;
    };
    const attemptsKey = `menuAttempts:${ctx.session.currentNodeId}`;

    if (!ctx.incomingMessage) {
      const menuText = [
        title || 'Escolha uma opção:',
        '',
        ...options.map((opt, i) => `${i + 1}. ${opt.label}`),
      ].join('\n');

      return {
        nextNodeId: null,
        sendMessages: [{ type: 'TEXT', content: { text: menuText } }],
        waitForInput: true,
        updatedVariables: { [attemptsKey]: 0 },
      };
    }

    const raw = ctx.incomingMessage.trim();
    const input = norm(raw);
    const selectedIndex = parseInt(raw, 10) - 1;
    const selectedByNumber = /^\d+$/.test(raw) ? options[selectedIndex] : undefined;
    const selectedByText = options.find(
      (o) => norm(o.value) === input || norm(o.label) === input,
    );
    const selectedByKeyword = options.find((o) =>
      (o.keywords ?? []).some((k) => {
        const nk = norm(k);
        return nk && input.includes(nk);
      }),
    );
    const selected = selectedByNumber || selectedByText || selectedByKeyword;

    if (!selected) {
      const attempts = (Number(ctx.session.variables[attemptsKey]) || 0) + 1;
      const fallback = ctx.nodeEdges.find((e) => e.condition === 'fallback');
      if (attempts >= MAX_INVALID && fallback) {
        return {
          nextNodeId: fallback.targetNodeId,
          sendMessages: [],
          waitForInput: false,
          updatedVariables: { [attemptsKey]: attempts, lastMenuSelection: 'fallback' },
        };
      }
      return {
        nextNodeId: null,
        sendMessages: [
          {
            type: 'TEXT',
            content: {
              text:
                invalidMessage ||
                `Não entendi 😅 Responde só com o número: ${options.map((o, i) => `${i + 1}`).join(' ou ')}.`,
            },
          },
        ],
        waitForInput: true,
        updatedVariables: { [attemptsKey]: attempts },
      };
    }

    const matchingEdge = ctx.nodeEdges.find((e) => e.condition === selected.value);
    const nextNodeId = matchingEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null;

    return {
      nextNodeId,
      sendMessages: [],
      waitForInput: false,
      updatedVariables: { lastMenuSelection: selected.value, [attemptsKey]: 0 },
    };
  }
}
