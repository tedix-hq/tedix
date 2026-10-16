/**
 * Where outputs made in a chat with no workspace go.
 *
 * A chat started from /chat is a plain Home conversation. When it is asked for
 * a document, sheet or deck, the output goes to the member's own private
 * workspace (created once as "Chats (private)" when they have none), never to a
 * new workspace per chat. A turn with no single member behind it uses the
 * organization's "General" workspace, also created once and reused.
 */
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	createOsWorkspace,
	getOsWorkspaceByName,
	getPersonalOsWorkspace,
} from "@tedix/db/queries/os-workspaces/workspaces";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";

export const DEFAULT_OS_WORKSPACE_NAME = "General";
const PERSONAL_OS_WORKSPACE_NAME = "Chats (private)";

const DEFAULT_OS_WORKSPACE_DESCRIPTION =
	"Documents, sheets and decks made in chats that have no workspace of their own.";

/** A name unique to this member, for when another member took the plain one. */
function personalNameFallback(ownerUserId: string): string {
	let hash = 0;
	for (const char of ownerUserId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return `${PERSONAL_OS_WORKSPACE_NAME} · ${hash.toString(16).padStart(8, "0")}`;
}

async function createOrReuseByName(
	db: DbQueryClient,
	row: Omit<Parameters<typeof createOsWorkspace>[1], "id" | "name">,
	names: readonly string[],
	isUsable: (existing: OsWorkspaceRow) => boolean,
): Promise<OsWorkspaceRow | null> {
	for (const name of names) {
		const lookup = { organizationId: row.organizationId, name };
		const existing = await getOsWorkspaceByName(db, lookup);
		if (existing) {
			if (isUsable(existing)) return existing;
			continue;
		}
		try {
			return await createOsWorkspace(db, {
				...row,
				id: crypto.randomUUID(),
				name,
			});
		} catch (error) {
			// A concurrent first use created it; names are unique per organization.
			const raced = await getOsWorkspaceByName(db, lookup);
			if (!raced) throw error;
			if (isUsable(raced)) return raced;
		}
	}
	return null;
}

/**
 * The default workspace for a chat output. Null when it cannot be used (for
 * example an operator archived General): the output then stays unassigned.
 */
export async function ensureDefaultOsWorkspace(
	db: DbQueryClient,
	input: {
		organizationId: string;
		/** The member the turn acts for; null when no single member is behind it. */
		ownerUserId: string | null;
		createdByKind: OsWorkspaceRow["createdByKind"];
		createdById: string;
	},
): Promise<OsWorkspaceRow | null> {
	const now = new Date().toISOString();
	const base = {
		organizationId: input.organizationId,
		description: DEFAULT_OS_WORKSPACE_DESCRIPTION,
		status: "active" as const,
		createdByKind: input.createdByKind,
		createdById: input.createdById,
		createdAt: now,
		updatedAt: now,
	};
	const ownerUserId = input.ownerUserId;
	if (ownerUserId) {
		const personal = await getPersonalOsWorkspace(db, {
			organizationId: input.organizationId,
			ownerUserId,
		});
		if (personal) return personal;
		return createOrReuseByName(
			db,
			{ ...base, visibility: "private", ownerUserId },
			[PERSONAL_OS_WORKSPACE_NAME, personalNameFallback(ownerUserId)],
			(existing) =>
				existing.status === "active" &&
				existing.visibility === "private" &&
				existing.ownerUserId === ownerUserId,
		);
	}
	return createOrReuseByName(
		db,
		base,
		[DEFAULT_OS_WORKSPACE_NAME],
		(existing) => existing.status === "active" && existing.visibility === "org",
	);
}

const CREATE_OUTPUT_TOOL_RE = /^os(?:\.|__)create_os_output$/;

/**
 * Place a planned output create from a workspace-less chat in the default
 * workspace. Runs before the approval card is written, so the approved
 * arguments are the executed ones. Anything else is returned unchanged.
 */
export async function placeChatOutputInDefaultWorkspace<
	T extends { toolName: string; args: Record<string, unknown> },
>(
	proposal: T,
	resolveDefault: () => Promise<{ id: string } | null>,
): Promise<T> {
	if (!CREATE_OUTPUT_TOOL_RE.test(proposal.toolName)) return proposal;
	const current = proposal.args.workspaceId;
	if (typeof current === "string" && current.trim()) return proposal;
	// Placement is a convenience: when it fails the output is still made,
	// unassigned, rather than the write being lost.
	const workspace = await resolveDefault().catch((error: unknown) => {
		console.warn({
			component: "os.default_workspace",
			event: "default_workspace_unavailable",
			error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		});
		return null;
	});
	if (!workspace) return proposal;
	return { ...proposal, args: { ...proposal.args, workspaceId: workspace.id } };
}
