import { eq, sql } from "drizzle-orm";
import {
	type FactoryWeightProposal,
	FactoryWeightProposalSchema,
} from "@tedix/api-contract/schemas/os-card-review";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";

/** At most this many factory sources keep a latest proposal per organization. */
const MAX_PROPOSALS = 30;

/** Latest weekly weight proposal per factory source, kept on the organization. */
export async function listFactoryWeightProposals(
	db: DbQueryClient,
	orgId: string,
): Promise<FactoryWeightProposal[]> {
	const [row] = await db
		.select({
			proposals: sql<
				string | null
			>`json_extract(${organizations.metadata}, '$.factoryWeights')`,
		})
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1);
	if (!row?.proposals) return [];
	const raw: unknown =
		typeof row.proposals === "string"
			? JSON.parse(row.proposals)
			: row.proposals;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry) => {
		const parsed = FactoryWeightProposalSchema.safeParse(entry);
		return parsed.success ? [parsed.data] : [];
	});
}

/** Narrow write: only the proposals path changes, never the rest of the metadata. */
export async function saveFactoryWeightProposals(
	db: DbQueryClient,
	orgId: string,
	proposals: readonly FactoryWeightProposal[],
) {
	const parsed = proposals
		.map((proposal) => FactoryWeightProposalSchema.parse(proposal))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, MAX_PROPOSALS);
	await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.factoryWeights', json(${JSON.stringify(parsed)}))`,
		})
		.where(eq(organizations.id, orgId));
}
