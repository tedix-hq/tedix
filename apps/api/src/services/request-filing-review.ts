import type { DbQueryClient } from "@tedix/db/query-client";
import type { AgentSessionRequestOwner } from "@tedix/db/queries/agent-session-requests";
import {
	countUnfiledRequests,
	listRequestFilings,
	emptyAutoCreatedWorkspaces,
	emptyAutoCreatedProjects,
	weeklyFilingDigest,
} from "@tedix/db/queries/request-filings";
import { automaticFilingEnabled } from "./request-filing-settings";
import { AUTO_FILING_THRESHOLD } from "./request-auto-filing";

export async function readFilingReview(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner & { learningOwnerId?: string },
	now: string,
) {
	const [
		history,
		emptyProjects,
		filingDigest,
		emptyWorkspaces,
		enabled,
		pendingFilingCount,
	] = await Promise.all([
		listRequestFilings(db, owner),
		emptyAutoCreatedProjects(db, owner.organizationId, now),
		weeklyFilingDigest(db, owner, now),
		emptyAutoCreatedWorkspaces(db, owner, now),
		automaticFilingEnabled(db, owner),
		countUnfiledRequests(db, owner),
	]);
	const latest = new Map<string, (typeof history)[number]>();
	for (const event of history)
		if (event.targetId && !latest.has(event.targetId))
			latest.set(event.targetId, event);
	const filings = [...latest].map(([id, event]) => {
		const m = event.metadata;
		const confidence = typeof m?.confidence === "number" ? m.confidence : 0;
		const by =
			m?.by === "correction" ? ("correction" as const) : ("auto" as const);
		return {
			id,
			text: String(m?.text ?? ""),
			projectId: typeof m?.projectId === "string" ? m.projectId : null,
			previousProjectId:
				typeof m?.previousProjectId === "string" ? m.previousProjectId : null,
			by,
			confidence,
			reason: String(m?.reason ?? ""),
			at: event.occurredAt,
			review: by === "auto" && confidence < AUTO_FILING_THRESHOLD,
		};
	});
	return {
		automaticFilingEnabled: enabled,
		pendingFilingCount,
		filings,
		emptyAutoCreated: [
			...emptyProjects.map((p) => ({ ...p, kind: "project" as const })),
			...emptyWorkspaces.map((w) => ({ ...w, kind: "workspace" as const })),
		],
		filingDigest,
	};
}
