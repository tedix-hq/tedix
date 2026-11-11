import {
	WORKSPACE_ROOM_OUTPUT_REVISION_PATH,
	workspaceRoomName,
	type WorkspaceOutputRevisionNotice,
} from "@tedix/api-contract/utils/workspace-room";
import { getOrganizationProfile } from "@tedix/db/queries/organizations";
import type { DbQueryClient } from "@tedix/db/query-client";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";

/**
 * Tell everyone who has a workspace open that one of its files has a new
 * revision. The notice goes to the workspace's live room, the connection each
 * open tab already holds for presence, and carries only the file and revision
 * ids: a tab that shows the file then fetches what changed, under its own
 * access check.
 *
 * Best effort by design. The revision is already stored when this runs, so a
 * notice that cannot be delivered never fails or delays a save for long; a tab
 * that missed one catches up when its connection returns or on its next save.
 */

/** An organization's slug rarely changes; one read per isolate is enough. */
const slugs = new Map<string, string>();
const NOTICE_TIMEOUT_MS = 1_500;

export async function notifyOutputRevision(
	deps: {
		db: DbQueryClient;
		rooms: DurableObjectNamespace | undefined;
		env: unknown;
		/** Local development serves every organization under one "local" host. */
		development?: boolean;
	},
	output: { organizationId: string; workspaceId: string | null },
	notice: WorkspaceOutputRevisionNotice,
): Promise<void> {
	// A file outside a workspace has no room: nobody edits it live.
	if (!deps.rooms || !output.workspaceId) return;
	try {
		let slug = slugs.get(output.organizationId);
		if (!slug) {
			slug =
				(await getOrganizationProfile(deps.db, output.organizationId))?.slug ??
				undefined;
			if (!slug) return;
			slugs.set(output.organizationId, slug);
		}
		const body = JSON.stringify(notice);
		await Promise.all(
			[slug, ...(deps.development && slug !== "local" ? ["local"] : [])].map(
				(tenantSlug) =>
					durableObjectStubByName(
						deps.rooms!,
						deps.env,
						workspaceRoomName({
							tenantSlug,
							workspaceId: output.workspaceId!,
						}),
					).fetch(
						new Request(
							`https://room.internal${WORKSPACE_ROOM_OUTPUT_REVISION_PATH}`,
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body,
								signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
							},
						),
					),
			),
		);
	} catch (error) {
		console.warn({
			component: "os-output-revision-notice",
			event: "notice.failed",
			outcome: "skipped",
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** Tests start from an empty slug cache. */
export function resetOutputRevisionNoticeCache(): void {
	slugs.clear();
}
