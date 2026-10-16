import type { DbClient } from "@tedix/db/client";
import type {
	TaskStateSnapshot,
	TurnMemory,
} from "@tedix/api-contract/schemas/turn-memory";
import { memorySourceReferences } from "@tedix/context-core/memory-freshness";
import {
	getWorkItemById,
	listWorkItemsPage,
} from "@tedix/db/queries/work-items/crud";
import { listWorkApprovalInbox } from "@tedix/db/queries/work-items/approvals";
import { getApprovalRequestById } from "@tedix/db/queries/approvals";
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
	const tasks = new Map<string, TaskStateSnapshot>();
	for (const id of new Set(references)) {
		const [work, approvals, runtimeApproval] = await Promise.all([
			getWorkItemById(db, id, orgId),
			listWorkApprovalInbox(db, {
				orgId,
				proposalId: id,
				observedAt: checkedAt,
				limit: 1,
			}),
			getApprovalRequestById(db, id, orgId),
		]);
		if (work) {
			tasks.set(work.id, {
				id: work.id,
				kind: "work",
				title: work.title,
				state: work.disposition,
				deadline: work.deadline ?? work.dueDate ?? null,
			});
			const linked = await listWorkApprovalInbox(db, {
				orgId,
				workItemId: id,
				observedAt: checkedAt,
				limit: 100,
			});
			for (const row of linked.data)
				tasks.set(row.proposal.id, {
					id: row.proposal.id,
					kind: "approval",
					title: row.proposal.action,
					state: row.effectiveStatus,
					deadline: row.proposal.expiresAt,
				});
		}
		for (const row of approvals.data)
			tasks.set(row.proposal.id, {
				id: row.proposal.id,
				kind: "approval",
				title: row.proposal.action,
				state: row.effectiveStatus,
				deadline: row.proposal.expiresAt,
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
			orgId,
			visibilityTediId: tediId,
			factType: "preference",
			limit: 100,
		}),
		listApprovedAgentLessons(db, orgId, "learning-feed:"),
		listWorkItemsPage(db, {
			orgId,
			accountableOwnerId: tediId,
			disposition: "accepted",
			limit: 100,
		}),
	]);
	const referenced = await readTaskMemoryState(
		db,
		orgId,
		references,
		checkedAt,
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
		await updateFact(db, fact.id, {
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
