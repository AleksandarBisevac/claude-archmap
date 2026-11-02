import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function customers() {
  return prisma.customer.findMany();
}

export async function oneOrder(id: number) {
  return prisma.order.findUnique({ where: { id } });
}

export async function openOrder(customerId: number) {
  return prisma.order.create({ data: { customerId } });
}

export async function bulkLines(lines: object[]) {
  return prisma.orderLine.createMany({ data: lines });
}

export async function touchCustomer(id: number) {
  return prisma.customer.update({ where: { id }, data: {} });
}

export async function syncCustomer(email: string) {
  return prisma.customer.upsert({ where: { email }, update: {}, create: { email } });
}

export async function cancel(id: number) {
  return prisma.order.delete({ where: { id } });
}

export async function purge() {
  return prisma.orderLine.deleteMany();
}

export async function ghost() {
  return prisma.ghostTable.findMany();
}
