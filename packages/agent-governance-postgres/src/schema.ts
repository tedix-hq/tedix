import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	unique,
} from "drizzle-orm/pg-core";
import type {
	CallDescription,
	CallOutcome,
	ChangeRecordInput,
	ComplianceDecision,
	MemoryRevision,
} from "@tedix/agent-governance/types";

export const memoryEntries = pgTable(
	"memory_entries",
	{
		scope: text().notNull(),
		key: text().notNull(),
		revision: integer().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.scope, t.key] }),
		check("memory_entry_revision_positive", sql`${t.revision} > 0`),
	],
);
export const memoryRevisions = pgTable(
	"memory_revisions",
	{
		scope: text().notNull(),
		revisionId: text("revision_id").notNull(),
		key: text().notNull(),
		revision: integer().notNull(),
		body: jsonb().$type<MemoryRevision>().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.scope, t.revisionId] }),
		unique().on(t.scope, t.key, t.revision),
		check("memory_revision_positive", sql`${t.revision} > 0`),
		foreignKey({
			columns: [t.scope, t.key],
			foreignColumns: [memoryEntries.scope, memoryEntries.key],
		}),
	],
);
export const changeRecords = pgTable(
	"change_records",
	{
		scope: text().notNull(),
		id: text().notNull(),
		sequence: bigint({ mode: "number" }).notNull(),
		recordedAt: text("recorded_at").notNull(),
		resource: text().notNull(),
		actorId: text("actor_id").notNull(),
		body: jsonb().$type<ChangeRecordInput>().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.scope, t.sequence] }),
		unique().on(t.scope, t.id),
		index().on(t.scope, t.resource, t.sequence),
		index().on(t.scope, t.actorId, t.sequence),
	],
);
export const complianceDecisions = pgTable("compliance_decisions", {
	scope: text().notNull(),
	id: text().primaryKey(),
	recordedAt: text("recorded_at").notNull(),
	call: jsonb()
		.$type<Omit<CallDescription, "args"> & { argsHash: string }>()
		.notNull(),
	decision: jsonb().$type<ComplianceDecision>().notNull(),
	outcome: jsonb().$type<CallOutcome>().notNull(),
});
export const complianceRateWindows = pgTable(
	"compliance_rate_windows",
	{
		scope: text().notNull(),
		key: text().notNull(),
		calls: bigint({ mode: "number" }).array().notNull(),
	},
	(t) => [primaryKey({ columns: [t.scope, t.key] })],
);

export const changeRecordHeads = pgTable("change_record_heads", {
	scope: text().primaryKey(),
	sequence: bigint({ mode: "number" }).notNull(),
});
