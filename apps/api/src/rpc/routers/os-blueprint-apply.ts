import { implement, ORPCError } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import { BlueprintApplyReceiptSchema } from "@tedix/api-contract/schemas/blueprint-provisioning";
import { parseStoredOsBlueprintDefinition } from "@tedix/api-contract/schemas/os-workspaces";
import {
	validateSkillSchedulePolicy,
	nextSkillScheduleFireAt,
} from "@tedix/api-contract/utils/skill-schedule";
import { getOsBlueprintRevision } from "@tedix/db/queries/os-workspaces/blueprints";
import { getBlueprintApplyReceipt } from "@tedix/db/queries/os-workspaces/provisioning";
import { instantiateOsBlueprint } from "@tedix/db/queries/os-workspaces/instantiate";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { getSkillSchedule } from "@tedix/db/queries/skill-schedules";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	AUTHZ,
	type BaseContext,
	withAuth,
	withAuthorization,
	createError,
	ErrorCodes,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import { requireBlueprint, resolveCreator } from "./os-workspaces-shared";
import {
	planBlueprintApply,
	buildBlueprintApplyRows,
	type BlueprintApplyPlan,
} from "../../services/blueprint-provisioning";
import { canonicalJson } from "../../lib/blueprint-digest";
import { resolveOsBlueprintPreflight } from "../../services/os-blueprint-preflight";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { WORKSPACE_SKILL_RESOURCE } from "@tedix/api-contract/schemas/os-workspace-schedules";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const authed = os.use(withAuth).use(osAudit(OS_WORKSPACES_AUDIT));

/** Schedule creation uses the same manifest policy and executable/lifecycle gates as skill scheduling. */
async function scheduleBindings(
	context: BaseContext,
	organizationId: string,
	plan: BlueprintApplyPlan,
) {
	const result = [];
	const seen = new Set<string>();
	for (const definition of plan.definition.provisioning?.schedules ?? []) {
		if (!definition.skillId) continue;
		if (seen.has(definition.skillId))
			throw new Error("A skill may have only one schedule");
		seen.add(definition.skillId);
		const skill = await getSkillEntry(
			context.db,
			definition.skillId,
			organizationId,
		);
		if (
			!skill ||
			skill.lifecycleState !== "active" ||
			!skill.tediId ||
			!skill.files?.["scripts/workflow.ts"]
		)
			throw new Error(
				`Schedule ${definition.key} requires an active executable skill owned by this organization`,
			);
		if (
			!(await getTediByIdForOrganization(
				context.db,
				skill.tediId,
				organizationId,
			))
		)
			throw new Error("Scheduled skill owner is unavailable");
		const { schedule, issues } = validateSkillSchedulePolicy(
			skill.content ?? "",
		);
		if (
			!schedule ||
			issues.length ||
			schedule.cron !== definition.cron ||
			schedule.enabled !== definition.enabled ||
			canonicalJson(schedule.params) !== canonicalJson(definition.params)
		)
			throw new Error(
				`Schedule ${definition.key} must match its governed skill manifest`,
			);
		const existing = await getSkillSchedule(
			context.db,
			skill.id,
			organizationId,
		);
		if (
			existing &&
			(existing.cron !== definition.cron ||
				existing.enabled !== definition.enabled ||
				canonicalJson(existing.params) !== canonicalJson(definition.params))
		)
			throw new Error(
				`Schedule ${definition.key} conflicts with an existing schedule`,
			);
		result.push({ definition, skill, existing });
	}
	return result;
}

