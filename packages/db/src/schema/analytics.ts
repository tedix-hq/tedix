/**
 * Analytics Schema
 * Widget interaction events (per-app edge analytics live in Analytics Engine).
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { apps } from "./apps";
import { items } from "./items";
import { organizations } from "./organizations";

// ============================================
// Widget Events Table
// Track user interactions within widgets
// ============================================
export const widgetEvents = sqliteTable(
	"widget_events",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		sessionId: text("session_id").notNull(), // AI host session ID

		// Event details
		eventType: text("event_type", {
			enum: [
				"embedded_session_started",
				"item_impression",
				"item_click",
				"external_cta_click",
				"checkout_start",
				"filter",
				"sort",
				"select_item",
				"attention_impression",
				"attention_open",
				"attention_review",
				"attention_still_open",
			],
		}).notNull(),

		// Item context (for impression/click events)
		itemId: text("item_id").references(() => items.id, {
			onDelete: "set null",
		}),
		itemPosition: integer("item_position"),

		// Widget context
		widgetKey: text("widget_key"), // e.g., "search_listings", "storefront"
		displayMode: text("display_mode", {
			enum: ["inline", "fullscreen", "pip", "modal"],
		}),

		// Optional metadata (filter field/value, sort key, etc.)
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		// Timestamps
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_widget_events_org").on(table.organizationId),
		index("idx_widget_events_app").on(table.appId),
		index("idx_widget_events_session").on(table.sessionId),
		index("idx_widget_events_type").on(table.eventType),
		index("idx_widget_events_widget").on(table.widgetKey),
		index("idx_widget_events_created").on(table.createdAt),
		index("idx_widget_events_item").on(table.itemId),
	],
);

export type WidgetEvent = typeof widgetEvents.$inferSelect;
export type NewWidgetEvent = typeof widgetEvents.$inferInsert;

// Widget event type enum
export type WidgetEventType =
	| "embedded_session_started"
	| "item_impression"
	| "item_click"
	| "external_cta_click"
	| "checkout_start"
	| "filter"
	| "sort"
	| "select_item"
	| "attention_impression"
	| "attention_open"
	| "attention_review"
	| "attention_still_open";
export const WIDGET_EVENT_TYPES = [
	"item_impression",
	"item_click",
	"external_cta_click",
	"checkout_start",
	"filter",
	"sort",
	"select_item",
	"attention_impression",
	"attention_open",
	"attention_review",
	"attention_still_open",
] as const;
