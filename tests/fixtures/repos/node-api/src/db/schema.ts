import { relations } from 'drizzle-orm';
import { integer, pgTable, serial, text, varchar } from 'drizzle-orm/pg-core';

const AUDIT_TABLE = 'audit_' + 'log';

export const publishers = pgTable('publishers', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
});

export const editions = pgTable('editions', {
  id: serial('id').primaryKey(),
  isbn: text('isbn').notNull(),
  publisherId: integer('publisher_id')
    .notNull()
    .references(() => publishers.id),
});

export const publishersRelations = relations(publishers, ({ many }) => ({
  editions: many(editions),
}));

export const editionsRelations = relations(editions, ({ one }) => ({
  publisher: one(publishers, { fields: [editions.publisherId], references: [publishers.id] }),
}));

export const auditLog = pgTable(AUDIT_TABLE, {
  id: serial('id').primaryKey(),
});
