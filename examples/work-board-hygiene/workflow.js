function unwrap(result) {
	if (result?.ok === false || result?.completionEvidence?.status === "failed")
		throw new Error(result.error ?? "Work tool failed");
	return result?.data && !Array.isArray(result.data) ? result.data : result;
}
function rows(result) {
	const value = unwrap(result);
	return Array.isArray(value) ? value : (value?.data ?? value?.items ?? []);
}
function words(text) {
	return new Set(
		String(text ?? "")
			.toLowerCase()
			.match(/[\p{L}\p{N}]{3,}/gu) ?? [],
	);
}
function similarity(left, right) {
	const intersection = [...left].filter((word) => right.has(word)).length;
	return intersection / Math.max(1, new Set([...left, ...right]).size);
}
function links(text) {
	return new Set(String(text ?? "").match(/https?:\/\/[^\s)]+/g) ?? []);
}

export function consolidationPairs(items, threshold) {
	const pairs = [];
	const titles = items.map((item) => words(item.title));
	const bodies = items.map((item) =>
		words(`${item.title} ${item.description ?? ""}`),
	);
	const sources = items.map((item) => links(item.description));
	for (let i = 0; i < items.length; i++)
		for (let j = i + 1; j < items.length; j++) {
			const a = items[i],
				b = items[j];
			if (a.projectId !== b.projectId) continue;
			const shared = [...sources[i]].filter((link) => sources[j].has(link));
			const titleFit = similarity(titles[i], titles[j]);
			const bodyFit = similarity(bodies[i], bodies[j]);
			if (
				titleFit >= threshold ||
				(shared.length && bodyFit >= threshold / 2)
			) {
				const [keep, source] =
					String(a.description ?? "").length >=
					String(b.description ?? "").length
						? [a, b]
						: [b, a];
				pairs.push({
					keep: keep.id,
					source: source.id,
					reason: `Title fit ${Math.round(titleFit * 100)}%; description fit ${Math.round(bodyFit * 100)}%; ${shared.length} shared links. Preserve both checklists and acceptance criteria before merging.`,
				});
			}
		}
	return pairs;
}

