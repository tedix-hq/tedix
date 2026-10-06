/**
 * Tedi Email Query Helpers
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type TediEmailAddress,
	type TediEmailAddressKind,
	type TediEmailAddressStatus,
	tediEmailAddresses,
} from "../../schema/tedi-email";
import { normalizeEmailAddress, parseAddressParts } from "./recipients";
import { clampLimit } from "./storage-normalization";

export async function ensurePrimaryTediEmailAddress(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		slug: string;
		domain?: string;
	},
) {
	const address = normalizeEmailAddress(
		`${input.slug}@${input.domain ?? "tedix.tech"}`,
	);
	const existing = await db.query.tediEmailAddresses.findFirst({
		where: { address },
	});
	if (existing) return existing;

	const parts = parseAddressParts(address);
	try {
		const rows = await db
			.insert(tediEmailAddresses)
			.values({
				id: crypto.randomUUID(),
				organizationId: input.organizationId,
				tediId: input.tediId,
				address,
				localPart: parts.localPart,
				domain: parts.domain,
				kind: "primary",
				status: "active",
				routingPolicy: { source: "implicit-slug-address" },
				createdBy: "system",
			})
			.returning();
		return rows[0]!;
	} catch {
		const raced = await db.query.tediEmailAddresses.findFirst({
			where: { address },
		});
		if (raced) return raced;
		throw new Error(`Failed to create tedi email address ${address}`);
	}
}

export async function listTediEmailAddresses(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		status?: TediEmailAddressStatus | "all";
	},
): Promise<TediEmailAddress[]> {
	const conditions: SQL[] = [
		eq(tediEmailAddresses.tediId, input.tediId),
		eq(tediEmailAddresses.organizationId, input.organizationId),
	];
	if (input.status && input.status !== "all") {
		conditions.push(eq(tediEmailAddresses.status, input.status));
	}
	return db
		.select()
		.from(tediEmailAddresses)
		.where(and(...conditions))
		.orderBy(tediEmailAddresses.domain, tediEmailAddresses.localPart);
}

export async function listTediEmailAddressRequests(
	db: DbClient,
	input: {
		organizationId?: string;
		tediId?: string;
		status?: TediEmailAddressStatus | "all";
		domain?: string;
		kind?: TediEmailAddressKind;
		limit?: number;
	},
): Promise<TediEmailAddress[]> {
	const conditions: SQL[] = [];
	if (input.organizationId) {
		conditions.push(
			eq(tediEmailAddresses.organizationId, input.organizationId),
		);
	}
	if (input.tediId) {
		conditions.push(eq(tediEmailAddresses.tediId, input.tediId));
	}
	if (input.status && input.status !== "all") {
		conditions.push(eq(tediEmailAddresses.status, input.status));
	}
	if (input.domain) {
		conditions.push(eq(tediEmailAddresses.domain, input.domain.toLowerCase()));
	}
	if (input.kind) {
		conditions.push(eq(tediEmailAddresses.kind, input.kind));
	}

	const query = db
		.select()
		.from(tediEmailAddresses)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(
			desc(tediEmailAddresses.updatedAt),
			tediEmailAddresses.domain,
			tediEmailAddresses.localPart,
		)
		.limit(clampLimit(input.limit));

	return query;
}

export async function getActiveTediEmailAddressByAddress(
	db: DbClient,
	address: string,
): Promise<TediEmailAddress | null> {
	return (
		(await db.query.tediEmailAddresses.findFirst({
			where: {
				address: normalizeEmailAddress(address),
				status: "active",
			},
		})) ?? null
	);
}

export async function getTediEmailAddressById(
	db: DbClient,
	id: string,
): Promise<TediEmailAddress | null> {
	return (
		(await db.query.tediEmailAddresses.findFirst({
			where: { id },
		})) ?? null
	);
}

export async function createTediEmailAddress(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		address: string;
		kind: TediEmailAddressKind;
		status?: TediEmailAddressStatus;
		routingPolicy?: Record<string, JsonValue> | null;
		createdBy?: string | null;
	},
): Promise<TediEmailAddress> {
	const address = normalizeEmailAddress(input.address);
	const parts = parseAddressParts(address);
	if (!parts.localPart || !parts.domain) {
		throw new Error("Email address must include local part and domain");
	}

	try {
		const rows = await db
			.insert(tediEmailAddresses)
			.values({
				id: crypto.randomUUID(),
				organizationId: input.organizationId,
				tediId: input.tediId,
				address,
				localPart: parts.localPart,
				domain: parts.domain,
				kind: input.kind,
				status: input.status ?? "reserved",
				routingPolicy: input.routingPolicy ?? null,
				createdBy: input.createdBy ?? null,
			})
			.returning();
		return rows[0]!;
	} catch {
		const existing = await db.query.tediEmailAddresses.findFirst({
			where: { address },
		});
		if (
			existing &&
			existing.tediId === input.tediId &&
			existing.organizationId === input.organizationId
		) {
			return existing;
		}
		throw new Error(`Email address is already assigned: ${address}`);
	}
}

export async function updateTediEmailAddressStatus(
	db: DbClient,
	input: {
		id: string;
		tediId: string;
		organizationId: string;
		status: TediEmailAddressStatus;
		routingPolicy?: Record<string, JsonValue> | null;
	},
): Promise<TediEmailAddress | null> {
	const rows = await db
		.update(tediEmailAddresses)
		.set({
			status: input.status,
			...(input.routingPolicy !== undefined
				? { routingPolicy: input.routingPolicy }
				: {}),
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(tediEmailAddresses.id, input.id),
				eq(tediEmailAddresses.tediId, input.tediId),
				eq(tediEmailAddresses.organizationId, input.organizationId),
			),
		)
		.returning();
	return rows[0] ?? null;
}

export async function updateTediEmailAddressProvisioning(
	db: DbClient,
	input: {
		id: string;
		status: TediEmailAddressStatus;
		routingPolicy?: Record<string, JsonValue> | null;
	},
): Promise<TediEmailAddress | null> {
	const rows = await db
		.update(tediEmailAddresses)
		.set({
			status: input.status,
			...(input.routingPolicy !== undefined
				? { routingPolicy: input.routingPolicy }
				: {}),
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(eq(tediEmailAddresses.id, input.id))
		.returning();
	return rows[0] ?? null;
}
