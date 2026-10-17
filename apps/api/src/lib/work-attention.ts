import type { AttentionResult } from "@tedix/api-contract/schemas/work-attention";
import type { readAttentionSources } from "@tedix/db/queries/work-attention";
import type { AgentSessionRequestRow } from "@tedix/db/schema/agent-session-requests";
import type { WorkAgentSessionRow } from "@tedix/db/schema/work-agent-sessions";

type Card = AttentionResult["cards"][number];
export function buildAttention(
	sources: Awaited<ReturnType<typeof readAttentionSources>>,
	sessions: WorkAgentSessionRow[],
	requests: AgentSessionRequestRow[],
	now: Date,
	utcOffsetMinutes = 0,
): AttentionResult {
	const cards: Card[] = [];
	const midnight = new Date(now.getTime() - utcOffsetMinutes * 60_000);
	midnight.setUTCHours(0, 0, 0, 0);
	const today = (at: string | null) =>
		!!at && Date.parse(at) - utcOffsetMinutes * 60_000 >= midnight.getTime();
	const representedSessions = new Set<string>();
	const representedRuns = new Set<string>();
	const representedItems = new Set<string>();
	for (const row of sources.attempts) {
		if (row.outcome && !today(row.finishedAt)) continue;
		if (row.session) representedSessions.add(row.session);
		if (row.runId) representedRuns.add(row.runId);
		if (!row.outcome || row.outcome === "succeeded")
			representedItems.add(row.workItemId);
		const session = sessions.find(
			(s) => `${s.harness}:${s.sessionKey}` === row.session,
		);
		const expired =
			!row.outcome && Date.parse(row.expiresAt ?? "") <= now.getTime();
		const stale =
			row.registeredLane &&
			!row.outcome &&
			now.getTime() >=
				(Date.parse(row.heartbeatAt) + Date.parse(row.expiresAt ?? "")) / 2;
		const needsHuman = requests.some(
			(request) =>
				`${request.harness}:${request.sessionKey}` === row.session &&
				request.projectId === row.projectId &&
				request.status === "waiting_on_user",
		);
		cards.push({
			id: row.id,
			title: row.title,
			projectId: row.projectId,
			who:
				row.name ||
				(row.session?.startsWith("codex:")
					? "Codex"
					: row.session?.startsWith("claude-code:")
						? "Claude"
						: row.who),
			column:
				row.outcome === "succeeded"
					? "done"
					: row.outcome || expired || stale
						? "blocked"
						: needsHuman || session?.state === "needs_you"
							? "waiting"
							: row.state === "waiting"
								? "blocked"
								: "moving",
			startedAt: row.startedAt,
			heartbeatAt: row.heartbeatAt,
			note:
				stale && !expired
					? "Lane stale: heartbeat stopped; Tedix is watching the lease"
					: expired
						? "Attempt lease elapsed; activity is unconfirmed"
						: session?.summary || row.note || row.state,
			href: `/work/items/${row.workItemId}`,
			source: "attempt",
		});
	}
	for (const row of sessions) {
		if (
			representedSessions.has(`${row.harness}:${row.sessionKey}`) ||
			row.state === "ended"
		)
			continue;
		const fresh = now.getTime() - Date.parse(row.lastEventAt) < 5 * 60_000;
		if (!fresh && !today(row.lastEventAt)) continue;
		cards.push({
			id: row.id,
			who: row.harness === "codex" ? "Codex" : "Claude",
			title: row.label,
			projectId: row.projectId,
			column:
				row.state === "needs_you"
					? "waiting"
					: row.state === "done" && today(row.lastEventAt)
						? "done"
						: row.state === "error" || !fresh
							? "blocked"
							: "moving",
			startedAt: row.stateSince,
			heartbeatAt: row.lastEventAt,
			note: row.summary,
			href: row.workItemId ? `/work/items/${row.workItemId}` : "/work/agents",
			source: "session",
		});
	}
	for (const row of sources.skills) {
		if (
			representedRuns.has(row.id) ||
			(row.workItemId && representedItems.has(row.workItemId))
		)
			continue;
		if (
			["completed", "canceled"].includes(row.status) &&
			!today(row.finishedAt)
		)
			continue;
		cards.push({
			id: row.id,
			who: row.who || "tedi",
			title: row.title || "Skill run",
			projectId: row.projectId,
			column:
				row.status === "completed"
					? "done"
					: row.status === "paused"
						? "waiting"
						: ["failed", "canceled"].includes(row.status)
							? "blocked"
							: "moving",
			startedAt: row.startedAt || "",
			heartbeatAt: row.heartbeatAt,
			note: row.note || row.status,
			href: `/work/executions/${row.id}`,
			source: "skill",
		});
	}
	for (const row of sources.runs) {
		if (representedRuns.has(row.id)) continue;
		if (
			["completed", "failed", "canceled"].includes(row.status) &&
			!today(row.updatedAt)
		)
			continue;
		cards.push({
			id: row.id,
			who: row.who || "tedi",
			title: row.title || "Tedi run",
			projectId: null,
			column:
				row.status === "completed"
					? "done"
					: row.status === "requires_approval"
						? "waiting"
						: ["failed", "canceled"].includes(row.status)
							? "blocked"
							: "moving",
			startedAt: row.startedAt,
			heartbeatAt: row.heartbeatAt,
			note: row.note || row.status,
			href: `/work/runs/${row.id}`,
			source: "run",
		});
	}
	for (const row of requests) {
		const reportedDone =
			row.kind === "open_loop" &&
			row.status === "done" &&
			today(row.statusChangedAt);
		if (
			!reportedDone &&
			(!row.laneRunning || row.status === "done" || row.status === "cancelled")
		)
			continue;
		const parent = sources.attempts.find(
			(attempt) =>
				attempt.session === `${row.harness}:${row.sessionKey}` &&
				!attempt.outcome &&
				Date.parse(attempt.expiresAt ?? "") > now.getTime(),
		);
		cards.push({
			id: row.id,
			who: row.harness === "codex" ? "Codex" : "Claude",
			title: row.text,
			projectId: row.projectId ?? parent?.projectId ?? null,
			column: reportedDone ? "done" : "blocked",
			startedAt: row.sourceAt,
			heartbeatAt: null,
			note: reportedDone
				? row.evidence || "Lane reported complete"
				: parent
					? "Reported sublane linked to its host's admitted Attempt; child heartbeat unconfirmed"
					: "Reported lane; no registered Attempt or verified heartbeat",
			href: parent ? `/work/items/${parent.workItemId}` : "/work/needs-you",
			source: "reported_lane",
		});
	}
	for (const row of sources.backlog) {
		if (!representedItems.has(row.id))
			cards.push({
				id: row.id,
				who: "Unassigned",
				title: row.title,
				projectId: row.projectId,
				column: "backlog",
				startedAt: row.createdAt,
				heartbeatAt: null,
				note: "No active Attempt",
				href: `/work/items/${row.id}`,
				source: "backlog",
			});
	}
	const displayed = ["moving", "waiting", "blocked", "done", "backlog"].flatMap(
		(column) => cards.filter((card) => card.column === column).slice(0, 60),
	);
	return {
		cards: displayed.map((card) => ({
			...card,
			who: card.who.slice(0, 120),
			title: card.title.slice(0, 160),
			note: card.note.slice(0, 300),
		})),
		projects: sources.projects,
		truncated:
			sources.truncated ||
			requests.length >= 200 ||
			cards.length > displayed.length,
		unfiled: requests
			.filter(
				(row) => !row.projectId && !["done", "cancelled"].includes(row.status),
			)
			.map((row) => ({
				id: row.id,
				harness: row.harness,
				sessionKey: row.sessionKey,
				repository: row.repository,
				projectId: row.projectId,
				kind: row.kind,
				text: row.text,
				status: row.status,
				evidence: row.evidence,
				sourceAt: row.sourceAt,
				statusChangedAt: row.statusChangedAt,
			})),
	};
}
