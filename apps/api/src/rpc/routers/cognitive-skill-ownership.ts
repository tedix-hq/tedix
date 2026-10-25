/** Move a skill and its schedule to another tedi (`skills.move_skill_to_tedi`). */

import type {
	SkillMoveCheck,
	SkillMoveToTediResult,
} from "@tedix/api-contract/schemas/cognitive";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { getManagementClient } from "@tedix/auth/client";
import { getAssignedAppRoles } from "@tedix/auth/fga";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { listActiveSkillPersonalResourceDelegations } from "@tedix/db/queries/personal-resource-delegations";
import {
	listInFlightSkillRuns,
	moveSkillToTedi,
} from "@tedix/db/queries/skill-ownership";
import { getSkillSchedule } from "@tedix/db/queries/skill-schedules";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type { App } from "@tedix/db/schema/apps";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import type { Tedi } from "@tedix/db/schema/tedis";
import { invalidateKernelContextCache } from "../../kernel/context-cache";
import {
	appAccessCheck,
	personalResourcesCheck,
	runsInFlightCheck,
	scheduleCheck,
	skillManifestNamespaces,
	skillNamespaceApps,
	skillRunGateway,
	sourceReferencesCheck,
	targetTediCheck,
	tediNamespaceCheck,
} from "../../services/skill-tedi-move";
import { runTediMcpAccessBatchOnTargets } from "../../services/tedi-mcp-access";
import { auditActor } from "../audit-helpers";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../orpc";
import { requireOrgId } from "../org-scope";
import { authedSkills, isLifecycleOverrideAuthority } from "./cognitive-shared";

type MoveActor = { actorId: string; actorType: string };

/**
 * Who may hand a skill to another tedi: a signed-in owner/admin (the route
 * guard), an operator API key, the organization's admin operator tedi, the
 * tedi that owns the skill, or a Home write carried out for an active
 * owner/admin. A move changes which identity runs unattended work, so every
 * other caller is refused.
 */
export async function skillMoveActor(
	context: BaseContext,
	orgId: string,
	skill: Pick<SkillEntry, "id" | "tediId">,
): Promise<MoveActor> {
	const actor = auditActor(context);
	if (isLifecycleOverrideAuthority(context)) return actor;
	// Home runs a write over the service binding for the member who asked
	// (X-Tedix-Acting-User, set only by apps/mcp), usually bound to that
	// member's own tedi; the member's role decides.
	if (context.authType === "service-binding" && context.descopeUserId) {
		const member = await getMemberByUserId(
			context.db,
			orgId,
			context.descopeUserId,
		);
		if (
			member?.status === "active" &&
			(member.role === "owner" || member.role === "admin")
		)
			return { actorId: context.descopeUserId, actorType: "user" };
	}
	if (
		context.tediId &&
		(context.tediScopes?.includes("mcp:settings.admin") ||
			(skill.tediId && context.tediId === skill.tediId))
	)
		return actor;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"SKILL_MOVE_FORBIDDEN: moving a skill to another tedi needs an organization owner or admin, an operator API key, the organization's admin operator tedi, or the tedi that owns the skill",
		{ code: "SKILL_MOVE_FORBIDDEN", skillId: skill.id },
	);
}

async function gatewayAccessCheck(
	context: BaseContext,
	orgId: string,
	gateway: App | null,
	target: Tedi,
	usesTediNamespace: boolean,
): Promise<SkillMoveCheck> {
	if (!gateway)
		return {
			id: "gateway_access",
			status: usesTediNamespace ? "fail" : "pass",
			detail: "The organization has no Code Mode gateway.",
		};
	try {
		const result = await runTediMcpAccessBatchOnTargets({
			db: context.db,
			env: context.env,
			orgId,
			input: {
				tediId: target.id,
				appId: gateway.id,
				dryRun: true,
				includeValid: true,
			},
			apps: [gateway],
			tedis: [target],
			repairInvalid: false,
		});
		const validation = result.items[0]?.validation;
		if (!validation)
			return {
				id: "gateway_access",
				status: usesTediNamespace ? "fail" : "warn",
				detail: `${target.name} has no assignment on ${gateway.slug}.`,
			};
		if (validation.status === "valid")
			return {
				id: "gateway_access",
				status: "pass",
				detail: `${target.name}'s ${validation.role} access to ${gateway.slug} validates.`,
			};
		return {
			id: "gateway_access",
			status: "warn",
			detail: `${target.name}'s access to ${gateway.slug} does not validate: ${validation.reason ?? validation.status}.`,
		};
	} catch (error) {
		return {
			id: "gateway_access",
			status: "warn",
			detail: `Gateway access was not validated (${error instanceof Error ? error.message : String(error)}).`,
		};
	}
}

async function assignedRoles(
	context: BaseContext,
	tedi: Tedi | null,
	appIds: string[],
): Promise<Record<string, string> | null> {
	if (!tedi?.descopeUserId) return {};
	if (!context.env.DESCOPE_MANAGEMENT_KEY) return null;
	return getAssignedAppRoles(
		getManagementClient(context.env),
		tedi.descopeUserId,
		appIds,
	);
}

