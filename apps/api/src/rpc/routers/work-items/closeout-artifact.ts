import type { WorkAttemptSettlement } from "@tedix/api-contract/schemas/work-items";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { getWorkItemEvidence } from "@tedix/db/queries/work-items/evidence";
import type { WorkAttempt, WorkItem } from "@tedix/db/schema/work-items";
import type { BaseContext } from "../../orpc";

type ArtifactSettlement = Extract<
	WorkAttemptSettlement,
	{ mode: "runtime_app_revision" | "skill_revision" }
>;

export async function artifactCloseoutProblem(
	context: BaseContext,
	work: WorkItem,
	attempt: WorkAttempt,
	proof: ArtifactSettlement,
): Promise<string | undefined> {
	const metadata = work.metadata;
	if (metadata?.artifactKind !== proof.mode)
		return "The settlement artifact type does not match the accepted Work.";
	const evidence = await getWorkItemEvidence(context.db, {
		orgId: work.orgId,
		workItemId: work.id,
		evidenceId: proof.evidenceId,
	});
	if (
		evidence?.attemptId !== attempt.id ||
		evidence.kind !== proof.mode ||
		evidence.uri !== proof.evidenceUri
	)
		return "Submit evidence for this artifact on the admitted Attempt before closing Work.";

	if (proof.mode === "skill_revision") {
		if (
			metadata.artifactSkillId !== proof.skillId ||
			metadata.artifactSkillRevision !== proof.skillRevision ||
			proof.evidenceUri !== `skill://runs/${proof.skillRunId}`
		)
			return "The skill run does not match the accepted skill revision.";
		const [run, skill] = await Promise.all([
			getSkillRun(
				context.db,
				proof.skillRunId,
				work.orgId,
				context.env.ENVIRONMENT,
			),
			getSkillEntry(context.db, proof.skillId, work.orgId),
		]);
		if (
			run?.status !== "completed" ||
			run.skillId !== proof.skillId ||
			run.skillRevision !== proof.skillRevision ||
			(run.workItemId && run.workItemId !== work.id) ||
			skill?.lifecycleState !== "active" ||
			skill.tediId !== null
		)
			return "A completed run of the accepted active organization skill revision is required.";
		return;
	}

	const expected = metadata.artifactRuntimeApp;
	if (
		!isRecord(expected) ||
		expected.workspaceId !== proof.workspaceId ||
		expected.gadgetId !== proof.gadgetId ||
		expected.revisionId !== proof.revisionId ||
		expected.revision !== proof.revision ||
		proof.evidenceUri !==
			`tedix://workspaces/${proof.workspaceId}/gadgets/${proof.gadgetId}/revisions/${proof.revisionId}`
	)
		return "The app revision does not match the accepted runtime app.";
	const scope = { organizationId: work.orgId, gadgetId: proof.gadgetId };
	const gadget = await getOsGadget(context.db, scope);
	if (
		gadget?.status !== "active" ||
		gadget.workspaceId !== proof.workspaceId ||
		gadget.currentRevisionId !== proof.revisionId
	)
		return "Install the accepted runtime app revision before closing Work.";
	const { loadAppRuntimeRevision } =
		await import("../../../services/os-app-runtime-code");
	const revision = await loadAppRuntimeRevision(
		context.db,
		scope,
		proof.revisionId,
	);
	if (
		revision.revision !== proof.revision ||
		typeof revision.files["client.js"] !== "string" ||
		typeof revision.files["server.js"] !== "string"
	)
		return "The installed revision must include the accepted client and server code.";
}
