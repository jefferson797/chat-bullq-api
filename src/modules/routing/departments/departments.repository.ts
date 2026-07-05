import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class DepartmentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.DepartmentCreateInput) {
    return this.prisma.department.create({ data });
  }

  async findByOrg(organizationId: string) {
    return this.prisma.department.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { agents: true, conversations: true } } },
    });
  }

  async findById(id: string) {
    return this.prisma.department.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async update(id: string, data: Prisma.DepartmentUpdateInput) {
    return this.prisma.department.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    return this.prisma.department.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async addAgent(departmentId: string, userOrganizationId: string) {
    return this.prisma.departmentAgent.create({
      data: {
        departmentId,
        userOrganizationId,
        isActive: true,
      },
    });
  }

  async removeAgent(departmentId: string, userOrganizationId: string) {
    return this.prisma.departmentAgent.deleteMany({
      where: { departmentId, userOrganizationId },
    });
  }

  async findAgents(departmentId: string) {
    return this.prisma.departmentAgent.findMany({
      where: { departmentId },
      include: {
        userOrganization: {
          include: {
            user: { select: { id: true, name: true, email: true, avatarUrl: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
  }

  async findDepartmentAgentByUser(
    departmentId: string,
    organizationId: string,
    userId: string,
  ) {
    return this.prisma.departmentAgent.findFirst({
      where: {
        departmentId,
        userOrganization: { userId, organizationId },
      },
    });
  }

  async clearDefaultForOrg(organizationId: string, exceptDepartmentId?: string) {
    return this.prisma.department.updateMany({
      where: {
        organizationId,
        deletedAt: null,
        isDefault: true,
        ...(exceptDepartmentId ? { id: { not: exceptDepartmentId } } : {}),
      },
      data: { isDefault: false },
    });
  }

  async findMembership(userId: string, organizationId: string) {
    return this.prisma.userOrganization.findUnique({
      where: {
        userId_organizationId: { userId, organizationId },
      },
    });
  }
}
