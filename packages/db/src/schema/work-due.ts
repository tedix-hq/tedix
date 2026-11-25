import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const WORK_DUE_KINDS = [
	"approval-expiry",
	"work-approval-redrive",
	"interaction-review-dispatch",
	"delegated-run-deadline-sweep",
	"agent-run-supervision",
	"orphan-run-sweep",
	"work-attempt-lease-sweep",
] as const;
export type WorkDueKind = (typeof WORK_DUE_KINDS)[number];

export const workDue = sqliteTable(
	"work_due",
	{
		orgId: text("org_id").notNull(),
		kind: text("kind", { enum: WORK_DUE_KINDS }).notNull(),
		objectId: text("object_id").notNull(),
		dueAt: text("due_at").notNull(),
		status: text("status", { enum: ["pending"] })
			.notNull()
			.default("pending"),
		leaseUntil: text("lease_until").notNull().default(""),
	},
	(t) => [
		primaryKey({ columns: [t.orgId, t.kind, t.objectId] }),
		index("idx_work_due_status_due").on(t.status, t.dueAt),
	],
);
