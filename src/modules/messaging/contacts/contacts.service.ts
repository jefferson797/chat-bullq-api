import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ContactsRepository } from './contacts.repository';
import { UpdateContactDto } from './dto/update-contact.dto';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class ContactsService {
  constructor(
    private readonly repository: ContactsRepository,
    private readonly prisma: PrismaService,
  ) {}

  async findAll(organizationId: string, search: string | undefined, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const { contacts, total } = await this.repository.findByOrg(organizationId, search, skip, limit);
    return {
      contacts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, organizationId: string) {
    const contact = await this.repository.findById(id);
    if (!contact) throw new NotFoundException('Contact not found');
    if (contact.organizationId !== organizationId) throw new ForbiddenException();
    return contact;
  }

  async update(id: string, organizationId: string, dto: UpdateContactDto) {
    const existing = await this.findOne(id, organizationId);

    const data: Record<string, unknown> = { ...dto };
    // Compõe o nome de exibição a partir de nome + sobrenome (quando informados),
    // pra a conversa mostrar o nome formal e o ERP receber o nome completo.
    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const first = (dto.firstName ?? existing.firstName ?? '').trim();
      const last = (dto.lastName ?? existing.lastName ?? '').trim();
      const composed = `${first} ${last}`.trim();
      if (composed) data.name = composed;
    }

    const updated = await this.repository.update(id, data);

    // Propaga o rename pros cards do CRM que espelhavam o nome antigo do
    // contato (o título do card é um snapshot na criação). Só toca nos
    // cards cujo título == nome antigo — títulos personalizados ficam intactos.
    const newName = typeof data.name === 'string' ? data.name.trim() : '';
    if (newName && existing.name && newName !== existing.name) {
      await this.prisma.card
        .updateMany({
          where: { contactId: id, title: existing.name },
          data: { title: newName },
        })
        .catch(() => undefined);
    }

    return updated;
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    return this.repository.softDelete(id);
  }
}
