/**
 * Local fixture handlers: Work item, project, agent session, interaction and
 * attention procedures.
 */

import {
	attentionFixture,
	getAttentionFixtureLayout,
	updateAttentionFixtureLayout,
	visitAttentionFixture,
} from "../attention-fixtures";
import { officeActivityFixture } from "../office-activity-fixture";
import type { AttentionLayout } from "@tedix/api-contract/schemas/attention-layout";
import { LOCAL_OUTBOUND } from "../outbound-fixture";
import { decisionGraphFixture } from "../decision-graph-fixture";
import {
	fid,
	ORG_ID,
	RpcError,
	SKILL_REVENUE,
	T0,
	T1,
	T4,
	T5,
	TEDI_MILES,
	TEDI_NOVA,
} from "./core";
import { paginate, type Pagination } from "./lookups";
import {
	LOCAL_KNOCKS,
	LOCAL_LESSONS,
	localAgentSessions,
	localKnockDetail,
	localKnockRow,
	localProjectContributors,
	localSnoozes,
	localStewardRoutes,
} from "./office";
import { LOCAL_CASE_EDGES, LOCAL_CASE_ITEMS, localCases } from "./policies";
import { TEDIS } from "./tedis";
import {
	localProject,
	orgGraphHealthFor,
	OWNER_BRIEF,
	PROJECT_MILESTONES,
	PROJECT_SPRINTS,
	PROJECTS,
	WORK_ATTEMPTS,
	WORK_GRAPH_HEALTH,
	WORK_ITEM_RELATIONS,
	WORK_ITEMS,
	workItemId,
	workItemsInScope,
	workItemSummary,
} from "./work";