export default {
	async run(event, step, env) {
		const config = event.payload ?? {};
		if (
			!Array.isArray(config.projectIds) ||
			!config.projectIds.length ||
			!Number.isInteger(config.staleDays) ||
			config.staleDays < 1 ||
			!config.outputId ||
			!config.healthWorkItemId
		)
			throw new Error(
				"projectIds, staleDays, outputId and healthWorkItemId are required",
			);
		const at = await step.do("observed-at", async () =>
			new Date().toISOString(),
		);
		const items = [];
		// Large portfolios use one paginated scan rather than two calls per project.
		const selectedProjects = new Set(config.projectIds);
		const scopes = config.projectIds.length > 5 ? [null] : config.projectIds;
		let scanned = 0;
		for (const projectId of scopes)
			for (const disposition of ["proposed", "accepted"]) {
				let exhausted = false;
				for (let page = 0; page < 20; page++) {
					const batch = await step.do(
						`list-${projectId ?? "organization"}-${disposition}-${page}`,
						async () =>
							rows(
								await env.MCP.tedi.work_items_list({
									...(projectId ? { projectId } : {}),
									disposition,
									limit: 100,
									offset: page * 100,
								}),
							),
					);
					scanned += batch.length;
					if (scanned > 1000)
						throw new Error(
							"Board exceeds 1000-item scan limit; use a factory scoped to at most five projects",
						);
					items.push(
						...batch.filter((item) => selectedProjects.has(item.projectId)),
					);
					if (batch.length < 100) {
						exhausted = true;
						break;
					}
				}
				if (!exhausted)
					throw new Error(
						"Board exceeds bounded scan; narrow projectIds before consolidation",
					);
			}
		const proposals = consolidationPairs(
			items,
			config.similarityThreshold ?? 0.75,
		);
		const closed = [];
		const graph = unwrap(
			await step.do("dependency-edges", async () =>
				env.MCP.work.list_relations({ limit: 5000 }),
			),
		);
		if (graph.truncated || !Array.isArray(graph.relations))
			throw new Error("Dependency scan incomplete; consolidation stopped");
		const relations = graph.relations;
		const linked = new Set(
			relations.flatMap((edge) => [edge.fromWorkItemId, edge.toWorkItemId]),
		);
		for (const candidate of items) {
			if (
				config.probe ||
				(config.readOnlyProjectIds ?? []).includes(candidate.projectId) ||
				linked.has(candidate.id) ||
				candidate.id === config.healthWorkItemId ||
				candidate.accountableOwnerId ||
				candidate.description?.trim() ||
				Object.keys(candidate.acceptanceContract ?? {}).some(
					(key) => key !== "version",
				) ||
				!Number.isFinite(
					Date.parse(candidate.updatedAt ?? candidate.createdAt),
				) ||
				Date.parse(candidate.updatedAt ?? candidate.createdAt) >
					Date.parse(at) - config.staleDays * 86400000
			)
				continue;
			await step
				.do(`stale-${candidate.id}`, async () => {
					const detail = unwrap(
						await env.MCP.tedi.work_item_get({ id: candidate.id }),
					);
					const item = detail.workItem;
					const attempts = rows(
						await env.MCP.tedi.list_work_attempts({
							id: candidate.id,
							limit: 1,
						}),
					);
					// A prior Attempt or any evidence/comment means this is not an untouched stub.
					if (
						!item ||
						item.version !== candidate.version ||
						attempts.length ||
						detail.comments?.length ||
						detail.evidence?.length ||
						item.accountableOwnerId ||
						item.description?.trim() ||
						Object.keys(item.acceptanceContract ?? {}).some(
							(key) => key !== "version",
						)
					)
						return false;
					unwrap(
						await env.MCP.tedi.cancel_work_item({
							id: item.id,
							reason: `Daily consolidation: unowned empty stub; no Attempts, comments or evidence; no owner activity for ${config.staleDays} days. History preserved.`,
						}),
					);
					return true;
				})
				.then((didClose) => {
					if (didClose) closed.push(candidate.id);
				});
		}
		const digest = `Daily board consolidation: reviewed ${items.length} open items; closed ${closed.length} untouched stubs (first 25 IDs: ${closed.slice(0, 25).join(", ") || "none"}). ${proposals.length} suggested consolidations: ${
			proposals
				.slice(0, 25)
				.map((pair) => `${pair.source} into ${pair.keep}: ${pair.reason}`)
				.join(" ") || "none"
		} ${proposals.length > 25 ? "Only the first 25 suggestions are shown; the run retains up to 100." : ""} Active work is preserved; suggestions are recorded here without creating decision cards.`;
		if (config.probe)
			return {
				reviewed: items.length,
				proposalCount: proposals.length,
				proposals: proposals.slice(0, 100),
				closed,
				digest,
			};
		await step.do("publish-digest", async () => {
			const current = unwrap(
				await env.MCP.os.get_os_output({ outputId: config.outputId }),
			);
			const revision = current.currentRevision;
			const blocks = revision.content.blocks ?? [];
			const marker = `board-consolidation:${at.slice(0, 10)}`;
			if (!blocks.some((block) => block.text?.includes(marker)))
				unwrap(
					await env.MCP.os.patch_os_document({
						outputId: config.outputId,
						expectedRevision: revision.revision,
						ops: [
							{
								op: "insert",
								index: blocks.length,
								block: { type: "paragraph", text: `${digest} [${marker}]` },
							},
						],
						note: "Daily board consolidation digest",
					}),
				);
			return true;
		});
		await step.do("health-receipt", async () =>
			env.MCP.tedi.work_item_comment({
				id: config.healthWorkItemId,
				body: digest,
			}),
		);
		return {
			reviewed: items.length,
			proposalCount: proposals.length,
			proposals: proposals.slice(0, 100),
			closed,
			outputId: config.outputId,
		};
	},
};
