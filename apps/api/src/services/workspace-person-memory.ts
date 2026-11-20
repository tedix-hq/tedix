import {
	WorkspacePersonMemoryInputSchema,
	type WorkspacePersonMemoryResult,
} from "@tedix/api-contract/schemas/workspace-person-memory";
import { workspaceOnlyOpenableBy } from "@tedix/api-contract/utils/os-collaborator-graph";
import { createDbClient } from "@tedix/db/client";
import { getTopPlatformFacts } from "@tedix/db/queries/memory-graph/platform-facts";
import { loadOsWorkspacePermissionRows } from "@tedix/db/queries/os-collaborators";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { listPersonalTediIdsOwnedBy } from "@tedix/db/queries/tedis";
import { rankByQueryRelevance } from "../rpc/routers/kernel/context-relevance";
import { isMemorySearchFactEligible } from "./memory-search-filter";

/** Personal tedis whose memory is read, and candidates read per tedi. */
const PERSONAL_TEDI_LIMIT = 5;
const CANDIDATES_PER_TEDI = 50;
const DEFAULT_RECORDS = 10;

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
	const db = createDbClient(env.DB);
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
		const candidates = (
			await Promise.all(
				tediIds.map(async (tediId) =>
					(
						await getTopPlatformFacts(
							db,
							{ organizationId },
							{ tediId, limit: CANDIDATES_PER_TEDI },
						)
					)
						.map((row) => row.fact)
						// Only what the tedi keeps privately: org-wide knowledge is
						// not the person's own memory.
						.filter(
							(fact) =>
								fact.visibility === "private" &&
								fact.tediId === tediId &&
								isMemorySearchFactEligible(fact, {
									orgId: organizationId,
									tediId,
								}),
						),
				),
			)
		).flat();
		const records = rankByQueryRelevance(
			candidates,
			request.query,
			(fact) => fact.content,
		)
			.slice(0, request.limit ?? DEFAULT_RECORDS)
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
