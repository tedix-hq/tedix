function checked(value) {
	if (
		!value ||
		value.ok === false ||
		value.error ||
		value.completionEvidence?.status === "failed"
	)
		throw new Error("Hygiene read or mutation failed");
	return value;
}
function config(payload) {
	const c = payload ?? {};
	if (
		!Array.isArray(c.internalProjectIds) ||
		!Array.isArray(c.rules) ||
		!c.rules.length
	)
		throw new Error("Configure internalProjectIds and rules");
	for (const [key, minimum] of [
		["incidentHours", 24],
		["idleHours", 72],
		["humanHours", 48],
	])
		if (!Number.isFinite(c[key]) || c[key] < minimum)
			throw new Error(`${key} must be at least ${minimum}`);
	for (const rule of c.rules) {
		if (!["ship", "skill", "stub", "home"].includes(rule.kind))
			throw new Error("Unknown hygiene rule");
		new RegExp(rule.pattern, "i");
	}
	return c;
}
function scoped(item, c) {
	return item.projectId
		? c.internalProjectIds.includes(item.projectId)
		: c.includeUnprojected === true;
}
function ruleFor(item, c) {
	return c.rules.find(
		(rule) =>
			(rule.kind !== "home" ||
				(item.metadata?.homeRunId &&
					item.sourceSessionKey?.startsWith("home:"))) &&
			new RegExp(rule.pattern, "i").test(
				rule.kind === "stub"
					? `${item.title}\n${item.description ?? ""}`
					: item.title,
			),
	);
}
function failureAt(item) {
	return Math.max(
		...[item.createdAt, item.updatedAt, item.metadata?.lastFailedAt]
			.filter(Boolean)
			.map((time) => Date.parse(time)),
	);
}
function eligible(detail, attempts, c, now) {
	const item = detail.workItem;
	if (
		!item ||
		!scoped(item, c) ||
		!["accepted", "proposed"].includes(item.disposition)
	)
		return null;
	if (
		!Array.isArray(detail.comments) ||
		!Array.isArray(attempts.data) ||
		attempts.nextCursor !== null
	)
		return null;
	if (
		item.activeAttempt ||
		attempts.data.some((a) =>
			["queued", "running", "waiting", "retrying"].includes(a.runtimeState),
		)
	)
		return null;
	if (
		detail.comments.some(
			(comment) =>
				!["tedi", "external_agent", "system"].includes(comment.authorType) &&
				(!Number.isFinite(Date.parse(comment.createdAt)) ||
					Date.parse(comment.createdAt) >= now - c.humanHours * 3600000),
		)
	)
		return null;
	const rule = ruleFor(item, c);
	const since = failureAt(item);
	if (!rule || !Number.isFinite(since)) return null;
	const idle = ["stub", "home"].includes(rule.kind);
	if (now - since <= (idle ? c.idleHours : c.incidentHours) * 3600000)
		return null;
	if (idle && attempts.data.length) return null;
	return { rule, since };
}
function runId(item) {
	return (
		item.metadata?.lastRunId ??
		item.metadata?.skillRunId ??
		item.provenance?.skillRunId ??
		item.description?.match(/\/activity\/runs\/([a-f\d-]{36})/i)?.[1]
	);
}
async function recovery(api, item, match, c, env) {
	if (match.rule.kind === "stub")
		return {
			reason: `Auto-filed stub idle for more than ${c.idleHours} hours with no Attempt.`,
			evidence: `${c.osOrigin}/work/items/${item.id}`,
		};
	if (match.rule.kind === "home") {
		const id = item.metadata?.homeRunId;
		if (!id || !item.sourceSessionKey?.startsWith("home:")) return null;
		const home = checked(await env.MCP.home.read_home_run({ runId: id }));
		// A question mark alone is never evidence of a failed one-off Home run.
		const status = home.runStatus ?? home.run?.status;
		const route = home.kernelRoute ?? home.run?.metadata?.kernelRoute;
		if (status !== "failed" || route?.routeKind !== "answer_in_home")
			return null;
		return {
			reason: `Failed one-off Home question idle for more than ${c.idleHours} hours with no Attempt.`,
			evidence: `${c.osOrigin}/activity/runs/${id}`,
		};
	}
	if (match.rule.kind === "ship") {
		if (!c.ship) return null;
		const page = checked(
			await env.MCP.github.list_actions_resources({
				method: "list_workflow_runs",
				owner: c.ship.owner,
				repo: c.ship.repo,
				resource_id: c.ship.workflow,
				perPage: 100,
				workflow_runs_filter: { branch: c.ship.branch, status: "completed" },
			}),
		);
		const runs = Array.isArray(page.workflow_runs)
			? page.workflow_runs
			: page.workflow_runs?.workflow_runs;
		if (!Array.isArray(runs)) throw new Error("Malformed Ship history");
		const success = runs.find(
			(r) =>
				r.status === "completed" &&
				r.conclusion === "success" &&
				r.display_title === c.ship.successTitle &&
				Date.parse(r.created_at) > match.since &&
				r.html_url,
		);
		return success
			? {
					reason: "Superseded by a later successful Ship latest main.",
					evidence: success.html_url,
				}
			: null;
	}
	const id = runId(item);
	const skillId =
		item.metadata?.skillId ??
		item.description?.match(/\(skill ([a-f\d-]{36})\)/i)?.[1];
	if (!id && !skillId) return null;
	const sourceHistory = checked(
		await api.list_skill_workflow_history({
			...(skillId ? { skillId } : {}),
			limit: 200,
			reconcile: false,
		}),
	);
	if (!Array.isArray(sourceHistory.runs))
		throw new Error("Malformed skill history");
	const failures = sourceHistory.runs.filter(
		(r) => r.status === "failed" && (id ? r.id === id : r.skillId === skillId),
	);
	const failed = failures.sort(
		(a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt),
	)[0];
	if (!failed?.skillId) return null;
	if (Date.now() - Date.parse(failed.completedAt) <= c.incidentHours * 3600000)
		return null;
	const history = checked(
		await api.list_skill_workflow_history({
			skillId: failed.skillId,
			status: "completed",
			limit: 100,
			reconcile: false,
		}),
	);
	if (!Array.isArray(history.runs)) throw new Error("Malformed skill history");
	const success = history.runs.find(
		(r) =>
			r.skillId === failed.skillId &&
			r.tediId === failed.tediId &&
			r.status === "completed" &&
			!r.hasError &&
			r.outcome !== "blocked" &&
			Date.parse(r.startedAt) >
				Math.max(match.since, Date.parse(failed.completedAt)) &&
			r.completedAt,
	);
	return success
		? {
				reason:
					"Superseded by a later successful run of the same skill and owner.",
				evidence: `${c.osOrigin}/activity/runs/${success.id}`,
			}
		: null;
}
export default {
	async run(event, step, env) {
		const c = config(event.payload);
		if (!/^https:\/\//.test(c.osOrigin)) throw new Error("Configure osOrigin");
		const now = await step.do("observed-at", async () => Date.now());
		const api = env.MCP.tedi;
		const items = [];
		for (const disposition of ["proposed", "accepted"]) {
			let exhausted = false;
			for (let offset = 0; offset < 5000; offset += 100) {
				const page = await step.do(`scan-${disposition}-${offset}`, async () =>
					checked(
						await api.work_items_list({ disposition, limit: 100, offset }),
					),
				);
				if (
					!Array.isArray(page.data) ||
					typeof page.pagination?.hasMore !== "boolean"
				)
					throw new Error("Malformed Work page");
				items.push(
					...page.data.filter((item) => scoped(item, c) && ruleFor(item, c)),
				);
				if (!page.pagination.hasMore) {
					exhausted = true;
					break;
				}
			}
			if (!exhausted) throw new Error("Work scan truncated; no closures");
		}
		const wouldClose = [],
			closed = [],
			preserved = [];
		for (const candidate of items) {
			const result = await step.do(`evaluate-${candidate.id}`, async () => {
				const detail = checked(await api.work_item_get({ id: candidate.id }));
				const attempts = checked(
					await api.list_work_attempts({ id: candidate.id, limit: 100 }),
				);
				const match = eligible(detail, attempts, c, now);
				if (!match) return null;
				const proof = await recovery(api, detail.workItem, match, c, env);
				return proof
					? {
							id: candidate.id,
							version: detail.workItem.version,
							rule: match.rule.kind,
							...proof,
						}
					: null;
			});
			if (!result) {
				preserved.push(candidate.id);
				continue;
			}
			wouldClose.push(result);
			if (c.dryRun !== false) continue;
			const receipt = await step.do(`close-${candidate.id}`, async () => {
				const detail = checked(await api.work_item_get({ id: candidate.id }));
				const attempts = checked(
					await api.list_work_attempts({ id: candidate.id, limit: 100 }),
				);
				if (
					detail.workItem.version !== result.version ||
					!eligible(detail, attempts, c, Date.now())
				)
					return null;
				const reason = `Board hygiene: ${result.reason} Evidence: ${result.evidence}`;
				checked(
					await api.cancel_work_item({
						id: candidate.id,
						reason,
						hygiene: {
							expectedWorkItemVersion: result.version,
							humanQuietHours: c.humanHours,
							noAttempts: ["stub", "home"].includes(result.rule),
						},
					}),
				);
				const readback = checked(await api.work_item_get({ id: candidate.id }));
				if (readback.workItem.disposition !== "cancelled")
					throw new Error("Closure not verified");
				return {
					...result,
					disposition: "cancelled",
					workUrl: `${c.osOrigin}/work/items/${candidate.id}`,
				};
			});
			if (receipt) closed.push(receipt);
		}
		const report = {
			dryRun: c.dryRun !== false,
			observedAt: new Date(now).toISOString(),
			matched: items.length,
			wouldClose,
			closed,
			preserved,
		};
		if (c.dryRun === false && c.healthWorkItemId)
			await step.do("report", async () =>
				checked(
					await api.work_item_comment({
						id: c.healthWorkItemId,
						body: `Board hygiene run ${env.__RUN_CONTEXT__.runId}: ${JSON.stringify(report)}`,
					}),
				),
			);
		return report;
	},
};
