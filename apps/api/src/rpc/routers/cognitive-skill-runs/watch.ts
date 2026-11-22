import {
	FLOW_WATCH_LIMITS,
	normalizeFlowWatchInput,
} from "@tedix/api-contract/schemas/flow-watch";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import { ensurePlatformSkill } from "@tedix/db/queries/cognitive/platform-skills";
import { getExternalAgentPrincipal } from "@tedix/db/queries/external-agent-identity/principals";
import { getMemberAccessByUserId } from "@tedix/db/queries/organization-members";
import {
	getSkillRun,
	listOpenSkillRunsForSkill,
} from "@tedix/db/queries/skill-runs";
import { getTediById } from "@tedix/db/queries/tedis";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { recordTediSubmissionStarted } from "../../../kernel/runtime-submission-bridge";
import { resolveKernelFallbackTediId } from "../kernel/write-approval-settlement";
import {
	WATCH_CHECK_TOOL,
	WATCH_OPEN_WINDOW_HOURS,
	WATCH_SKILL_DESCRIPTION,
	WATCH_SKILL_DOC,
	WATCH_SKILL_SLUG,
	WATCH_SKILL_TAGS,
	WATCH_WORKFLOW_SOURCE,
	watchSkillId,
} from "../../../services/flow-watch-skill";
import { callSkillRuntime } from "../../../services/skill-runtime-client";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../../orpc";
import { withOrg } from "../../org-scope";
import { authedSkills } from "../cognitive-shared";
import { skillRunCreatedBy } from "./run-start";
import { requireOwnedTedi, type SkillRuntimeRunResponse } from "./shared";

