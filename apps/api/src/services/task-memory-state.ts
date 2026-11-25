import { readDraftPreferences } from "./decision-learning";
import { OutboundStateSchema } from "@tedix/api-contract/schemas/outbound";
import type { DbClient } from "@tedix/db/client";
import type {
	TaskStateSnapshot,
	TurnMemory,
} from "@tedix/api-contract/schemas/turn-memory";
import { memorySourceReferences } from "@tedix/context-core/memory-freshness";
import {
	getWorkItemsByIds,
	listWorkItemsPage,
} from "@tedix/db/queries/work-items/crud";
import { listTaskMemoryApprovals } from "@tedix/db/queries/work-items/approvals";
import { getApprovalRequestsByIds } from "@tedix/db/queries/approvals";
import { searchFactsWithVisibility } from "@tedix/db/queries/memory-graph/fact-search";
import { listApprovedAgentLessons } from "@tedix/db/queries/memory-graph/agent-lessons";
import { updateFact } from "@tedix/db/queries/memory-graph/facts";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import { isMemorySearchFactEligible } from "./memory-search-filter";

/** Resolve exact references, including terminal rows; absence never means done. */
export async function readTaskMemoryState(
	db: DbClient,
	orgId: string,
	references: string[],
	checkedAt: string,
): Promise<TaskStateSnapshot[]> {
	const workRows = await getWorkItemsByIds(db, {
		orgId,
		ids: [...new Set(references)],
	});
	return taskMemoryFromRows(db, orgId, references, checkedAt, workRows);
}

async function taskMemoryFromRows(
	db: DbClient,
	orgId: string,
	references: string[],
	checkedAt: string,
	workRows: Awaited<ReturnType<typeof getWorkItemsByIds>>,
): Promise<TaskStateSnapshot[]> {
	const [approvalRows, runtimeRows] = await Promise.all([
		listTaskMemoryApprovals(db, { orgId, references, observedAt: checkedAt }),
		getApprovalRequestsByIds(db, { orgId, ids: references }),
	]);
	const works = new Map(workRows.map((row) => [row.id, row]));
	const approvals = new Map(approvalRows.map((row) => [row.id, row]));
	const runtime = new Map(runtimeRows.map((row) => [row.id, row]));
	const linked = new Map<string, typeof approvalRows>();
	for (const row of approvalRows) {
		if (!row.linked) continue;
		const rows = linked.get(row.workItemId) ?? [];
		rows.push(row);
		linked.set(row.workItemId, rows);
	}
	const tasks = new Map<string, TaskStateSnapshot>();
	for (const id of new Set(references)) {
		const work = works.get(id);
		const runtimeApproval = runtime.get(id);
		if (work) {
			tasks.set(work.id, {
				id: work.id,
				kind: "work",
				title: work.title,
				state: work.disposition,
				deadline: work.deadline ?? work.dueDate ?? null,
			});
			for (const row of linked.get(id) ?? [])
				tasks.set(row.id, {
					id: row.id,
					kind: "approval",
					title: row.action,
					state: row.effectiveStatus,
					deadline: row.expiresAt,
				});
		}
		const approval = approvals.get(id);
		if (approval)
			tasks.set(approval.id, {
				id: approval.id,
				kind: "approval",
				title: approval.action,
				state: approval.effectiveStatus,
				deadline: approval.expiresAt,
			});
		if (runtimeApproval)
			tasks.set(runtimeApproval.id, {
				id: runtimeApproval.id,
				kind: "approval",
				title: runtimeApproval.description,
				state:
					runtimeApproval.status === "pending" &&
					runtimeApproval.expiresAt <= checkedAt
						? "expired"
						: runtimeApproval.status,
				deadline: runtimeApproval.expiresAt,
			});
	}
	return [...tasks.values()];
}

