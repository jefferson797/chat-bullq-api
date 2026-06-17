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
    const updated = await this.repository.update(id, dto);

    // Propaga o rename pros cards do CRM que espelhavam o nome antigo do
    // contato (o título do card é um snapshot na criação). Só toca nos
    // cards cujo título == nome antigo — títulos personalizados ficam intactos.
    if (
      typeof dto.name === 'string' &&
      existing.name &&
      dto.name.trim() &&
      dto.name.trim() !== existing.name
    ) {
      await this.prisma.card
        .updateMany({
          where: { contactId: id, title: existing.name },
          data: { title: dto.name.trim() },
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
