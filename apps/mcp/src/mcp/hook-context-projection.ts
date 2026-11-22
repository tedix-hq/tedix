import type {
	HookContextSources,
	HookTurnContextInput,
} from "@tedix/api-contract/schemas/hook-context";
/** Fixed hook reads dispatched through the caller's existing authorized catalog. */
export type HookContextReader = (
	callable: string,
	input: Record<string, unknown>,
) => Promise<unknown>;

export async function readTurnContext(
	input: HookTurnContextInput,
	source: HookContextReader,
): Promise<Record<string, unknown>> {
	const read = async <K extends keyof HookContextSources>(
		name: K,
		args: Record<string, unknown>,
	): Promise<HookContextSources[K]> =>
		(await source(name, args)) as HookContextSources[K];
	const t = input;
	const { lessons, requests, nextWork } = t;
	const pending: Record<string, Promise<unknown>> = {};
	async function document(workspaceId: string, outputId: string) {
		const [w, r] = await Promise.all([
			read("os.get_os_workspace", { workspaceId: workspaceId }),
			read("os.get_os_output", { outputId: outputId }),
		]);
		const content = r.currentRevision.content;
		if (content.kind !== "document")
			throw new Error("Shared context is not a document");
		const blocks = content.blocks;
		if (
			!Array.isArray(blocks) ||
			blocks.some(
				(b) =>
					!b ||
					typeof b !== "object" ||
					(b.type === "list"
						? !Array.isArray(b.items) ||
							b.items.some((item) => typeof item !== "string")
						: !["heading", "paragraph", "quote", "code"].includes(b.type) ||
							!("text" in b) ||
							typeof b.text !== "string"),
			)
		)
			throw new Error("Malformed shared document blocks");
		const text = blocks
			.flatMap((b) =>
				b.type === "list" ? b.items : "text" in b ? [b.text] : [],
			)
			.join("\n");
		return {
			workspace: {
				id: w.workspace.id,
				organizationId: w.workspace.organizationId,
				status: w.workspace.status,
			},
			output: {
				id: r.output.id,
				workspaceId: r.output.workspaceId,
				organizationId: r.output.organizationId,
				kind: r.output.kind,
				status: r.output.status,
				currentRevisionId: r.output.currentRevisionId,
			},
			revision: {
				id: r.currentRevision.id,
				outputId: r.currentRevision.outputId,
				organizationId: r.currentRevision.organizationId,
				revision: r.currentRevision.revision,
				kind: r.currentRevision.content.kind,
			},
			text: text.slice(0, 3200),
			blocksValid: true,
			complete: text.length <= 3200,
		};
	}
	async function each<T>(
		read: () => Promise<T>,
	): Promise<T | { unavailable: true }> {
		try {
			return await read();
		} catch {
			return { unavailable: true as const };
		}
	}
	if (t.contextOutputId)
		pending.shared = each(() => document(t.osWorkspaceId!, t.contextOutputId!));
	if (t.preferencesOutputId)
		pending.preferences =
			t.preferencesOutputId === t.contextOutputId &&
			t.preferencesWorkspaceId === t.osWorkspaceId
				? pending.shared!
				: each(() =>
						document(t.preferencesWorkspaceId!, t.preferencesOutputId!),
					);
	if (lessons)
		pending.lessons = each(async () => {
			const r = await read("agent.get_agent_session_lessons", lessons);
			return {
				organizationId: r.organizationId,
				matched: r.matched,
				truncated: r.truncated,
				holdout: r.holdout === true,
				lessons: r.lessons.map((l) => ({
					id: l.id,
					shortId: l.shortId,
					text: l.text,
					scope: l.scope,
					learned: l.learned,
					updatedAt: l.updatedAt,
				})),
			};
		});
	if (t.workItemId)
		pending.work = each(async () => {
			const r = await read("work.get_work_items_by_id", { id: t.workItemId });
			const comments = r.comments ?? [];
			return {
				item: {
					title: r.workItem.title,
					id: r.workItem.id,
					projectId: r.workItem.projectId,
					organizationId: r.workItem.orgId,
					disposition: r.workItem.disposition,
				},
				commentCount: comments.length,
				comments: comments.slice(-2).map((c) => ({
					id: c.id.slice(0, 100),
					workItemId: c.workItemId,
					authorType: c.authorType,
					authorId: c.authorId?.slice(0, 100) ?? null,
					createdAt: c.createdAt.slice(0, 50),
					body: c.body.slice(0, 400),
					complete: c.body.length <= 400,
				})),
			};
		});
	if (requests)
		pending.requests = each(async () => {
			const r = await read("work.list_agent_session_requests", {
				statuses: ["open", "in_progress", "waiting_on_user", "dropped_risk"],
				sessionKey: requests.session,
				...(requests.harness ? { harness: requests.harness } : {}),
				limit: 30,
				order: "newest",
			});
			const rows = r.data.filter(
				(q) =>
					q.sessionKey === requests.session &&
					(!q.projectId ||
						!requests.projectId ||
						q.projectId === requests.projectId),
			);
			const data = await Promise.all(
				rows.map(async (q, index) => {
					let verifiedCompletion = false;
					let verificationUnavailable = false;
					const ids = [
						...new Set(
							Array.from(
								(q.evidence ?? "").matchAll(
									/(?:work\/items\/|Work-Item:\s*|Work=)([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/gi,
								),
								(m) => m[1],
							),
						),
					];
					if (q.kind !== "ask" && ids.length) {
						verificationUnavailable = index >= 8 || ids.length > 4;
						if (!verificationUnavailable) {
							const items = await Promise.all(
								ids.map((id) =>
									each(() => read("work.get_work_items_by_id", { id: id })),
								),
							);
							verificationUnavailable = items.some(
								(r, i) => "unavailable" in r || r.workItem.id !== ids[i],
							);
							verifiedCompletion =
								!verificationUnavailable &&
								items.every(
									(r) =>
										!("unavailable" in r) &&
										r.workItem.disposition === "completed" &&
										(!q.projectId || r.workItem.projectId === q.projectId),
								);
						}
					}
					return {
						id: q.id,
						projectId: q.projectId,
						harness: q.harness,
						sessionKey: q.sessionKey,
						repository: q.repository,
						kind: q.kind,
						text: q.text.slice(0, 300),
						status: q.status,
						sourceAt: q.sourceAt,
						verifiedCompletion,
						verificationUnavailable,
					};
				}),
			);
			return { complete: r.data.length < 30, data: data };
		});
	if (nextWork)
		pending.nextWork = each(async () => {
			const query = {
				projectId: nextWork.projectId,
				disposition: "accepted",
				limit: 50,
			};
			const [r, board] = await Promise.all([
				read("work.list_work_items", query),
				read("work.list_work_item_cli_rows", { ...query, view: "board" }),
			]);
			if (board.view !== "board") throw new Error("Expected Work board");
			const idle = new Set(
				board.data
					.filter(
						(w) =>
							w.projectId === nextWork.projectId &&
							w.disposition === "accepted" &&
							w.activeAttempt === null,
					)
					.map((w) => w.id),
			);
			const candidates = r.data.filter(
				(w) =>
					idle.has(w.id) &&
					w.disposition === "accepted" &&
					w.projectId === nextWork.projectId &&
					w.id !== nextWork.selected &&
					((w.executorType == null && w.executorId == null) ||
						(w.executorType === "external_agent" &&
							w.executorId === nextWork.harness)),
			);
			return {
				data: candidates.slice(0, 3).map((w) => ({
					id: w.id,
					title: w.title.slice(0, 160),
					projectId: w.projectId,
					organizationId: w.orgId,
				})),
			};
		});
	if (t.delegations)
		pending.delegations = Promise.all(
			t.delegations.map((id) =>
				each(async () => {
					const r = await read("work.get_work_items_by_id", { id: id });
					return { id: r.workItem.id, disposition: r.workItem.disposition };
				}),
			),
		);
	const keys = Object.keys(pending);
	const values = await Promise.all(keys.map((k) => pending[k]));
	const result: Record<string, unknown> = {};
	keys.forEach((k, i) => {
		result[k] = values[i];
	});
	return result;
}

export async function readWorkBoundary(
	input: { workItemId: string },
	source: HookContextReader,
): Promise<Record<string, unknown>> {
	const read = async <K extends keyof HookContextSources>(
		name: K,
		args: Record<string, unknown>,
	): Promise<HookContextSources[K]> =>
		(await source(name, args)) as HookContextSources[K];
	const r = await read("work.get_work_items_by_id", { id: input.workItemId });
	const w = r.workItem;
	async function each<T>(
		read: () => Promise<T>,
	): Promise<T | { unavailable: true }> {
		try {
			return await read();
		} catch {
			return { unavailable: true as const };
		}
	}
	const project = w.projectId
		? await each(() => read("projects.get_project", { id: w.projectId }))
		: null;
	const objectiveId =
		w.objectiveId ??
		(project && "unavailable" in project
			? null
			: project
				? project.objectiveId
				: null);
	const objective = objectiveId
		? await each(() =>
				read("tedis.get_tedi_objectives_by_id", { id: objectiveId }),
			)
		: null;
	return {
		item: {
			id: w.id,
			organizationId: w.orgId,
			projectId: w.projectId,
			objectiveId: w.objectiveId,
			title: w.title,
			disposition: w.disposition,
			dueDate: w.dueDate,
			deadline: w.deadline,
			acceptanceContract: w.acceptanceContract,
		},
		project:
			project && "unavailable" in project
				? project
				: project
					? {
							id: project.id,
							organizationId: project.orgId,
							objectiveId: project.objectiveId,
							targetDate: project.targetDate,
						}
					: null,
		objective:
			objective && "unavailable" in objective
				? objective
				: objective
					? {
							id: objective.id,
							organizationId: objective.orgId,
							title: objective.title,
							status: objective.status,
							successCriteria: objective.successCriteria,
						}
					: null,
	};
}