const ACCESS_REVOKED = "ACCESS_REVOKED";
const SKILL_RUN_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Re-check that whoever started a watch can still read Work in the
 * organization: an active human membership, an active agent principal (and,
 * for an owner-bound agent, its owner's membership), or a live tedi. Runs at
 * start and again on every check, so a revoked starter stops the watch.
 */
async function assertWatchStarterActive(
	context: BaseContext,
	organizationId: string,
	createdBy: string | null,
): Promise<void> {
	const [kind, ...rest] = (createdBy ?? "").split(":");
	const id = rest.join(":");
	const revoked = () =>
		createError(
			ErrorCodes.FORBIDDEN,
			`${ACCESS_REVOKED}: the watch's starter can no longer read Work in this organization`,
		);
	const activeMember = async (userId: string) =>
		(await getMemberAccessByUserId(context.db, organizationId, userId))
			?.status === "active";
	if (!id) throw revoked();
	if (kind === "user") {
		if (!(await activeMember(id))) throw revoked();
		return;
	}
	if (kind === "agent") {
		const principal = await getExternalAgentPrincipal(context.db, {
			organizationId,
			principalId: id,
		});
		if (principal?.status !== "active") throw revoked();
		if (
			principal.credentialBindingType === "owner_user" &&
			!(await activeMember(principal.credentialBindingId))
		)
			throw revoked();
		return;
	}
	if (kind === "tedi") {
		const tedi = await getTediById(context.db, id);
		if (tedi?.organizationId !== organizationId || tedi.retiredAt !== null)
			throw revoked();
		return;
	}
	throw revoked();
}

async function readWatchedWorkItem(
	context: BaseContext,
	organizationId: string,
	workItemId: string,
) {
	const workItem = await getWorkItemById(context.db, workItemId);
	if (!workItem || workItem.orgId !== organizationId)
		throw createError(ErrorCodes.NOT_FOUND, "Work Item not found");
	return workItem;
}

export const skillsStartWorkItemWatch = authedSkills.startWorkItemWatch
	.use(AUTHZ.tedisWrite)
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const orgId = context.organizationId;
		// A tedi surface injects its own id. The organization's admin surface has
		// no tedi, so the run takes the same stable org executor Home uses; the
		// executor grants nothing here, because every check re-verifies the
		// starter and returns only the watched item's status.
		const tediId =
			input.tediId ?? (await resolveKernelFallbackTediId(context, orgId));
		if (!tediId)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"flow.watch needs a tedi in this organization to own the run",
			);
		await requireOwnedTedi(context, tediId, orgId);
		let params;
		try {
			params = normalizeFlowWatchInput(input.watch, new Date());
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				error instanceof Error ? error.message : String(error),
			);
		}
		const createdBy = skillRunCreatedBy(context);
		await assertWatchStarterActive(context, orgId, createdBy);
		await readWatchedWorkItem(context, orgId, params.workItemId);

		const skill = await ensurePlatformSkill(context.db, {
			id: await watchSkillId(orgId),
			organizationId: orgId,
			slug: WATCH_SKILL_SLUG,
			title: "flow.watch",
			description: WATCH_SKILL_DESCRIPTION,
			content: WATCH_SKILL_DOC,
			files: { "scripts/workflow.ts": WATCH_WORKFLOW_SOURCE },
			tags: WATCH_SKILL_TAGS,
		});

		let dispatched: SkillRuntimeRunResponse;
		try {
			dispatched = await callSkillRuntime<SkillRuntimeRunResponse>(
				context,
				"/run",
				{
					createdBy,
					skillId: skill.id,
					skillSlug: skill.slug,
					skillRevision: skill.revision,
					orgId,
					tediId,
					params,
					workflowSource: WATCH_WORKFLOW_SOURCE,
					skillDoc: WATCH_SKILL_DOC,
					capabilityManifest: parseCapabilityManifest(WATCH_SKILL_DOC),
					openRunCap: {
						max: FLOW_WATCH_LIMITS.maxOpenPerOrganization,
						windowHours: WATCH_OPEN_WINDOW_HOURS,
					},
				},
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("open_run_cap_reached")
			)
				throw error;
			// Name only the runs this caller could inspect through the same tedi;
			// the rest of the organization's watches are counted, not listed.
			const open = await listOpenSkillRunsForSkill(context.db, {
				organizationId: orgId,
				skillId: skill.id,
				runtimeEnvironment: context.env.ENVIRONMENT,
				since: new Date(
					Date.now() - WATCH_OPEN_WINDOW_HOURS * 3_600_000,
				).toISOString(),
				limit: FLOW_WATCH_LIMITS.maxOpenPerOrganization,
			});
			const visible = open
				.filter((run) => run.openRunTediId === tediId)
				.map((run) => run.openRunId);
			const hidden = open.length - visible.length;
			throw createError(
				ErrorCodes.TOO_MANY_REQUESTS,
				`WATCH_LIMIT: ${FLOW_WATCH_LIMITS.maxOpenPerOrganization} watches are already open in this organization. Cancel one with flow.cancel({ runId }) and retry. Open on this tedi: ${visible.length ? visible.join(", ") : "none"}${hidden > 0 ? `; ${hidden} more on other tedis are not shown` : ""}.`,
			);
		}

		await recordTediSubmissionStarted(context.db, {
			tediId,
			runId: dispatched.runId,
			organizationId: orgId,
			sourceKind: "skill_workflow",
		});
		return {
			runId: dispatched.runId,
			status: dispatched.status ?? "queued",
			workItemId: params.workItemId,
			everySeconds: params.everySeconds,
			maxChecks: params.maxChecks,
			deadlineAt: params.deadlineAt,
		};
	});

/**
 * The single status read a watch may make. Only the watch run itself can call
 * it: the run comes from the trusted workflow header, the Work Item from the
 * run's own params, and the starter's access is re-checked every time.
 */
export const skillsCheckWorkItemWatch = authedSkills.checkWorkItemWatch
	.use(AUTHZ.tedisRead)
	.use(withOrg)
	.handler(async ({ context }) => {
		const orgId = context.organizationId;
		const runId = context.headers.get("X-Tedix-Skill-Run-Id")?.trim();
		if (
			!isServiceBinding(context.headers) ||
			!runId ||
			!SKILL_RUN_ID.test(runId)
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				`${WATCH_CHECK_TOOL} can only be called by a flow.watch run`,
			);
		const run = await getSkillRun(
			context.db,
			runId,
			orgId,
			context.env.ENVIRONMENT,
		);
		if (
			!run ||
			run.skillId !== (await watchSkillId(orgId)) ||
			(context.tediId && run.tediId !== context.tediId)
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				`${WATCH_CHECK_TOOL} can only be called by a flow.watch run`,
			);
		const workItemId = run.params?.workItemId;
		if (typeof workItemId !== "string")
			throw createError(ErrorCodes.BAD_REQUEST, "watch run has no Work Item");
		await assertWatchStarterActive(context, orgId, run.createdBy);
		const workItem = await readWatchedWorkItem(context, orgId, workItemId);
		return {
			workItemId: workItem.id,
			disposition: workItem.disposition,
			updatedAt: workItem.updatedAt ?? null,
		};
	});
