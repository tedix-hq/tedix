import { and, eq, gt } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	connectionConnectTickets,
	type ConnectionConnectTicketRow,
	type NewConnectionConnectTicketRow,
} from "../schema/connection-connect-tickets";

export async function stageConnectionConnectTicket(
	db: DbQueryClient,
	row: NewConnectionConnectTicketRow,
): Promise<ConnectionConnectTicketRow> {
	const rows = await db
		.insert(connectionConnectTickets)
		.values(row)
		.returning();
	return rows[0]!;
}

export async function getConnectionConnectTicketByHash(
	db: DbQueryClient,
	ticketHash: string,
): Promise<ConnectionConnectTicketRow | undefined> {
	const rows = await db
		.select()
		.from(connectionConnectTickets)
		.where(eq(connectionConnectTickets.ticketHash, ticketHash))
		.limit(1);
	return rows[0];
}

/**
 * Redeem exactly once: the update matches only a staged, unexpired ticket of
 * this person in this organization, so two concurrent returns cannot both win.
 */
export async function redeemConnectionConnectTicket(
	db: DbQueryClient,
	params: {
		id: string;
		organizationId: string;
		userId: string;
		now: string;
	},
): Promise<ConnectionConnectTicketRow | undefined> {
	const rows = await db
		.update(connectionConnectTickets)
		.set({ status: "redeemed", redeemedAt: params.now })
		.where(
			and(
				eq(connectionConnectTickets.id, params.id),
				eq(connectionConnectTickets.organizationId, params.organizationId),
				eq(connectionConnectTickets.userId, params.userId),
				eq(connectionConnectTickets.status, "staged"),
				gt(connectionConnectTickets.expiresAt, params.now),
			),
		)
		.returning();
	return rows[0];
}
