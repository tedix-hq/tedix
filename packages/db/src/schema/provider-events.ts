import { sqliteTable, text, index, integer } from "drizzle-orm/sqlite-core";
export const providerEventSubscriptions = sqliteTable(
	"provider_event_subscriptions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		adapter: text("adapter", {
			enum: ["google_calendar", "microsoft_calendar"],
		}).notNull(),
		providerId: text("provider_id").notNull(),
		connectionInstanceId: text("connection_instance_id"),
		calendarId: text("calendar_id").notNull(),
		tediId: text("tedi_id").notNull(),
		skillId: text("skill_id").notNull(),
		skillRevision: integer("skill_revision").notNull(),
		deliveryMode: text("delivery_mode", { enum: ["push", "poll"] }).notNull(),
		status: text("status", {
			enum: ["registering", "active", "error", "disabled"],
		}).notNull(),
		expiresAt: text("expires_at"),
		nextReconcileAt: text("next_reconcile_at").notNull(),
		lastNotificationAt: text("last_notification_at"),
		lastDispatchAt: text("last_dispatch_at"),
		lastError: text("last_error"),
		leaseUntil: text("lease_until"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		index("provider_event_subscriptions_org_idx").on(t.organizationId),
		index("provider_event_subscriptions_due_idx").on(t.nextReconcileAt),
	],
);
// Callback capabilities are one-way hashes, not OAuth credentials.
export const providerEventChannels = sqliteTable(
	"provider_event_channels",
	{
		id: text("id").primaryKey(),
		subscriptionId: text("subscription_id").notNull(),
		organizationId: text("organization_id").notNull(),
		tokenHash: text("token_hash").notNull(),
		providerChannelId: text("provider_channel_id"),
		resourceId: text("resource_id"),
		status: text("status", {
			enum: ["pending", "active", "stopped"],
		}).notNull(),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		index("provider_event_channels_subscription_idx").on(t.subscriptionId),
	],
);
export const providerEventDeliveries = sqliteTable(
	"provider_event_deliveries",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		subscriptionId: text("subscription_id").notNull(),
		status: text("status", {
			enum: ["pending", "sent", "discarded"],
		}).notNull(),
		attempts: integer("attempts").notNull().default(0),
		leaseUntil: text("lease_until"),
		createdAt: text("created_at").notNull(),
		sentAt: text("sent_at"),
	},
	(t) => [
		index("provider_event_deliveries_pending_idx").on(t.status, t.createdAt),
	],
);
export type ProviderEventSubscriptionRow =
	typeof providerEventSubscriptions.$inferSelect;
export type ProviderEventChannelRow = typeof providerEventChannels.$inferSelect;
