import { listPendingFactoryCardRevisions } from "@tedix/db/queries/factory-card-revisions";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { columnIndex, cellText } from "@tedix/api-contract/utils/card-review";
import type { OsOutputRevision } from "@tedix/api-contract/schemas/os-workspaces";
import type { BaseContext } from "../rpc/orpc";
import { requireOrgId } from "../rpc/org-scope";
import { recordObservedLearningInteraction } from "./learning-interaction-recorder";

/** Reconciles durable Home instructions with immutable Output revisions on read. */
export async function factoryCardRevisionRequests(
	context: BaseContext,
	revision: OsOutputRevision,
) {
	const personId = context.user?.sub ?? context.descopeUserId;
	if (!personId || revision.content.kind !== "sheet") return [];
	const requests = await listPendingFactoryCardRevisions(
		context.db,
		requireOrgId(context),
		revision.outputId,
		personId,
	);
	const pending: {
		cardId: string;
		instruction: string;
		sourceRevision: number;
	}[] = [];
	for (const event of requests) {
		const meta = event.metadata;
		if (
			!meta ||
			typeof meta.cardId !== "string" ||
			typeof meta.instruction !== "string" ||
			typeof meta.rowIndex !== "number" ||
			typeof meta.draftColumn !== "string" ||
			typeof meta.sourceRevision !== "number" ||
			typeof meta.before !== "string"
		)
			continue;
		const body = cellText(
			revision.content.rows[meta.rowIndex]?.[
				columnIndex(revision.content.columns, meta.draftColumn)
			],
		);
		if (
			typeof meta.sourceColumn === "string" &&
			cellText(
				revision.content.rows[meta.rowIndex]?.[
					columnIndex(revision.content.columns, meta.sourceColumn)
				],
			) !== meta.sourceText
		)
			continue;
		if (revision.revision > meta.sourceRevision && body !== meta.before) {
			await recordObservedLearningInteraction(context, {
				organizationId: requireOrgId(context),
				clientEventId: `factory-card-rewrite:${event.id}`,
				eventKind: "edited",
				surface: "decision_capture",
				targetType: "output",
				targetId: revision.outputId,
				metadata: {
					schema: "tedix.card-revision-pair.v1",
					cardId: meta.cardId,
					before: meta.before,
					after: body,
					instruction: meta.instruction,
					sourceRevision: meta.sourceRevision,
					revision: revision.revision,
					cause:
						revision.createdByKind === "user" ? "human_edit" : "agent_rewrite",
					requestedBy: event.actorId,
					rewrittenBy: revision.createdById,
				},
			});
		} else if (await rewriteRunActive(context, event.runId))
			pending.push({
				cardId: meta.cardId,
				instruction: meta.instruction,
				sourceRevision: meta.sourceRevision,
			});
	}
	return pending;
}

/** A request stays pending only while the skill run rewriting the card is still going. */
async function rewriteRunActive(context: BaseContext, runId: string | null) {
	if (!runId) return false;
	const run = await getSkillRun(
		context.db,
		runId,
		requireOrgId(context),
		context.env.ENVIRONMENT,
	);
	return run?.status === "queued" || run?.status === "running";
}
