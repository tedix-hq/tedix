import { eq } from "drizzle-orm";
import {
	ConnectionConsumerGrantsSchema,
	type ConnectionConsumerGrants,
} from "@tedix/api-contract/schemas/connections";
import type { DbQueryClient } from "../query-client";
import { users as schemaUsers } from "../schema/users";
import { coreTable } from "../core-store/client";
import { jsonRead, jsonWrite } from "../core-store/dialect";

function personalConnectionGrantsKey(
	organizationId: string,
	providerId: string,
	instanceId?: string,
) {
	return `${encodeURIComponent(organizationId)}:${encodeURIComponent(providerId)}:${encodeURIComponent(instanceId ?? "")}`;
}

export function personalConnectionGrantsPath(
	organizationId: string,
	providerId: string,
	instanceId?: string,
) {
	return `$.connectionConsumerGrants."${personalConnectionGrantsKey(organizationId, providerId, instanceId)}"`;
}

export async function getPersonalConnectionConsumerGrants(
	db: DbQueryClient,
	userId: string,
	organizationId: string,
	providerId: string,
	instanceId?: string,
): Promise<ConnectionConsumerGrants> {
	const users = coreTable(db, schemaUsers);
	const [row] = await db
		.select({
			policy: jsonRead(
				db,
				users.metadata,
				[
					"connectionConsumerGrants",
					personalConnectionGrantsKey(organizationId, providerId, instanceId),
				],
				"json",
			),
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!row) throw new Error("Connection owner not found");
	return row.policy === null
		? { mode: "all" }
		: ConnectionConsumerGrantsSchema.parse(
				typeof row.policy === "string" ? JSON.parse(row.policy) : row.policy,
			);
}

export async function setPersonalConnectionConsumerGrants(
	db: DbQueryClient,
	userId: string,
	organizationId: string,
	providerId: string,
	policy: ConnectionConsumerGrants,
	instanceId?: string,
) {
	const users = coreTable(db, schemaUsers);
	const validated = ConnectionConsumerGrantsSchema.parse(policy);
	const [row] = await db
		.update(users)
		.set({
			metadata: jsonWrite(
				db,
				users.metadata,
				[
					"connectionConsumerGrants",
					personalConnectionGrantsKey(organizationId, providerId, instanceId),
				],
				validated,
			),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	return row;
}
