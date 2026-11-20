/**
 * Read-only workspace inspection by an organization owner or admin.
 *
 * An inspection never adds a role. It adds the inspected workspace to the
 * caller's viewer (the same seam a running skill uses) for one request, and
 * only when every one of these holds:
 * - a signed-in person names the workspace in the inspection header;
 * - the procedure is one of the reads below, declared GET in its contract;
 * - they recorded an inspection of it within the hour and are still an
 *   active owner or admin (`hasActiveOsWorkspaceInspection`).
 * Every other procedure, including every write, judges the caller as if no
 * inspection existed. The workspace chat socket has its own read-only check in
 * the workspace object (`apps/workspace-do/src/session-access.ts`).
 */
import { OS_WORKSPACE_INSPECTION_HEADER } from "@tedix/api-contract/schemas/os-workspace-inspections";
import { hasActiveOsWorkspaceInspection } from "@tedix/db/queries/os-workspace-inspections";
import type { BaseContext } from "../rpc/context";

/**
 * The reads an inspection opens. Each one only reads the workspace: its
 * details, files (derived files still need the caller's own access to their
 * sources), app list, activity, inspection history, and the presence read
 * the chat socket is admitted by. App runtimes, connected-account reads and
 * collaboration rooms are deliberately absent.
 */
const INSPECTION_READS: ReadonlySet<string> = new Set([
	"osWorkspaces.workspaces.get",
	"osWorkspaces.workspaces.activity",
	"osWorkspaces.outputs.list",
	"osWorkspaces.outputs.get",
	"osWorkspaces.gadgets.list",
	"osWorkspaces.inspections.history",
	"osCollaborators.presence",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace this request may read as an inspector, or null. */
export async function inspectedWorkspaceId(
	context: BaseContext,
): Promise<string | null> {
	const workspaceId = context.headers
		?.get(OS_WORKSPACE_INSPECTION_HEADER)
		?.trim();
	const userId = context.user?.sub;
	if (
		!workspaceId ||
		!UUID.test(workspaceId) ||
		context.authType !== "user" ||
		!userId ||
		!context.organizationId ||
		context.dbReadOnly !== true ||
		!context.procedurePath ||
		!INSPECTION_READS.has(context.procedurePath)
	)
		return null;
	return (await hasActiveOsWorkspaceInspection(
		context.db,
		{ organizationId: context.organizationId, workspaceId },
		userId,
	))
		? workspaceId
		: null;
}
