export const COLUMNS = [
	"Project",
	"Goal",
	"Progress",
	"Running",
	"Needs you",
	"Project link",
	"Receipts link",
	"Deck link",
];

export function localClock(now, timeZone) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const get = (key) => parts.find((p) => p.type === key).value;
	return {
		day: `${get("year")}-${get("month")}-${get("day")}`,
		minute: Number(get("hour")) * 60 + Number(get("minute")),
	};
}
function checked(value) {
	if (!value || value.error || value.isError || value.ok === false)
		throw new Error("Today source unavailable");
	return value;
}
async function pages(call, field, stop) {
	const rows = [];
	let cursor;
	for (let i = 0; i < 30; i++) {
		const page = checked(await call(cursor));
		if (!Array.isArray(page[field]))
			throw new Error("Today source page malformed");
		rows.push(...page[field]);
		if (
			stop?.(page[field]) ||
			(!page.hasMore && !page.nextCursor && !page.truncated)
		)
			return rows;
		if (!page.nextCursor) throw new Error("Today source truncated");
		cursor = page.nextCursor;
	}
	throw new Error("Today source exceeds read limit; saved edition preserved");
}
function first(text) {
	const plain = String(text ?? "")
		.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();
	return (
		new Intl.Segmenter("en", { granularity: "sentence" })
			.segment(plain)
			[Symbol.iterator]()
			.next().value?.segment ?? plain
	)
		.trim()
		.slice(0, 500);
}
export function projectRow(project, events, attempts, totals, now, config) {
	const day = localClock(now, config.timeZone).day;
	const today = (at) =>
		at && localClock(new Date(at), config.timeZone).day === day;
	const recent = events.filter((e) => today(e.createdAt));
	const completed = new Set(
		recent
			.filter(
				(e) => e.eventType === "work.completed" || e.eventType === "completed",
			)
			.map((e) => e.workItemId),
	).size;
	const commits = new Set(
		recent.map((e) => e.settlement?.commitSha).filter(Boolean),
	).size;
	const decisions = totals.decisions;
	const live = attempts.filter(
		(r) =>
			!r.attempt.outcome &&
			["queued", "running", "waiting", "retrying"].includes(
				r.attempt.runtimeState,
			) &&
			new Date(r.attempt.expiresAt) > now,
	);
	const needs = totals.needsYou;
	const count = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : null);
	const progress = [
		count(completed, "task finished", "tasks finished"),
		count(commits, "commit recorded", "commits recorded"),
		count(decisions, "decision made", "decisions made"),
		count(totals.documents, "document updated", "documents updated"),
	]
		.filter(Boolean)
		.join(", ");
	const activity = Math.max(
		Date.parse(project.updatedAt ?? project.createdAt),
		...events.map((e) => Date.parse(e.createdAt)),
		...attempts.map((r) =>
			Date.parse(r.attempt.heartbeatAt ?? r.attempt.startedAt),
		),
		Date.parse(totals.lastTouched ?? project.createdAt),
	);
	const running = live.length
		? "Running now: " +
			live
				.slice(0, 4)
				.map(
					(r) =>
						`${first(r.workItem.title)} (${r.attempt.executorType === "tedi" ? (config.executorNames?.[r.attempt.executorId] ?? "Tedi") : r.attempt.metadata?.agentHarness === "claude-code" ? "Claude Code" : "Codex"})`,
				)
				.join("; ") +
			(live.length > 4 ? `; ${live.length - 4} others` : "")
		: "Nothing running now.";
	const base = `/work?view=feed&project=${project.id}&day=${day}#feed-receipts`;
	return {
		activity,
		receipts: (totals.receipts ?? []).map((r) => [
			project.id,
			r.id,
			r.title + " updated.",
			r.source,
			r.at,
		]),
		quiet: !progress && !live.length && !needs,
		row: [
			project.name,
			first(project.objective ?? totals.objective ?? project.description) ||
				"Goal not stated yet.",
			progress ? progress + "." : "No finished work recorded today.",
			running,
			String(needs),
			`/projects/${project.id}`,
			base,
			`/work?view=deck&project=${project.id}`,
		],
	};
}
export function localDayBounds(day, timeZone) {
	const midnight = (date) => {
		const utc = Date.parse(date + "T00:00:00Z");
		let instant = utc;
		for (let i = 0; i < 3; i++) {
			const at = new Date(instant);
			const local = localClock(at, timeZone);
			const shown = Date.parse(local.day + "T00:00:00Z") + local.minute * 60000;
			instant += utc - shown;
		}
		return new Date(instant).toISOString();
	};
	const tomorrow = new Date(Date.parse(day + "T12:00:00Z") + 86400000)
		.toISOString()
		.slice(0, 10);
	return { since: midnight(day), until: midnight(tomorrow) };
}
export default {
	async run(event, step, env) {
		const config = event.payload || {};
		if (!config.outputId || !config.timeZone || !config.personId)
			throw new Error("Configure outputId, timeZone and personId");
		const now = new Date(
			await step.do("clock", async () => new Date().toISOString()),
		);
		const clock = localClock(now, config.timeZone);
		const slots = config.times ?? [
			"06:45",
			"08:45",
			"10:45",
			"12:45",
			"14:45",
			"16:45",
			"18:45",
			"20:45",
		];
		if (
			!config.manual &&
			!slots.some((t) => {
				const [h, m] = t.split(":").map(Number);
				return clock.minute >= h * 60 + m && clock.minute < h * 60 + m + 15;
			})
		)
			return { status: "off_slot" };
		const api = env.MCP.tedix;
		const purpose = checked(
			await step.do("purpose", () => api.get_active_purpose_charter({})),
		);
		const names = await step.do("executor-names", async () => {
			const names = {};
			for (let offset = 0; offset < 1000; offset += 100) {
				const page = checked(await api.list_tedis({ limit: 100, offset }));
				for (const tedi of page.data) names[tedi.id] = tedi.name;
				if (!page.pagination.hasMore) return names;
			}
			throw new Error("Executor names truncated");
		});
		const configured = { ...config, executorNames: names };
		const projects = await step.do("projects", async () => {
			const rows = [];
			for (let offset = 0; offset < 1000; offset += 100) {
				const page = checked(
					await api.list_projects({ status: "active", limit: 100, offset }),
				);
				rows.push(...page.data);
				if (!page.pagination.hasMore) return rows;
			}
			throw new Error("Project list truncated");
		});
		const rows = [];
		for (const project of projects) {
			const data = await step.do("project-" + project.id, async () => {
				const cutoff = now.getTime() - 7 * 86400000;
				const events = await pages(
					(cursor) =>
						api.list_activity({
							projectId: project.id,
							limit: 300,
							...(cursor ? { cursor } : {}),
						}),
					"events",
					(page) =>
						page.length && page.every((e) => Date.parse(e.createdAt) < cutoff),
				);
				const attempts = await pages(
					(cursor) =>
						api.list_attempt_projection({
							projectId: project.id,
							runtimeStates: ["queued", "running", "waiting", "retrying"],
							limit: 100,
							...(cursor ? { cursor } : {}),
						}),
					"data",
				);
				const totals = checked(
					await api.get_today_project_totals({
						id: project.id,
						personId: config.personId,
						...localDayBounds(clock.day, config.timeZone),
						excludeOutputId: config.outputId,
					}),
				);
				return projectRow(project, events, attempts, totals, now, configured);
			});
			if (data.activity >= now.getTime() - 7 * 86400000) rows.push(data);
		}
		rows.sort((a, b) => b.activity - a.activity);
		const quiet = rows.filter((r) => r.quiet).length;
		const content = {
			kind: "document",
			blocks: [
				{ type: "heading", level: 1, text: "Today — " + clock.day },
				{
					type: "paragraph",
					text:
						purpose.charter?.purpose ??
						"No active purpose has been written yet.",
				},
				{
					type: "paragraph",
					text:
						"Updated " +
						new Intl.DateTimeFormat("en-GB", {
							timeZone: config.timeZone,
							day: "numeric",
							month: "long",
							hour: "2-digit",
							minute: "2-digit",
						}).format(now) +
						". Refreshes every two hours during the day.",
				},
				{
					type: "paragraph",
					text: quiet ? `${quiet} project${quiet === 1 ? "" : "s"} quiet` : "",
				},
				{
					type: "table",
					headers: COLUMNS,
					rows: rows.filter((r) => !r.quiet).map((r) => r.row),
				},
				{
					type: "table",
					headers: ["Project", "Receipt", "Summary", "Source", "Time"],
					rows: rows.flatMap((r) => r.receipts),
				},
			],
		};
		return await step.do("save", async () => {
			const current = checked(
				await api.get_os_output({ outputId: config.outputId }),
			);
			checked(
				await api.revise_os_output({
					outputId: config.outputId,
					expectedRevision: current.currentRevision.revision,
					content,
					note: "Today's purpose and project receipts",
				}),
			);
			return {
				status: "updated",
				outputId: config.outputId,
				projects: rows.length,
				quiet,
			};
		});
	},
};
