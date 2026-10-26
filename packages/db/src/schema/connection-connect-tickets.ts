import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * A staged OAuth connect. The signed-in person stages one ticket before the
 * consent window leaves our origin; only the hash is stored, and the raw
 * ticket lives in that window alone. Completion counts only once the same
 * person redeems the ticket over their own signed-in session, exactly once,
 * before it expires. A consent return without a redeemable ticket never
 * completes a connection, so a handoff URL opened by someone else, or
 * replayed later, lands nothing in anyone's account.
 */
export const connectionConnectTickets = sqliteTable(
	"connection_connect_tickets",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		/** The person who staged the connect; the only one who may redeem it. */
		userId: text("user_id").notNull(),
		providerId: text("provider_id").notNull(),
		scope: text("scope", { enum: ["tenant", "user"] }).notNull(),
		/** The named account slot the connect fills, when it has one. */
		connectionInstanceId: text("connection_instance_id"),
		/** SHA-256 hex of the raw ticket; the raw value is never stored. */
		ticketHash: text("ticket_hash").notNull(),
		status: text("status", { enum: ["staged", "redeemed"] })
			.notNull()
			.default("staged"),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at").notNull(),
		redeemedAt: text("redeemed_at"),
	},
	(table) => [
		uniqueIndex("connection_connect_tickets_hash_idx").on(table.ticketHash),
		index("connection_connect_tickets_user_idx").on(
			table.organizationId,
			table.userId,
		),
	],
);

export type ConnectionConnectTicketRow =
	typeof connectionConnectTickets.$inferSelect;
export type NewConnectionConnectTicketRow =
	typeof connectionConnectTickets.$inferInsert;
