import { eq } from 'drizzle-orm';
import { db } from './client';
import { editions, publishers } from '../db/schema';

export async function listEditions() {
  return db.select().from(editions);
}

export async function addPublisher(name: string) {
  return db.insert(publishers).values({ name });
}

export async function renamePublisher(id: number, name: string) {
  return db.update(publishers).set({ name }).where(eq(publishers.id, id));
}

export async function dropEdition(id: number) {
  return db.delete(editions).where(eq(editions.id, id));
}

export async function allPublishers() {
  return db.query.publishers.findMany();
}

export async function fromAnywhere(table: AnyPgTable) {
  return db.select().from(table);
}

export async function titles() {
  return db
    .select({ isbn: editions.isbn })
    .from(editions);
}