async function prepare(
	context: BaseContext,
	input: {
		blueprintId: string;
		instanceKey: string;
		workspaceName: string;
		parameters: Record<string, JsonValue>;
	},
) {
	const blueprint = await requireBlueprint(context, input.blueprintId);
	if (blueprint.status !== "published" || !blueprint.currentRevisionId)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Only a published blueprint can be applied",
		);
	const revision = await getOsBlueprintRevision(
		createDbQueryClient(context.env.DB),
		{
			organizationId: blueprint.organizationId,
			revisionId: blueprint.currentRevisionId,
		},
	);
	if (!revision)
		throw createError(ErrorCodes.NOT_FOUND, "Blueprint revision not found");
	try {
		const plan = await planBlueprintApply({
			...input,
			organizationId: blueprint.organizationId,
			revisionId: revision.id,
			definition: parseStoredOsBlueprintDefinition(revision.definition),
		});
		const bindings = await scheduleBindings(
			context,
			blueprint.organizationId,
			plan,
		);
		const preflight = await resolveOsBlueprintPreflight({
			db: context.db,
			env: context.env,
			organizationId: blueprint.organizationId,
			blueprintId: blueprint.id,
			revisionId: revision.id,
			revision: revision.revision,
			definition: plan.definition,
			tediId: null,
			ownerUserId:
				context.authType === "user" ? (context.user?.sub ?? null) : null,
			resourceBindings: [],
		});
		return { blueprint, revision, plan, bindings, preflight };
	} catch (error) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			error instanceof Error
				? error.message
				: "Invalid blueprint provisioning plan",
		);
	}
}

const previewApply = authed
	.use(AUTHZ.osRead)
	.use(AUTHZ.objectiveRead)
	.blueprints.previewApply.handler(async ({ input, context }) => {
		const { plan, preflight } = await prepare(context, input);
		return { ...plan, preflight };
	});

const apply = authed
	.use(AUTHZ.osPublish)
	.use(AUTHZ.objectiveWrite)
	.use(withAuthorization("tedis:update", "mcp:work.write"))
	.use(withAuthorization("tedis:update", "mcp:skills.write"))
	.blueprints.apply.handler(async ({ input, context }) => {
		const { blueprint, revision, plan, bindings, preflight } = await prepare(
			context,
			input,
		);
		if (
			input.expectedPlanSha256 &&
			input.expectedPlanSha256 !== plan.receipt.planSha256
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"Blueprint plan changed since preview; preview again before applying",
			);
		if (!preflight.instantiateAllowed)
			throw new ORPCError("UNPROCESSABLE_CONTENT", {
				message: "Blueprint dependencies did not resolve",
				data: { preflight },
			});
		const db = createDbQueryClient(context.env.DB);
		async function replay() {
			const stored = await getBlueprintApplyReceipt(
				db,
				blueprint.organizationId,
				plan.receipt.workspaceId,
			);
			if (!stored) return null;
			const receipt = BlueprintApplyReceiptSchema.parse(JSON.parse(stored));
			if (receipt.planSha256 !== plan.receipt.planSha256)
				throw createError(
					ErrorCodes.CONFLICT,
					"Instance key already applied with different parameters or revision; use a new instance key",
				);
			return { receipt: { ...receipt, replayed: true }, preflight };
		}
		const prior = await replay();
		if (prior) return prior;
		const creator = resolveCreator(context),
			now = new Date().toISOString();
		const params = await buildBlueprintApplyRows(plan, {
			organizationId: blueprint.organizationId,
			blueprintId: blueprint.id,
			revision: revision.revision,
			workspaceName: input.workspaceName,
			createdByKind: creator.kind,
			createdById: creator.id,
			now,
			preflight: JSON.stringify(preflight),
		});
		for (const { definition, skill, existing } of bindings) {
			const id = plan.receipt.resources.find(
				(row) => row.kind === "schedule" && row.key === definition.key,
			)!.id;
			if (!existing)
				params.provisioning!.schedules.push({
					id,
					organizationId: blueprint.organizationId,
					skillId: skill.id,
					tediId: skill.tediId!,
					cron: definition.cron,
					params: definition.params,
					enabled: definition.enabled,
					nextFireAt: nextSkillScheduleFireAt(definition.cron, now),
					createdAt: now,
					updatedAt: now,
				});
			const resource = params.resources!.find((row) => row.id === id)!;
			resource.providerId = WORKSPACE_SKILL_RESOURCE.providerId;
			resource.resourceType = WORKSPACE_SKILL_RESOURCE.resourceType;
		}
		try {
			await instantiateOsBlueprint(db, params);
		} catch (error) {
			// A concurrent identical apply can win the unique workspace/receipt race.
			const raced = await replay();
			if (raced) return raced;
			if (error instanceof Error && /unique constraint/i.test(error.message))
				throw createError(
					ErrorCodes.CONFLICT,
					"Workspace name or scheduled skill is already in use; nothing was written",
				);
			throw error;
		}
		return { receipt: plan.receipt, preflight };
	});

export const osBlueprintApplyProcedures = { previewApply, apply };