export const workHandlers: Record<string, (input: never) => unknown> = {
	"decisionGraph/getContext": (input: { cardId: string }) =>
		decisionGraphFixture(input.cardId),
	"attention/listDeckCards": () => ({
		cards: [],
		count: 0,
		complete: true,
		observedAt: new Date().toISOString(),
	}),
	"workItems/listCases": (input: {
		stages?: string[];
		projectId?: string;
	}) => ({
		data: localCases().filter(
			(row) =>
				(!input?.stages || input.stages.includes(row.stage)) &&
				(!input?.projectId || input.projectId === row.projectId),
		),
		nextCursor: null,
	}),
	"workItems/getCase": (input: { caseId: string }) => {
		const workCase = localCases().find((row) => row.id === input.caseId);
		if (!workCase) throw new RpcError("NOT_FOUND", "Case not found");
		return {
			workCase,
			items: {
				data: LOCAL_CASE_ITEMS.filter((row) => row.caseId === input.caseId),
				nextCursor: null,
			},
			dependencies: {
				data: LOCAL_CASE_EDGES.filter(
					(row) =>
						row.fromCaseId === input.caseId || row.toCaseId === input.caseId,
				),
				nextCursor: null,
			},
		};
	},
	"workItems/attachCaseWorkItem": (input: {
		caseId: string;
		workItemId: string;
		rationale?: string;
	}) => {
		const row = {
			id: fid("b3", LOCAL_CASE_ITEMS.length + 1),
			orgId: ORG_ID,
			caseId: input.caseId,
			workItemId: input.workItemId,
			rationale: input.rationale ?? null,
			discoveredAt: new Date().toISOString(),
		};
		LOCAL_CASE_ITEMS.push(row);
		return row;
	},
	"workItems/addCaseDependency": (input: {
		fromCaseId: string;
		toCaseId: string;
	}) => {
		const row = {
			id: fid("b4", LOCAL_CASE_EDGES.length + 1),
			orgId: ORG_ID,
			fromCaseId: input.fromCaseId,
			toCaseId: input.toCaseId,
			createdAt: new Date().toISOString(),
		};
		LOCAL_CASE_EDGES.push(row);
		return row;
	},
	"dispatcherHealth/list": () => ({
		reportedAt: new Date().toISOString(),
		data: ["codex", "opencode", "devin"].map((executor, index) => ({
			reporterId: "workstation",
			lane: executor,
			executor,
			running: true,
			observedAt: new Date(
				Date.now() - (index === 2 ? 600_000 : 10_000),
			).toISOString(),
			reportedAt: new Date().toISOString(),
			lastAdmissionAt: null,
			slotsInUse: index === 0 ? 1 : 0,
			slotsTotal: 3,
			topReason:
				index === 1 ? { reason: "Waiting for approval", count: 2 } : null,
			ageSeconds: index === 2 ? 600 : 10,
			staleAfterSeconds: 300,
			stale: index === 2,
		})),
	}),
	"workItems/listResourcePools": (input: {
		resourceKey?: string;
		saturatedOnly?: boolean;
	}) => ({
		data: ["Workshop browser", "Shared review workstation"]
			.map((resourceKey, index) => ({
				pool: {
					id: fid("b2", index + 1),
					orgId: ORG_ID,
					resourceKey,
					allocationMode: "capacity",
					capacity: 2,
					ownerRef: null,
					createdAt: T0,
					updatedAt: null,
					version: 1,
				},
				activeReserved: index === 0 ? 2 : 0,
				effectiveAvailable: index === 0 ? 0 : 2,
				holders:
					index === 0
						? [
								{
									attemptId: fid("b4", 1),
									workItemId: workItemId(1),
									workTitle:
										"Coordinate the fictional west warehouse overnight capacity handoff",
									executorType: "tedi",
									executorId: TEDI_NOVA,
									externalSessionKey: `external:session_${"x".repeat(96)}`,
									quantity: 2,
									// Whole minutes, so two reads of the same pool agree.
									expiresAt: new Date(
										Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000,
									).toISOString(),
								},
							]
						: [],
				holdersTruncated: false,
			}))
			.filter(
				(row) =>
					(!input?.resourceKey || input.resourceKey === row.pool.resourceKey) &&
					(!input?.saturatedOnly || row.effectiveAvailable === 0),
			),
		nextCursor: null,
		observedAt: new Date().toISOString(),
	}),
	"workItems/listBudgetEnvelopes": () => ({
		data: [0, 1].map((index) => ({
			envelope: {
				id: fid("b3", index + 1),
				orgId: ORG_ID,
				scopeType: "project",
				scopeId: fid("76", index + 1),
				currency: "USD",
				limitMicros: 10_000_000,
				reservationMicros: 1_000_000,
				createdAt: T0,
				updatedAt: null,
				version: 1,
			},
			committedMicros: index === 0 ? 2_000_000 : 10_000_000,
			availableMicros: index === 0 ? 8_000_000 : 0,
		})),
		nextCursor: null,
		observedAt: new Date().toISOString(),
	}),
	"workInteractions/outbound/list": () => [LOCAL_OUTBOUND],
	"workInteractions/outbound/get": () => LOCAL_OUTBOUND,
	"workInteractions/outbound/accounts": () => [],
	"workInteractions/outbound/policy": () => ({ routes: [] }),
	"workInteractions/outbound/profile": () => ({
		decisionCount: 0,
		approvalCount: 0,
		preferences: [],
		approvals: [],
		lessons: [],
		sentExamples: 0,
		sentStyleHints: [],
	}),
	"workAgentSessions/attention": (input: { workspaceId?: string }) =>
		attentionFixture(input.workspaceId),
	"workAgentSessions/getAttentionLayout": () => getAttentionFixtureLayout(),
	"workAgentSessions/updateAttentionLayout": (input: {
		layout: AttentionLayout;
		expectedRevision: number;
	}) => updateAttentionFixtureLayout(input),
	"workAgentSessions/visitAttention": () => visitAttentionFixture(),
	"workAgentSessions/list": (input: { includeEnded?: boolean } | undefined) =>
		localAgentSessions(input?.includeEnded),
	"workAgentSessions/listRequests": () => ({ data: [] }),
	"workAgentSessions/listOperations": () => officeActivityFixture(),
	"workAgentSessions/contributors": (input: { projectId: string }) =>
		localProjectContributors(input.projectId),
	// Sample data has no automatic follow-up reminders to close.
	"workInteractions/dismissReminders": () => ({ dismissed: [] }),
	"workInteractions/snooze": (input: {
		requestId: string;
		expectedVersion: number;
		until: string;
	}) => {
		const detail = localKnockDetail(input.requestId);
		if (
			!detail ||
			detail.request.version !== input.expectedVersion ||
			detail.request.state !== "open" ||
			Date.parse(input.until) <= Date.now()
		)
			throw new RpcError("CONFLICT", "Card changed or invalid wake time");
		localSnoozes.set(input.requestId, input.until);
		return {
			...detail.request,
			metadata: {
				...detail.request.metadata,
				followThrough: { snoozedUntil: input.until },
			},
		};
	},
	"workInteractions/delegateToSteward": (input: {
		requestId: string;
		expectedRequestVersion: number;
		reason: string;
	}) => {
		const detail = localKnockDetail(input.requestId);
		if (
			!detail ||
			detail.request.version !== input.expectedRequestVersion ||
			detail.request.state !== "open" ||
			localStewardRoutes.has(input.requestId)
		)
			throw new RpcError("CONFLICT", "Question is no longer delegatable");
		localStewardRoutes.add(input.requestId);
		const steward = "00000000-0000-4000-8000-0000000000c7";
		return {
			request: {
				...detail.request,
				version: detail.request.version + 1,
				requestedFromType: "tedi",
				requestedFromId: steward,
				metadata: {
					...detail.request.metadata,
					delegation: {
						toTediId: steward,
						reason: input.reason,
						via: "steward",
					},
				},
			},
			steward: { id: steward, name: "CTO" },
			woken: false,
		};
	},
	"workInteractions/listInbox": (
		input: { states?: string[]; urgency?: string } | undefined,
	) => ({
		data: LOCAL_KNOCKS.filter(
			(knock) =>
				!localStewardRoutes.has(fid("a7", knock.n)) &&
				(knock.state !== "open" ||
					(localSnoozes.get(fid("a7", knock.n)) ?? "") <=
						new Date().toISOString()) &&
				(!input?.states || input.states.includes(knock.state)) &&
				(!input?.urgency || input.urgency === knock.urgency),
		).map(localKnockRow),
		nextCursor: null,
		hasMore: false,
		observedAt: new Date().toISOString(),
	}),
	// Sample decisions are already seeded; refreshing never creates duplicates.
	"workInteractions/refreshDecisionSources": () => ({
		created: 0,
		superseded: 0,
		scanned: WORK_ITEMS.length,
		hasMore: false,
	}),
	"workInteractions/get": (input: { requestId: string }) =>
		localKnockDetail(input.requestId),
	"agentTurnTriage/getReplyDraftAcceptance": () => ({
		byTurnType: [
			{
				turnType: "ship",
				drafts: 3,
				decided: 1,
				accepted: 0,
				edited: 1,
				replaced: 0,
				rate: 0,
				eligible: false,
				autoSent: 2,
				autoFollowedUp: 1,
				overridden: 0,
				overrideRate: 0,
			},
		],
		policy: { minDrafts: 50, minRate: 0.9 },
	}),
	"agentTurnTriage/getCaptureHealth": () => ({
		turns: 14,
		drafts: 6,
		lessons: 9,
	}),
	"agentTurnTriage/getReplyDraftLeaderboard": () => {
		const score = (
			answered: number,
			autoSent: number,
			stood: number,
			corrected: number,
			avgReplySeconds: number | null,
		) => ({
			answered,
			autoSent,
			stood,
			corrected,
			steered: 0,
			avgReplySeconds,
		});
		return {
			tedis: [
				{
					tediId: TEDI_NOVA,
					name: "Nova",
					avatar: null,
					week: score(14, 9, 11, 2, 38),
					today: score(3, 2, 3, 0, 31),
					level: {
						stage: "apprentice" as const,
						nextStage: "operator" as const,
						stood: 12,
						corrected: 1,
						target: 25,
						minStandingRate: 0.9,
						streakDays: 4,
					},
				},
				{
					tediId: TEDI_MILES,
					name: "Miles",
					avatar: null,
					week: score(6, 2, 4, 1, 52),
					today: score(1, 0, 0, 1, 64),
					level: null,
				},
			],
		};
	},
	"agentTurnTriage/listLessons": () => ({
		lessons: LOCAL_LESSONS.map((lesson) => {
			const added = new Date(
				Date.now() - lesson.addedMinutesAgo * 60_000,
			).toISOString();
			return {
				id: fid("b1", lesson.n),
				fromCallerFeedback: true,
				text: lesson.text,
				addedAt: added,
				learnedFrom: lesson.replies
					? { replies: lesson.replies, lastReplyAt: added, fromCaller: true }
					: null,
			};
		}),
	}),

	// --- activity ---
	"workItems/list": (
		input:
			| {
					disposition?: string;
					workKind?: string;
					projectId?: string;
					titleContains?: string;
					limit?: number;
					offset?: number;
			  }
			| undefined,
	) =>
		paginate(
			WORK_ITEMS.filter(
				(row) =>
					(input?.disposition === undefined ||
						row.disposition === input.disposition) &&
					(input?.workKind === undefined || row.workKind === input.workKind) &&
					(input?.projectId === undefined ||
						row.projectId === input.projectId) &&
					(input?.titleContains === undefined ||
						row.title
							.toLowerCase()
							.includes(input.titleContains.toLowerCase())),
			),
			input,
		),
	// Work item detail: the record and its project brief; the ledgers are empty.
	"workItems/getById": (input: { id: string }) => {
		const workItem = WORK_ITEMS.find((row) => row.id.startsWith(input.id));
		if (!workItem) throw new RpcError("NOT_FOUND", "Work item not found");
		const project = PROJECTS.find((row) => row.id === workItem.projectId);
		return {
			workItem,
			project: project
				? {
						id: project.id,
						name: project.name,
						description: project.description,
					}
				: null,
			comments: [],
			evidence: [],
			evidenceNextCursor: null,
			projections: [],
		};
	},
	"workItems/getReadiness": (input: { id: string }) => ({
		workItemId: input.id,
		state: "ready" as const,
		ready: true,
		reasons: [],
		derivedAt: T5,
		gates: [],
	}),
	// Accepted queue: items with a live attempt read as already running.
	"workItems/listReadinessProjection": (
		input:
			| { projectId?: string; workKind?: string; limit?: number }
			| undefined,
	) => {
		const rows = WORK_ITEMS.filter(
			(row) =>
				row.disposition === "accepted" &&
				(input?.projectId === undefined || row.projectId === input.projectId) &&
				(input?.workKind === undefined || row.workKind === input.workKind),
		);
		const limit = input?.limit ?? 25;
		return {
			data: rows.slice(0, limit).map((row) => {
				const running = WORK_ATTEMPTS.some(
					(attempt) => attempt.workItemId === row.id,
				);
				return {
					workItem: {
						...workItemSummary(row),
						createdAt: row.createdAt,
						updatedAt: row.updatedAt,
					},
					readiness: {
						workItemId: row.id,
						state: running ? ("already_running" as const) : ("ready" as const),
						ready: !running,
						reasons: running
							? [
									{
										code: "already_running" as const,
										detail: "An attempt is already running.",
									},
								]
							: [],
						derivedAt: T5,
						gates: [],
					},
				};
			}),
			nextCursor: null,
			hasMore: rows.length > limit,
			observedAt: T5,
		};
	},
	"workItems/listAttempts": () => ({ data: [], nextCursor: null }),
	"workItems/initializeRepositoryCandidate": () => {
		throw new RpcError(
			"FORBIDDEN",
			"Only the current verified executor can initialize this candidate",
		);
	},
	"workItems/readRepositoryCandidate": () => {
		throw new RpcError(
			"CONFLICT",
			"Current executor has not initialized a shared repository candidate",
		);
	},
	"workItems/submitRepositoryCandidate": () => {
		throw new RpcError(
			"FORBIDDEN",
			"Only the current verified executor can submit this candidate",
		);
	},
	"workItems/sealRepositoryCandidate": () => {
		throw new RpcError(
			"FORBIDDEN",
			"Only the current verified executor can seal this candidate",
		);
	},
	"workItems/applyRepositoryCandidate": () => {
		throw new RpcError(
			"FORBIDDEN",
			"Repository publication requires the current verified native executor",
		);
	},
	"workItems/reconcileRepositoryCandidate": () => {
		throw new RpcError(
			"FORBIDDEN",
			"Repository publication observation requires a verified native executor",
		);
	},
	"workItems/readAttemptRepository": (input: {
		operation: "log" | "tree" | "file";
		path?: string;
	}) => {
		const repository = {
			version: 1 as const,
			provider: "cloudflare_artifacts" as const,
			status: "ready" as const,
			mode: "create" as const,
			repositoryName: `work-${workItemId(1).slice(0, 8)}-${fid("47", 1)}`,
			repositoryId: "repo-local-1",
			remote: "https://artifacts.example/local/work.git",
			defaultBranch: "main",
			sourceRepositoryName: null,
			sourceRef: null,
			baseRevision: "b".repeat(40),
			workItemId: workItemId(1),
			workItemVersion: 1,
			admissionSpecRevision: "rev-local-1",
			admissionId: fid("47", 0x41),
			attemptId: fid("47", 1),
			observedAt: T5,
			reason: null,
		};
		const base = { repository, resolvedRevision: "c".repeat(40) };
		if (input.operation === "log")
			return {
				...base,
				operation: "log" as const,
				commits: [
					{
						hash: "c".repeat(40),
						treeHash: "d".repeat(40),
						message: "Cohort export wired to Work evidence",
						author: { name: "Miles", email: "miles@tedix.local" },
						parents: ["b".repeat(40)],
						committedAt: T5,
					},
					{
						hash: "b".repeat(40),
						treeHash: "e".repeat(40),
						message: "Start cohort view",
						author: { name: "Miles", email: "miles@tedix.local" },
						parents: [],
						committedAt: T4,
					},
				],
			};
		if (input.operation === "tree")
			return {
				...base,
				operation: "tree" as const,
				path: input.path ?? "",
				exists: true,
				entries: input.path
					? [
							{
								name: "index.ts",
								path: `${input.path}/index.ts`,
								mode: "100644",
								hash: "f".repeat(40),
								type: "blob" as const,
							},
						]
					: [
							{
								name: "src",
								path: "src",
								mode: "40000",
								hash: "e".repeat(40),
								type: "tree" as const,
							},
							{
								name: "README.md",
								path: "README.md",
								mode: "100644",
								hash: "f".repeat(40),
								type: "blob" as const,
							},
						],
				truncated: false,
			};
		const body = "# Cohort\n\nLocal fixture repository file.\n";
		return {
			...base,
			operation: "file" as const,
			path: input.path ?? "README.md",
			exists: true,
			size: body.length,
			mediaType: "text/plain",
			binary: false,
			dataBase64: btoa(body),
			truncated: false,
		};
	},
	"workItems/reviewAttemptRepository": (input: {
		id: string;
		attemptId: string;
		expectedHeadRevision: string;
		operation: string;
		path?: string;
	}) => ({
		workItemId: input.id,
		attemptId: input.attemptId,
		baseRevision: "a".repeat(40),
		headRevision: input.expectedHeadRevision,
		operation: input.operation,
		path: input.path ?? "",
		entries:
			input.operation === "tree"
				? [
						{
							name: "README.md",
							type: "blob",
							hash: "c".repeat(40),
							change: "modified",
						},
					]
				: [],
		commits:
			input.operation === "history"
				? [
						{
							hash: input.expectedHeadRevision,
							message: "Update example",
							authoredAt: 1_790_000_000,
						},
					]
				: [],
		nextOffset: null,
		truncated: false,
		base:
			input.operation === "compare"
				? { status: "text", text: "Example before\n", bytes: 15 }
				: null,
		head:
			input.operation === "compare"
				? { status: "text", text: "Example after\n", bytes: 14 }
				: null,
	}),
	"workItems/listEvidence": () => ({ data: [], nextCursor: null }),
	"workItems/listEvents": () => ({ events: [], nextSequence: null }),
	"workItems/listAttemptProjection": (
		input:
			| {
					projectId?: string;
					workItemId?: string;
					runtimeStates?: string[];
					outcomes?: string[];
					executorType?: string;
					limit?: number;
			  }
			| undefined,
	) => {
		const rows = WORK_ATTEMPTS.filter((attempt) => {
			const item = WORK_ITEMS.find((row) => row.id === attempt.workItemId);
			return (
				item !== undefined &&
				(input?.projectId === undefined ||
					item.projectId === input.projectId) &&
				(input?.workItemId === undefined ||
					attempt.workItemId === input.workItemId) &&
				(input?.runtimeStates === undefined ||
					input.runtimeStates.includes(attempt.runtimeState)) &&
				(input?.outcomes === undefined ||
					(attempt.outcome !== null &&
						input.outcomes.includes(attempt.outcome))) &&
				(input?.executorType === undefined ||
					attempt.executorType === input.executorType)
			);
		});
		const limit = input?.limit ?? 50;
		return {
			data: rows.slice(0, limit).map((attempt) => ({
				attempt,
				workItem: workItemSummary(
					WORK_ITEMS.find((row) => row.id === attempt.workItemId)!,
				),
				laneState: null,
			})),
			nextCursor: null,
			hasMore: rows.length > limit,
		};
	},
	"projects/list": (input: Pagination | undefined) => paginate(PROJECTS, input),
	"projects/get": (input: { id: string }) => ({
		...localProject(input.id),
		objective: null,
	}),
	"projects/update": (input: { id: string; targetDate?: string | null }) => {
		const row = localProject(input.id);
		if (input.targetDate !== undefined) row.targetDate = input.targetDate;
		row.updatedAt = new Date().toISOString();
		return row;
	},
	"projects/getRollup": (input: { id: string }) => {
		const items = workItemsInScope(localProject(input.id).id);
		const done = items.filter((row) => row.disposition === "completed").length;
		const byDisposition: Record<string, number> = {};
		for (const row of items)
			byDisposition[row.disposition] =
				(byDisposition[row.disposition] ?? 0) + 1;
		return {
			projectId: input.id,
			total: items.length,
			byDisposition,
			byWorkKind: {},
			percentDone: items.length ? done / items.length : 0,
			aggregateDisposition: items.length ? "accepted" : "empty",
			distinctExecutors: [],
			topLevelItems: items.map(({ id, workKind, title, disposition }) => ({
				id,
				workKind,
				title,
				disposition,
			})),
			truncated: false,
		};
	},
	"projects/getPortfolio": () => ({
		data: PROJECTS.map((project) => {
			const items = workItemsInScope(project.id);
			const byDisposition: Record<string, number> = {};
			for (const row of items)
				byDisposition[row.disposition] =
					(byDisposition[row.disposition] ?? 0) + 1;
			const lead = TEDIS.find((tedi) => tedi.id === project.leadTediId);
			const next =
				items.find((row) => row.disposition === "accepted") ??
				items.find((row) => row.disposition === "proposed");
			return {
				project,
				leadTediName: lead ? lead.displayName || lead.name : null,
				total: items.length,
				byDisposition,
				next: next ? { id: next.id, title: next.title } : null,
				health: null,
				lastActivityAt: null,
			};
		}),
	}),
	"projects/getFactoryScoreboard": () => ({
		data: [
			{
				kind: "skill_loop" as const,
				id: SKILL_REVENUE,
				name: "Weekly revenue report",
				tediId: TEDI_MILES,
				tediName: "Miles",
				cron: "0 7 * * *",
				runs: 7,
				succeeded: 7,
				lastRunAt: "2026-10-08 07:00:00",
				outputs: 0,
				workClosed: 0,
				lastResult: null,
				paused: false,
				idle: true,
				verdict: "idle" as const,
				verdictReason:
					"Run run-revenue-7 succeeded but created no Work, comments or Output revisions.",
			},
		],
		since: "2026-10-01T00:00:00.000Z",
	}),
	"projects/listMilestones": (input: { id: string }) => {
		localProject(input.id);
		return {
			data: PROJECT_MILESTONES.filter(
				(entry) => entry.milestone.projectId === input.id,
			).map((entry) => ({
				milestone: entry.milestone,
				workItems: entry.workItemNs
					.map((n) => WORK_ITEMS.find((row) => row.id === workItemId(n)))
					.filter((row) => row !== undefined)
					.map(({ id, title, disposition }) => ({ id, title, disposition })),
				dependencies: [],
				workItemsTruncated: false,
				dependenciesTruncated: false,
			})),
			nextCursor: null,
		};
	},
	"projects/listSprints": (input: { id: string }) => {
		localProject(input.id);
		return {
			data: PROJECT_SPRINTS.filter(
				(entry) => entry.sprint.projectId === input.id,
			),
		};
	},
	"projects/listHealthJudgments": (input: { id: string }) => {
		localProject(input.id);
		return [];
	},

	// --- work graph diagnostics ---
	"workItems/listRelations": (
		input: { projectId?: string; limit?: number } | undefined,
	) => {
		const ids = new Set(
			workItemsInScope(input?.projectId).map((row) => row.id),
		);
		const relations = WORK_ITEM_RELATIONS.filter(
			(row) =>
				input?.projectId === undefined ||
				(ids.has(row.fromWorkItemId) && ids.has(row.toWorkItemId)),
		);
		const limit = input?.limit ?? 500;
		return {
			relations: relations.slice(0, limit),
			truncated: relations.length > limit,
		};
	},
	"workItems/getOrgGraphHealth": (
		input: { projectId?: string; limit?: number } | undefined,
	) => orgGraphHealthFor(input?.projectId, input?.limit ?? 20),
	"workItems/getWorkGraphHealth": () => WORK_GRAPH_HEALTH,

	// --- purpose ---
	"organizationPurpose/getOwnerBrief": () => OWNER_BRIEF,
	"externalAgentIdentity/listPrincipals": () => [
		{
			id: fid("ea", 1),
			organizationId: ORG_ID,
			key: "sample-fixture-agent",
			displayName: "Sample fixture agent",
			status: "active",
			credentialBindingType: "api_key",
			credentialBindingId: "sample-fixture-binding",
			createdByType: "user",
			createdById: "sample-operator",
			metadata: {},
			createdAt: T1,
			updatedAt: T5,
			platform: null,
			representedUserId: null,
			allowedScopes: null,
			expiresAt: null,
			lastSeenAt: T5,
		},
	],
};