async function appAccess(
	context: BaseContext,
	skill: SkillEntry,
	namespaces: string[],
	orgApps: App[],
	source: Tedi | null,
	target: Tedi,
): Promise<SkillMoveCheck> {
	const reached = skillNamespaceApps({
		namespaces,
		bindings: skill.mcpAppBindings as Record<string, string> | null,
		orgApps,
	});
	if (reached.length === 0)
		return appAccessCheck({ reached, sourceRoles: {}, targetRoles: {} });
	const appIds = reached.map(({ app }) => app.id);
	try {
		const [sourceRoles, targetRoles] = await Promise.all([
			assignedRoles(context, source, appIds),
			assignedRoles(context, target, appIds),
		]);
		return appAccessCheck({ reached, sourceRoles, targetRoles });
	} catch (error) {
		return appAccessCheck({
			reached,
			sourceRoles: null,
			targetRoles: null,
			unavailable: error instanceof Error ? error.message : String(error),
		});
	}
}

export const skillsMoveToTedi = authedSkills.moveToTedi
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }): Promise<SkillMoveToTediResult> => {
		const orgId = requireOrgId(context);
		const skill = await getSkillEntry(context.db, input.skillId, orgId);
		if (!skill) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
		const target = await getTediByIdForOrganization(
			context.db,
			input.targetTediId,
			orgId,
		);
		if (!target)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Target tedi not found in this organization",
			);
		const actor = await skillMoveActor(context, orgId, skill);
		const source = skill.tediId
			? ((await getTediByIdForOrganization(context.db, skill.tediId, orgId)) ??
				null)
			: null;

		const namespaces = skillManifestNamespaces(skill.content ?? "");
		const [schedule, runs, orgApps, delegations] = await Promise.all([
			getSkillSchedule(context.db, skill.id, orgId),
			listInFlightSkillRuns(context.db, {
				organizationId: orgId,
				skillId: skill.id,
			}),
			getAppsByOrganization(context.db, orgId),
			skill.tediId
				? listActiveSkillPersonalResourceDelegations(context.db, {
						organizationId: orgId,
						tediId: skill.tediId,
						skillId: skill.id,
						now: new Date().toISOString(),
					})
				: Promise.resolve([]),
		]);
		const gateway = skillRunGateway(orgApps);
		const usesTediNamespace = namespaces.includes("tedi");
		const checks: SkillMoveCheck[] = [
			targetTediCheck({ target, ownerTediId: skill.tediId }),
			runsInFlightCheck(runs),
			tediNamespaceCheck({ namespaces, gateway, target }),
			await gatewayAccessCheck(
				context,
				orgId,
				gateway,
				target,
				usesTediNamespace,
			),
			await appAccess(context, skill, namespaces, orgApps, source, target),
			personalResourcesCheck(delegations),
			sourceReferencesCheck({ skill, source, targetName: target.name }),
			scheduleCheck({ schedule: schedule ?? null, ownerTediId: skill.tediId }),
		];
		const blockers = checks
			.filter((check) => check.status === "fail")
			.map((check) => check.detail);
		const rollback = skill.tediId
			? {
					skillId: skill.id,
					targetTediId: skill.tediId,
					dryRun: false as const,
					mode: "transfer" as const,
				}
			: null;
		const base = {
			dryRun: input.dryRun,
			mode: "transfer" as const,
			skill: {
				id: skill.id,
				slug: skill.slug ?? null,
				title: skill.title,
				revision: skill.revision,
				lifecycleState: skill.lifecycleState ?? null,
			},
			from: { tediId: skill.tediId ?? null, name: source?.name ?? null },
			to: { tediId: target.id, name: target.name, slug: target.slug },
			checks,
			blockers,
		};
		if (input.dryRun)
			return {
				...base,
				status: blockers.length ? "blocked" : "ready",
				schedule: { before: schedule ?? null, after: null },
				auditEventId: null,
				rollback: null,
			};
		if (blockers.length)
			throw createError(
				ErrorCodes.CONFLICT,
				`SKILL_MOVE_BLOCKED: nothing changed. ${blockers.join(" ")}`,
				{ code: "SKILL_MOVE_BLOCKED", skillId: skill.id, checks },
			);

		const metadata: Record<string, JsonValue> = {
			mode: "transfer",
			fromTediId: skill.tediId ?? null,
			fromTediSlug: source?.slug ?? null,
			toTediId: target.id,
			toTediSlug: target.slug,
			skillRevision: skill.revision,
			scheduleId: schedule?.id ?? null,
			cron: schedule?.cron ?? null,
			enabled: schedule?.enabled ?? null,
			nextFireAt: schedule?.nextFireAt ?? null,
			warnings: checks
				.filter((check) => check.status === "warn")
				.map((check) => check.detail),
			rollback: rollback,
			...(input.reason ? { reason: input.reason } : {}),
		};
		const moved = await moveSkillToTedi(context.db, {
			organizationId: orgId,
			skillId: skill.id,
			fromTediId: skill.tediId ?? null,
			toTediId: target.id,
			audit: { ...actor, action: "skill.owner_moved", metadata },
		});
		if (!moved.moved)
			throw createError(
				ErrorCodes.CONFLICT,
				"SKILL_MOVE_CONFLICT: the skill's owner changed while it was being moved; nothing changed. Run the dry run again.",
				{ code: "SKILL_MOVE_CONFLICT", skillId: skill.id },
			);
		invalidateKernelContextCache(context, orgId, "skill.owner_moved");
		return {
			...base,
			status: "moved",
			schedule: { before: schedule ?? null, after: moved.schedule },
			auditEventId: moved.auditEventId,
			rollback,
		};
	});
