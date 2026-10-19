import { ATTENTION_COPY } from "@tedix/api-contract/utils/attention-copy";
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
	for (const row of sources.waiting ?? []) {
		if (row.creatorSession) representedSessions.add(row.creatorSession);
		cards.push({
			id: row.id,
			title: row.subject,
			projectId:
				row.projectId ??
				sources.attempts.find((a) => a.workItemId === row.workItemId)
					?.projectId ??
				null,
			who: ATTENTION_COPY.waiting,
			column: "waiting",
			startedAt: row.createdAt,
			heartbeatAt: null,
			note: row.prompt,
			href: `/work/interactions/${row.id}`,
			source: "interaction",
			activitySource: row.creatorSession?.startsWith("devin:")
				? "local_devin"
				: row.creatorSession?.startsWith("codex:")
					? "local_codex"
					: row.creatorSession?.startsWith("claude-code:")
						? "local_claude"
						: "unknown",
		});
		if (row.workItemId) representedItems.add(row.workItemId);
	}
	for (const row of sources.attempts) {
		if ((sources.waiting ?? []).some((r) => r.workItemId === row.workItemId)) {
			if (row.session) representedSessions.add(row.session);
			if (row.runId) representedRuns.add(row.runId);
			continue;
		}
		if (row.outcome && !today(row.finishedAt)) continue;
		if (row.session) representedSessions.add(row.session);
		if (row.runId) representedRuns.add(row.runId);
		if (!row.outcome || row.outcome === "succeeded")
			representedItems.add(row.workItemId);
		const session = sessions.find(
			(s) => `${s.harness}:${s.sessionKey}` === row.session,
		);
		const skill = sources.skills.find((s) => s.id === row.runId);
		const run = sources.runs.find((r) => r.id === row.runId);
		const worker = skill?.who || run?.who || row.name;
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
				worker ||
				(row.session?.startsWith("devin:")
					? ATTENTION_COPY.local_devin
					: row.session?.startsWith("codex:")
						? ATTENTION_COPY.local_codex
						: row.session?.startsWith("claude-code:")
							? ATTENTION_COPY.local_claude
							: ATTENTION_COPY.unknownSource),
			column:
				row.outcome === "succeeded"
					? "done"
					: row.outcome || expired || stale
						? "blocked"
						: needsHuman || session?.state === "needs_you"
							? "waiting"
							: row.state === "waiting"
								? "blocked"
								: row.state === "queued"
									? "backlog"
									: "moving",
			startedAt: row.startedAt,
			heartbeatAt: row.heartbeatAt,
			note:
				stale && !expired
					? ATTENTION_COPY.heartbeatOverdue
					: expired
						? ATTENTION_COPY.leaseElapsed
						: session?.summary || row.note || row.state,
			href: `/work/items/${row.workItemId}`,
			source: "attempt",
			factoryName: skill?.title,
			activitySource: skill
				? skill.createdBy === "schedule"
					? "coordinator"
					: "factory"
				: run
					? "cloud_tedi"
					: row.session?.startsWith("devin:")
						? "local_devin"
						: row.session?.startsWith("codex:")
							? "local_codex"
							: row.session?.startsWith("claude-code:")
								? "local_claude"
								: row.who === "tedi"
									? "cloud_tedi"
									: "unknown",
			tediName: worker,
			finishedAt: row.finishedAt,
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
			who:
				row.harness === "devin"
					? ATTENTION_COPY.local_devin
					: row.harness === "codex"
						? ATTENTION_COPY.local_codex
						: ATTENTION_COPY.local_claude,
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
			href: row.workItemId
				? `/work/items/${row.workItemId}`
				: row.projectId
					? `/work/projects/${row.projectId}`
					: "/work/portfolio",
			source: "session",
			activitySource:
				row.harness === "devin"
					? "local_devin"
					: row.harness === "codex"
						? "local_codex"
						: "local_claude",
			finishedAt: row.state === "done" ? row.lastEventAt : null,
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
			who: row.who || ATTENTION_COPY.cloud_tedi,
			title: row.title || ATTENTION_COPY.skillRun,
			projectId: row.projectId,
			column:
				row.status === "completed"
					? "done"
					: ["paused", "failed", "canceled"].includes(row.status)
						? "blocked"
						: row.status === "queued"
							? "backlog"
							: "moving",
			startedAt: row.startedAt || "",
			heartbeatAt: row.heartbeatAt,
			note: row.note || row.status,
			href: `/work/executions/${row.id}`,
			source: "skill",
			activitySource: row.createdBy === "schedule" ? "coordinator" : "factory",
			tediName: row.who,
			factoryName: row.title,
			finishedAt: row.finishedAt,
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
			who: row.who || ATTENTION_COPY.cloud_tedi,
			title: row.title || ATTENTION_COPY.tediRun,
			projectId: null,
			column:
				row.status === "completed"
					? "done"
					: row.status === "requires_approval"
						? "waiting"
						: ["failed", "canceled"].includes(row.status)
							? "blocked"
							: row.status === "queued"
								? "backlog"
								: "moving",
			startedAt: row.startedAt,
			heartbeatAt: row.heartbeatAt,
			note: row.note || row.status,
			href: `/work/runs/${row.id}`,
			source: "run",
			workspaceId: row.workspaceId,
			activitySource: "cloud_tedi",
			tediName: row.who,
			finishedAt: ["completed", "failed", "canceled"].includes(row.status)
				? row.updatedAt
				: null,
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
			who:
				row.harness === "devin"
					? ATTENTION_COPY.local_devin
					: row.harness === "codex"
						? ATTENTION_COPY.local_codex
						: ATTENTION_COPY.local_claude,
			title: row.text,
			projectId: row.projectId ?? parent?.projectId ?? null,
			column: reportedDone ? "done" : "blocked",
			startedAt: row.sourceAt,
			heartbeatAt: null,
			note: reportedDone
				? row.evidence || ATTENTION_COPY.reportedComplete
				: parent
					? ATTENTION_COPY.childUnconfirmed
					: ATTENTION_COPY.laneUnconfirmed,
			href: parent ? `/work/items/${parent.workItemId}` : "/work/needs-you",
			source: "reported_lane",
			activitySource:
				row.harness === "devin"
					? "local_devin"
					: row.harness === "codex"
						? "local_codex"
						: "local_claude",
			finishedAt: reportedDone ? row.statusChangedAt : null,
		});
	}
	for (const row of sources.backlog) {
		const observer = row.observer === 1 && row.deadline;
		const overdue = observer && Date.parse(row.deadline!) <= now.getTime();
		if (!representedItems.has(row.id))
			cards.push({
				id: row.id,
				who: observer ? "Ship observer" : ATTENTION_COPY.unassigned,
				title: row.title,
				projectId: row.projectId,
				column: observer
					? overdue && !row.diagnosis
						? "blocked"
						: "waiting"
					: "backlog",
				startedAt: row.createdAt,
				heartbeatAt: null,
				note: observer
					? row.diagnosis
						? `Diagnosis: ${row.diagnosis}`
						: `${overdue ? "Missed promise" : "Promise"}: no red Ship older than 30 min without a diagnosis; due ${row.deadline}`
					: ATTENTION_COPY.readyToPickUp,
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
		projects: sources.projects.map((project) => {
			const lanes = cards.filter((c) => c.projectId === project.id);
			const lastAttentionAt =
				[project.lastAttentionAt, ...lanes.map((c) => c.heartbeatAt)]
					.filter((at): at is string => !!at)
					.sort()
					.at(-1) ?? null;
			return {
				...project,
				lastAttentionAt,
				active: Math.max(
					project.active,
					lanes.filter((c) => c.column === "moving" || c.column === "waiting")
						.length,
				),
				recent: Math.max(
					project.recent,
					lanes.filter(
						(c) =>
							Date.parse(c.heartbeatAt ?? "") >= now.getTime() - 86_400_000,
					).length,
				),
			};
		}),
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
