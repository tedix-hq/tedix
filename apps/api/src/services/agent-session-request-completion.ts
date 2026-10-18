import { updateAgentSessionRequests } from "@tedix/db/queries/agent-session-requests";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { AgentSessionRequestRow } from "@tedix/db/schema/agent-session-requests";

/** Explicit Work links in saved evidence, never a title match or an agent's approval. */
export async function settleRequestsWithCompletedWork(
	db: DbQueryClient,
	scope: {
		organizationId: string;
		userId: string;
		sessionKey: string;
		harness: string;
		now: string;
	},
	rows: AgentSessionRequestRow[],
): Promise<Set<string>> {
	const updates = [];
	for (const row of rows.slice(0, 8)) {
		if (
			row.organizationId !== scope.organizationId ||
			row.userId !== scope.userId ||
			row.kind === "ask" ||
			row.sessionKey !== scope.sessionKey ||
			row.harness !== scope.harness
		)
			continue;
		const ids = [
			...new Set(
				Array.from(
					(row.evidence ?? "").matchAll(
						/(?:work\/items\/|Work-Item:\s*|Work=)([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/gi,
					),
					(m) => m[1]!,
				),
			),
		];
		if (!ids.length || ids.length > 4) continue;
		const items = await Promise.all(
			ids.map((id) => getWorkItemById(db, id, scope.organizationId)),
		);
		if (
			!items.every(
				(item) =>
					item?.disposition === "completed" &&
					(!row.projectId || item.projectId === row.projectId),
			)
		)
			continue;
		updates.push({
			id: row.id,
			status: "done" as const,
			evidence: `${row.evidence}\nVerified completed Work: ${ids.join(", ")}; checked ${scope.now}`,
		});
	}
	if (updates.length)
		await updateAgentSessionRequests(db, { ...scope, updates });
	return new Set(updates.map((update) => update.id));
}
