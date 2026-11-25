import {
	WorkspacePersonMemoryInputSchema,
	type WorkspacePersonMemoryResult,
} from "@tedix/api-contract/schemas/workspace-person-memory";
import { workspaceOnlyOpenableBy } from "@tedix/api-contract/utils/os-collaborator-graph";

import { coreDb } from "@tedix/db/core-store/scope";
import { listPrivateFactsOfTedis } from "@tedix/db/queries/memory-graph/fact-search";
import { loadOsWorkspacePermissionRows } from "@tedix/db/queries/os-collaborators";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { listPersonalTediIdsOwnedBy } from "@tedix/db/queries/tedis";
import { rankByQueryRelevance } from "../rpc/routers/kernel/context-relevance";
import { isMemorySearchFactEligible } from "./memory-search-filter";

/** Personal tedis whose memory is read. */
const PERSONAL_TEDI_LIMIT = 5;
/** Facts read per record returned, so ineligible ones do not empty a page. */
const CANDIDATE_FACTOR = 4;
const DEFAULT_RECORDS = 10;

/**
 * The words a query searches for, split as `rankByQueryRelevance` splits
 * them; a query of only short words is searched as written.
 */
function searchTerms(query: string | undefined): string[] {
	const text = query?.trim().toLowerCase() ?? "";
	if (!text) return [];
	const words = [
		...new Set(text.split(/[^a-z0-9]+/).filter((word) => word.length > 2)),
	].slice(0, 8);
	return words.length > 0 ? words : [text];
}

const refused = (message: string): WorkspacePersonMemoryResult => ({
	status: "refused",
	message,
});

/**
 * The personal memory of the person who sent a workspace chat turn: what
 * their own personal tedis remember privately. Called only by the dedicated
 * WorkerEntrypoint. The store asserts who sent the turn; the membership and
 * the rule that nobody but that person can open the workspace (private,
 * owned by them, no one else added, no open share link) are read live here
 * on every call.
 */
export async function readWorkspacePersonMemory(
	env: CloudflareEnv,
	input: unknown,
): Promise<WorkspacePersonMemoryResult> {
	const parsed = WorkspacePersonMemoryInputSchema.safeParse(input);
	if (!parsed.success)
		return refused(
			"The memory request is invalid: query is optional text, limit at most 20.",
		);
	const request = parsed.data;
	const organizationId = request.organizationId;
	const db = coreDb(env);
	try {
		const workspace = await getOsWorkspace(db, request);
		if (!workspace || workspace.status !== "active")
			return refused("This workspace is unavailable.");
		const permissions = await loadOsWorkspacePermissionRows(db, {
			organizationId,
			workspaceId: workspace.id,
			collaborators: false,
		});
		if (
			!workspaceOnlyOpenableBy({
				userId: request.userId,
				workspace,
				edges: permissions.edges,
				links: permissions.links,
			})
		)
			return refused(
				"Personal memory can be read only in your own private workspace that nobody else can open.",
			);
		const member = await getMemberByUserId(db, organizationId, request.userId);
		if (member?.status !== "active" || !member.userId)
			return refused("An active organization membership is required.");
		const tediIds = await listPersonalTediIdsOwnedBy(
			db,
			organizationId,
			member.userId,
			PERSONAL_TEDI_LIMIT,
		);
		const limit = request.limit ?? DEFAULT_RECORDS;
		const facts = await listPrivateFactsOfTedis(db, {
			organizationId,
			tediIds,
			terms: searchTerms(request.query),
			limit: limit * CANDIDATE_FACTOR,
		});
		const tediIdSet = new Set(tediIds);
		// Only what the person's tedis keep privately: org-wide knowledge is
		// not the person's own memory.
		const candidates = facts.filter(
			(fact) =>
				fact.tediId !== null &&
				tediIdSet.has(fact.tediId) &&
				isMemorySearchFactEligible(fact, {
					orgId: organizationId,
					tediId: fact.tediId,
				}),
		);
		const records = rankByQueryRelevance(
			candidates,
			request.query,
			(fact) => `${fact.content} ${fact.summary ?? ""}`,
		)
			.slice(0, limit)
			.map((fact) => ({
				id: fact.id,
				content: fact.content,
				updatedAt: fact.updatedAt ?? null,
			}));
		return { status: "memory", records };
	} catch {
		return refused("Personal memory could not be read. Try again.");
	}
}
