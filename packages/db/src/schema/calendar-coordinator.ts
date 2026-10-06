import {
	integer,
	sqliteTable,
	text,
	index,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { osWorkspaces } from "./os-workspaces";
/** Canonical bounded config, immutable preview and operation ledger; never credentials or event contents. */
export const calendarCoordinatorConfigurations = sqliteTable(
	"calendar_coordinator_configurations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => osWorkspaces.id, { onDelete: "cascade" }),
		ownerUserId: text("owner_user_id").notNull(),
		revision: integer("revision").notNull(),
		mode: text("mode", { enum: ["preview", "active"] }).notNull(),
		configuration: text("configuration").notNull(),
		ownershipSeed: text("ownership_seed").notNull(),
		leaseId: text("lease_id"),
		leaseUntil: integer("lease_until").notNull().default(0),
		fence: integer("fence").notNull().default(0),
		lastReceipt: text("last_receipt"),
		lastSuccessfulReconcileAt: text("last_successful_reconcile_at"),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		index("calendar_coordinator_workspace_idx").on(
			t.organizationId,
			t.workspaceId,
		),
	],
);
export const calendarCoordinatorPlans = sqliteTable(
	"calendar_coordinator_plans",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		configurationId: text("configuration_id")
			.notNull()
			.references(() => calendarCoordinatorConfigurations.id, {
				onDelete: "cascade",
			}),
		configurationRevision: integer("configuration_revision").notNull(),
		plan: text("plan").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		index("calendar_coordinator_plan_config_idx").on(
			t.organizationId,
			t.configurationId,
		),
	],
);
export const calendarCoordinatorMirrors = sqliteTable(
	"calendar_coordinator_mirrors",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		configurationId: text("configuration_id")
			.notNull()
			.references(() => calendarCoordinatorConfigurations.id, {
				onDelete: "cascade",
			}),
		sourceKey: text("source_key").notNull(),
		destinationKey: text("destination_key").notNull(),
		mirror: text("mirror").notNull(),
	},
	(t) => [
		uniqueIndex("calendar_coordinator_mirror_unique").on(
			t.configurationId,
			t.sourceKey,
			t.destinationKey,
		),
	],
);
export const calendarCoordinatorMutations = sqliteTable(
	"calendar_coordinator_mutations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		configurationId: text("configuration_id")
			.notNull()
			.references(() => calendarCoordinatorConfigurations.id, {
				onDelete: "cascade",
			}),
		planId: text("plan_id").notNull(),
		actionId: text("action_id").notNull(),
		state: text("state", {
			enum: ["intent", "confirmed", "uncertain", "conflict"],
		}).notNull(),
		mutation: text("mutation").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		uniqueIndex("calendar_coordinator_action_unique").on(
			t.configurationId,
			t.actionId,
		),
	],
);
