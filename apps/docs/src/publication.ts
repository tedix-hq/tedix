import { logDocsFailure } from "./log";
import type { activateBuild } from "./registry";
import type { AppBindings } from "./types";

export async function publicationReceipt(
	env: AppBindings,
	activated: Awaited<ReturnType<typeof activateBuild>>,
) {
	let searchProjection: unknown = null;
	if (activated.site.accessMode === "public") {
		try {
			const workflow = await env.DOCS_BUILD_WORKFLOW.create({
				id: `search-${activated.release.id}`,
				params: {
					operation: "index",
					siteId: activated.site.id,
					buildId: activated.release.buildId,
				},
			});
			searchProjection = { status: "queued", workflowId: workflow.id };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logDocsFailure("docs.search_index_queue_failed", error);
			searchProjection = { status: "failed", error: message };
		}
	}
	return { ...activated, searchProjection };
}
