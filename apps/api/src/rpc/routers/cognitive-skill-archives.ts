import { createRouterClient } from "@orpc/server";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../orpc";
import { withOrg } from "../org-scope";
import { authedSkills } from "./cognitive-shared";
import { skillsImprove } from "./cognitive-skill-catalog";
import { requireOwnerAdminWorkItemAuthor } from "./work-items/policy-helpers";

async function archive(
	context: BaseContext,
	organizationId: string,
	input: { id: string; acknowledgeUsedBy?: string[] },
) {
	const entry = await getSkillEntry(context.db, input.id, organizationId);
	if (!entry) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
	if (entry.lifecycleState === "archived") return { entry };
	const client = createRouterClient({ improve: skillsImprove }, { context });
	return client.improve({
		...input,
		lifecycleState: "archived",
		revisionReasoning: "Archive skill.",
	});
}

export const skillsArchive = authedSkills.archive
	.use(AUTHZ.tedisWrite)
	.use(withOrg)
	.handler(async ({ context, input }) => {
		await requireOwnerAdminWorkItemAuthor(
			context,
			context.organizationId,
			"Archiving a skill",
		);
		return archive(context, context.organizationId, input);
	});

export const skillsArchiveMany = authedSkills.archiveMany
	.use(AUTHZ.tedisWrite)
	.use(withOrg)
	.handler(async ({ context, input }) => {
		await requireOwnerAdminWorkItemAuthor(
			context,
			context.organizationId,
			"Archiving skills",
		);
		const entries = [];
		for (const skill of input.skills)
			entries.push(
				(await archive(context, context.organizationId, skill)).entry,
			);
		return { entries };
	});

export const skillsRestore = authedSkills.restore
	.use(AUTHZ.tedisWrite)
	.use(withOrg)
	.handler(async ({ context, input }) => {
		await requireOwnerAdminWorkItemAuthor(
			context,
			context.organizationId,
			"Restoring a skill",
		);
		const entry = await getSkillEntry(
			context.db,
			input.id,
			context.organizationId,
		);
		if (!entry) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
		if (entry.lifecycleState !== "archived") return { entry };
		const from = entry.archivedFrom;
		if (
			!from ||
			from.content === undefined ||
			from.paceLayer === undefined ||
			from.revision !== entry.revision
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Archive has no complete unchanged saved state; review this skill through improve_skills",
			);
		}
		const client = createRouterClient({ improve: skillsImprove }, { context });
		return client.improve({
			id: entry.id,
			lifecycleState: from.lifecycleState,
			content: from.content,
			paceLayer: from.paceLayer,
			force: true,
			revisionReasoning:
				"Restore the skill's saved archive state, including its schedule policy.",
		});
	});
