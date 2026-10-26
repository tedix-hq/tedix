import type { FactoryRunContext } from "@tedix/db/queries/factories";
import { recordArtifactOnceForRun } from "./artifact-immutability";
import { getSkillRunArtifactInlineContent } from "./db";

/** First load freezes even an absent binding; resumes never follow mutable pins. */
export async function loadPinnedFactoryContext(
	db: D1Database,
	runId: string,
	resolve: () => Promise<FactoryRunContext | null>,
): Promise<FactoryRunContext | null> {
	const path = "factory/context.json";
	let content = await getSkillRunArtifactInlineContent(db, runId, path);
	if (content === null) {
		await recordArtifactOnceForRun(db, runId, { path, value: await resolve() });
		content = await getSkillRunArtifactInlineContent(db, runId, path);
	}
	if (content === null) throw new Error("FACTORY_CONTEXT_PIN_MISSING");
	return JSON.parse(content) as FactoryRunContext | null;
}
