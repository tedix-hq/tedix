import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/**
 * Tedix OS auto-approval policies (v1). D1 is canonical.
 *
 * A rule is an explicit, per-organization standing decision: pending tedi
 * approval requests (`tedi_approval_requests`) whose `action_type` matches the
 * rule's `action_kind` are auto-resolved with the rule's decision. Rules never
 * act in the background — an explicit, idempotent apply sweep resolves matching
 * approvals through the SAME canonical resolution path a human resolve uses,
 * and every auto-resolution records the rule id in its resolution note.
 *
 * v1 supports only the `approve` decision; the enum exists so a future
 * `reject` policy is a value, not a schema migration.
 */

const createdByKinds = ["user", "tedi", "external_agent", "service"] as const;

export const OS_APPROVAL_RULE_DECISION_VALUES = ["approve"] as const;
export type OsApprovalRuleDecision =
	(typeof OS_APPROVAL_RULE_DECISION_VALUES)[number];

export const osApprovalRules = sqliteTable(
	"os_approval_rules",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		/** Matches `tedi_approval_requests.action_type` exactly. */
		actionKind: text("action_kind").notNull(),
		decision: text("decision", { enum: OS_APPROVAL_RULE_DECISION_VALUES })
			.notNull()
			.default("approve"),
		/** Disabled rules stay listable for audit; the sweep ignores them. */
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		/** When the rule was last disabled (ISO 8601); null while enabled. */
		disabledAt: text("disabled_at"),
	},
	(table) => [
		index("os_approval_rules_org_kind_idx").on(
			table.organizationId,
			table.actionKind,
		),
	],
);

export type OsApprovalRuleRow = typeof osApprovalRules.$inferSelect;
export type NewOsApprovalRuleRow = typeof osApprovalRules.$inferInsert;
