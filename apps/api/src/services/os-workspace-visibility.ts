import {
	getOsWorkspace,
	isOsWorkspaceVisibleTo,
	type OsWorkspaceViewer,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { listOsWorkspaceIdsLinkingSkill } from "@tedix/db/queries/os-workspaces/resources";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";

/**
 * Private workspaces belong to one member. The member sees them as:
 * - themselves on a user token (OS, CLI, and MCP/connect calls forwarded with
 *   the member's own bearer). Acting-user headers are never read here;
 * - their own primary tedi on a trusted MCP→API service binding (Home and
 *   kernel turns): the forwarded acting user counts only when it is the human
 *   that tedi is bound to (its owner or its own identity), never an arbitrary
 *   id. `X-Tedix-Acting-User` is read only in withAuth's service-binding
 *   branch, and public ingress strips the service-binding marker;
 * - one of their own personal tedis.
 * A skill run sees one more thing: while a tedi's skill run is running, that
 * run (on the trusted service binding) sees the private workspaces whose
 * "Runs on a schedule" resource links its skill, and nothing else of the
 * owner's.
 * No organization role, API key or service principal sees them; this follows
 * the owner-only policy of personal resource delegations.
 */
const viewers = new WeakMap<BaseContext, Promise<OsWorkspaceViewer>>();

export function resolveOsWorkspaceViewer(
	context: BaseContext,
): Promise<OsWorkspaceViewer> {
	let viewer = viewers.get(context);
	if (!viewer) {
		viewer = computeViewer(context);
		viewers.set(context, viewer);
	}
	return viewer;
}

async function computeViewer(context: BaseContext): Promise<OsWorkspaceViewer> {
	const viewer = await computeMemberViewer(context);
	const workspaceIds = await linkedRunWorkspaceIds(context);
	return workspaceIds.length ? { ...viewer, workspaceIds } : viewer;
}

/** Workspaces linked to the skill of the caller's own running skill run. */
async function linkedRunWorkspaceIds(context: BaseContext): Promise<string[]> {
	const runId = context.headers?.get("X-Tedix-Skill-Run-Id")?.trim();
	if (
		!runId ||
		context.authType !== "service-binding" ||
		!context.tediId ||
		!context.organizationId
	)
		return [];
	const run = await getSkillRun(
		context.db,
		runId,
		context.organizationId,
		context.env.ENVIRONMENT,
	);
	if (run?.status !== "running" || run.tediId !== context.tediId) return [];
	return listOsWorkspaceIdsLinkingSkill(context.db, {
		organizationId: context.organizationId,
		skillId: run.skillId,
	});
}

async function computeMemberViewer(
	context: BaseContext,
): Promise<OsWorkspaceViewer> {
	if (context.authType === "user") {
		return { userIds: context.user?.sub ? [context.user.sub] : [] };
	}
	if (
		(context.authType !== "service-binding" && context.authType !== "tedi") ||
		!context.tediId ||
		!context.organizationId
	) {
		return { userIds: [] };
	}
	const tedi = await getTediByIdForOrganization(
		context.db,
		context.tediId,
		context.organizationId,
	);
	if (!tedi || tedi.status !== "active") return { userIds: [] };
	const actingUser =
		context.authType === "service-binding" ? context.descopeUserId : undefined;
	if (
		actingUser &&
		(tedi.ownerUserId === actingUser || tedi.descopeUserId === actingUser)
	) {
		return { userIds: [actingUser] };
	}
	if (actingUser) return { userIds: [] };
	if (tedi.scope === "personal" && tedi.ownerUserId) {
		return { userIds: [tedi.ownerUserId] };
	}
	return { userIds: [] };
}

/** The member the caller acts for, when it is exactly one human. */
export async function resolveOsWorkspaceOwnerCandidate(
	context: BaseContext,
): Promise<string | null> {
	const { userIds } = await resolveOsWorkspaceViewer(context);
	return userIds.length === 1 ? (userIds[0] ?? null) : null;
}

/** Throw NOT_FOUND (never FORBIDDEN: existence is private too). */
export async function assertOsWorkspaceVisible(
	context: BaseContext,
	workspace: Pick<OsWorkspaceRow, "id" | "visibility" | "ownerUserId">,
	message = "OS workspace not found",
): Promise<void> {
	if (workspace.visibility !== "private") return;
	if (
		!isOsWorkspaceVisibleTo(workspace, await resolveOsWorkspaceViewer(context))
	)
		throw createError(ErrorCodes.NOT_FOUND, message);
}

/** Visibility of a workspace child (output, gadget) by its workspace id. */
export async function assertOsWorkspaceChildVisible(
	context: BaseContext,
	organizationId: string,
	workspaceId: string | null,
	message: string,
): Promise<void> {
	if (!workspaceId) return;
	const workspace = await getOsWorkspace(context.db, {
		organizationId,
		workspaceId,
	});
	if (workspace) await assertOsWorkspaceVisible(context, workspace, message);
}
