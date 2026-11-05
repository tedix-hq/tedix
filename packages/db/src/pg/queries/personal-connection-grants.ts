import { eq, sql } from "drizzle-orm";
import {
	ConnectionConsumerGrantsSchema,
	type ConnectionConsumerGrants,
} from "@tedix/api-contract/schemas/connections";
import type { PgQueryClient } from "../client";
import { users } from "../schema/users";

export function personalConnectionGrantsPath(
	organizationId: string,
	providerId: string,
	instanceId?: string,
) {
	return `$.connectionConsumerGrants."${encodeURIComponent(organizationId)}:${encodeURIComponent(providerId)}:${encodeURIComponent(instanceId ?? "")}"`;
}

export async function getPersonalConnectionConsumerGrants(
	db: PgQueryClient,
	userId: string,
	organizationId: string,
	providerId: string,
	instanceId?: string,
): Promise<ConnectionConsumerGrants> {
	const [row] = await db
		.select({
			policy: sql<
				string | null
			>`(${users.metadata} #>> string_to_array(regexp_replace(${personalConnectionGrantsPath(organizationId, providerId, instanceId)}, '^\$\.?', ''), '.')::text[])`,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!row) throw new Error("Connection owner not found");
	return row.policy === null
		? { mode: "all" }
		: ConnectionConsumerGrantsSchema.parse(JSON.parse(row.policy));
}

export async function setPersonalConnectionConsumerGrants(
	db: PgQueryClient,
	userId: string,
	organizationId: string,
	providerId: string,
	policy: ConnectionConsumerGrants,
	instanceId?: string,
) {
	const validated = ConnectionConsumerGrantsSchema.parse(policy);
	const [row] = await db
		.update(users)
		.set({
			metadata: sql`jsonb_set(coalesce(${users.metadata}, '{}'), string_to_array(regexp_replace(${personalConnectionGrantsPath(organizationId, providerId, instanceId)}, '^\$\.?', ''), '.')::text[], ${JSON.stringify(validated)}::jsonb)`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	return row;
}