export async function readTurnMemory(
	db: DbClient,
	orgId: string,
	tediId: string,
	references: string[],
): Promise<TurnMemory> {
	const checkedAt = new Date().toISOString();
	const [preferences, lessons, owned] = await Promise.all([
		searchFactsWithVisibility(db, {
			organizationId: orgId,
			visibilityTediId: tediId,
			factType: "preference",
			limit: 100,
		}),
		listApprovedAgentLessons(db, { organizationId: orgId }, "learning-feed:"),
		listWorkItemsPage(db, {
			orgId,
			accountableOwnerId: tediId,
			disposition: "accepted",
			limit: 100,
		}),
	]);
	const workRows = await getWorkItemsByIds(db, {
		orgId,
		ids: [...new Set(references)],
	});
	const referenced = await taskMemoryFromRows(
		db,
		orgId,
		references,
		checkedAt,
		workRows,
	);
	const works = new Map(workRows.map((row) => [row.id, row]));
	const writers = new Set<string>();
	for (const id of [...new Set(references)].slice(0, 10)) {
		const work = works.get(id);
		if (!work) continue;
		const outbound = OutboundStateSchema.safeParse(work.metadata?.outbound);
		if (
			outbound.success &&
			(outbound.data.reviewerTediId === tediId ||
				(outbound.data.author.type === "tedi" &&
					outbound.data.author.id === tediId))
		)
			writers.add(outbound.data.ownerUserId);
		else if (
			work.accountableOwnerType === "user" &&
			work.accountableOwnerId &&
			work.stewardType === "tedi" &&
			work.stewardId === tediId
		)
			writers.add(work.accountableOwnerId);
	}
	const writing = await Promise.all(
		(writers.size ? [...writers].slice(0, 5) : [null]).map(async (person) => ({
			id: `decision-learning:${person ?? "organization"}`,
			content: await readDraftPreferences(db, orgId, person),
		})),
	);
	const tasks: TaskStateSnapshot[] = [
		...referenced,
		...owned.data
			.filter((work) => !referenced.some((task) => task.id === work.id))
			.map((work) => ({
				id: work.id,
				kind: "work" as const,
				title: work.title,
				state: work.disposition,
				deadline: work.deadline ?? work.dueDate ?? null,
			})),
	];
	return {
		checkedAt,
		preferences: [
			...writing.filter((p) => p.content),
			...preferences
				.filter(
					(fact) =>
						isMemorySearchFactEligible(fact, { orgId, tediId }) &&
						fact.metadata?.verifyBeforeUse !== true,
				)
				.map(({ id, content }) => ({ id, content })),
			...lessons.map(({ id, content }) => ({ id, content })),
		],
		tasks,
		unresolvedReferences: references.filter(
			(id) => !tasks.some((task) => task.id === id),
		),
		truncated:
			owned.total > owned.data.length ||
			preferences.length === 100 ||
			lessons.length === 200,
	};
}

/** Deterministic reflector correction: only source-bound transient facts change. */
export async function reconcileTaskMemory(
	db: DbClient,
	orgId: string,
	facts: MemoryFact[],
): Promise<void> {
	const checkedAt = new Date().toISOString();
	for (const fact of facts) {
		if (
			fact.organizationId !== orgId ||
			(fact.factType === "preference" &&
				fact.metadata?.verifyBeforeUse !== true) ||
			(fact.metadata?.verifyBeforeUse !== true &&
				!fact.source?.startsWith("observation://"))
		)
			continue;
		const references = memorySourceReferences(fact.content);
		if (!references.length) continue;
		const tasks = await readTaskMemoryState(db, orgId, references, checkedAt);
		if (!tasks.length) continue;
		const content = tasks
			.map(
				(task) =>
					`${task.kind} ${task.id}: ${task.state}; ${task.title}; deadline=${task.deadline ?? "none"}`,
			)
			.join("\n");
		if (content === fact.content) continue;
		await updateFact(db, { organizationId: orgId }, fact.id, {
			content,
			summary: content,
			lastVerifiedAt: checkedAt,
			metadata: {
				...fact.metadata,
				originalContent: fact.metadata?.originalContent ?? fact.content,
				verifyBeforeUse: true,
				correctedAt: checkedAt,
			},
		});
	}
}
