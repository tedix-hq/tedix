import { getD1BindingKey } from "../../slow-query";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { policyPacks } from "../../schema/control-plane";

/** Read an ownerless platform publication; tenant-owned and revoked heads grant nothing. */
export async function getActiveSystemPolicyDefinition(
	db: DbQueryClient,
	slug: string,
) {
	return (await getActiveSystemPolicy(db, slug))?.definition ?? null;
}

type PolicyRow = Pick<
	typeof policyPacks.$inferSelect,
	| "slug"
	| "version"
	| "target"
	| "status"
	| "publishedAt"
	| "publishedBy"
	| "definition"
>;
const snapshots = new WeakMap<
	object,
	{ expiresAt: number; rows: Promise<PolicyRow[]> }
>();

/** Ownerless system heads share a 60-second snapshot, including revocations and drafts. */
export async function getActiveSystemPolicy(db: DbQueryClient, slug: string) {
	const key = getD1BindingKey(db.$client);
	let snapshot = snapshots.get(key);
	if (!snapshot || snapshot.expiresAt <= Date.now()) {
		snapshot = {
			expiresAt: Date.now() + 60_000,
			rows: db
				.select({
					slug: policyPacks.slug,
					version: policyPacks.version,
					target: policyPacks.target,
					status: policyPacks.status,
					publishedAt: policyPacks.publishedAt,
					publishedBy: policyPacks.publishedBy,
					definition: policyPacks.definition,
				})
				.from(policyPacks)
				.where(
					and(
						eq(policyPacks.scope, "system"),
						isNull(policyPacks.organizationId),
					),
				)
				.orderBy(desc(policyPacks.version))
				.then((rows) => rows),
		};
		snapshots.set(key, snapshot);
	}
	let allRows;
	try {
		allRows = await snapshot.rows;
	} catch (error) {
		if (snapshots.get(key) === snapshot) snapshots.delete(key);
		throw error;
	}
	const rows = allRows.filter((row) => row.slug === slug).slice(0, 2);
	const head = rows[0];
	if (
		!head ||
		rows[1]?.version === head.version ||
		head.target !== "shared" ||
		head.status !== "active" ||
		!head.publishedAt ||
		!Number.isFinite(Date.parse(head.publishedAt)) ||
		!head.publishedBy?.trim()
	)
		return null;
	return { version: head.version, definition: head.definition };
}
