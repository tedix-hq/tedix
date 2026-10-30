import { and, desc, eq, gt } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	providerProbeReceipts,
	providerProbeResults,
	machineProviderProbeResults,
	machineProviderProbeAuthorizations,
} from "../schema/provider-probe-receipts";

export async function createMachineProviderProbeAuthorization(
	db: DbQueryClient,
	input: typeof machineProviderProbeAuthorizations.$inferInsert,
) {
	const [row] = await db
		.insert(machineProviderProbeAuthorizations)
		.values(input)
		.returning();
	if (!row) throw new Error("Machine probe authorization was not created");
	return row;
}

export async function consumeMachineProviderProbeAuthorization(
	db: DbQueryClient,
	input: {
		id: string;
		organizationId: string;
		argsDigest: string;
		now: string;
	},
) {
	const [row] = await db
		.delete(machineProviderProbeAuthorizations)
		.where(
			and(
				eq(machineProviderProbeAuthorizations.id, input.id),
				eq(
					machineProviderProbeAuthorizations.organizationId,
					input.organizationId,
				),
				eq(machineProviderProbeAuthorizations.argsDigest, input.argsDigest),
				gt(machineProviderProbeAuthorizations.expiresAt, input.now),
			),
		)
		.returning();
	return row;
}

export async function createProviderProbeReceipt(
	db: DbQueryClient,
	input: typeof providerProbeReceipts.$inferInsert,
) {
	const [row] = await db
		.insert(providerProbeReceipts)
		.values(input)
		.returning();
	if (!row) throw new Error("Provider probe receipt was not created");
	return row;
}

export async function createMachineProviderProbeResult(
	db: DbQueryClient,
	input: typeof machineProviderProbeResults.$inferInsert,
) {
	const [row] = await db
		.insert(machineProviderProbeResults)
		.values(input)
		.returning();
	if (!row) throw new Error("Machine provider probe result was not created");
	return row;
}

export async function listMachineProviderProbeResults(
	db: DbQueryClient,
	input: { organizationId: string; now: string },
) {
	return db
		.select()
		.from(machineProviderProbeResults)
		.where(
			and(
				eq(machineProviderProbeResults.organizationId, input.organizationId),
				gt(machineProviderProbeResults.expiresAt, input.now),
			),
		)
		.orderBy(desc(machineProviderProbeResults.expiresAt))
		.limit(50);
}

export async function consumeMachineProviderProbeResult(
	db: DbQueryClient,
	input: {
		id: string;
		organizationId: string;
		profileId: string;
		profileDigest: string;
		argsDigest: string;
		now: string;
	},
) {
	const [row] = await db
		.delete(machineProviderProbeResults)
		.where(
			and(
				eq(machineProviderProbeResults.id, input.id),
				eq(machineProviderProbeResults.organizationId, input.organizationId),
				eq(machineProviderProbeResults.profileId, input.profileId),
				eq(machineProviderProbeResults.profileDigest, input.profileDigest),
				eq(machineProviderProbeResults.argsDigest, input.argsDigest),
				gt(machineProviderProbeResults.expiresAt, input.now),
			),
		)
		.returning();
	return row;
}

/** Exact org and arguments, expiry and single use are checked atomically. */
export async function consumeProviderProbeReceipt(
	db: DbQueryClient,
	input: {
		id: string;
		organizationId: string;
		argsDigest: string;
		now: string;
	},
) {
	const [row] = await db
		.delete(providerProbeReceipts)
		.where(
			and(
				eq(providerProbeReceipts.id, input.id),
				eq(providerProbeReceipts.organizationId, input.organizationId),
				eq(providerProbeReceipts.argsDigest, input.argsDigest),
				gt(providerProbeReceipts.expiresAt, input.now),
			),
		)
		.returning();
	return row;
}

export async function createProviderProbeResult(
	db: DbQueryClient,
	input: typeof providerProbeResults.$inferInsert,
) {
	const [row] = await db.insert(providerProbeResults).values(input).returning();
	if (!row) throw new Error("Provider probe result was not created");
	return row;
}

export async function consumeProviderProbeResult(
	db: DbQueryClient,
	input: {
		id: string;
		organizationId: string;
		actorUserId: string;
		profileId: string;
		profileDigest: string;
		argsDigest: string;
		now: string;
	},
) {
	const [row] = await db
		.delete(providerProbeResults)
		.where(
			and(
				eq(providerProbeResults.id, input.id),
				eq(providerProbeResults.organizationId, input.organizationId),
				eq(providerProbeResults.actorUserId, input.actorUserId),
				eq(providerProbeResults.profileId, input.profileId),
				eq(providerProbeResults.profileDigest, input.profileDigest),
				eq(providerProbeResults.argsDigest, input.argsDigest),
				gt(providerProbeResults.expiresAt, input.now),
			),
		)
		.returning();
	return row;
}
