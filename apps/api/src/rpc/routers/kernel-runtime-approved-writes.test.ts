import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { normalizeHomeRunRecord } from "./kernel/run-store-normalization";
import { createDelegationWorkItem } from "./kernel/delegation-work-item";
import type { KernelResult } from "./kernel/index";
import type { KernelRouteDecision } from "./kernel/route-schema";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";
import {
	setKernelToolResultRetainerForTest,
	settleHomeToolWriteApproval,
} from "./kernel/write-approval-settlement";

import {
	ORG_ID,
	NATIVE_EXECUTION_REQUIREMENT,
	type KernelRuntimeRunRow,
	type WorkItemRow,
	type WorkAttemptRow,
	normalizeKernelRuntimeRunInsert,
	normalizeWorkItemInsert,
	runningWorkAttempt,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
} from "./__tests__/kernel-runtime-db";

vi.mock("@tedix/db/queries/work-items/admissions", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/admissions")
		>();
	return {
		...original,
		evaluateAndRecordWorkAdmission: vi.fn(async (_db, input) => ({
			id: `admission:${input.workItemId}:${input.executorId}`,
			expiresAt: new Date(
				Date.parse(input.now) + input.leaseTtlMs,
			).toISOString(),
			decision: "admitted" as const,
		})),
	};
});

vi.mock("@tedix/db/queries/work-items/attempts", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/attempts")
		>();
	return {
		...original,
		startWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					admissionId: string;
					executor: { type: "tedi" | "external_agent"; id: string };
					expiresAt?: string;
					metadata?: Record<string, unknown>;
					orgId: string;
					runId?: string;
					startedAt?: string;
					workItemId: string;
				},
			) => {
				const fake = db as {
					workAttemptRows: WorkAttemptRow[];
					workItemRows: WorkItemRow[];
				};
				const workItem = fake.workItemRows.find(
					(row) => row.id === input.workItemId,
				);
				if (!workItem) throw new Error(`Missing Work Item ${input.workItemId}`);
				const startedAt = input.startedAt ?? new Date().toISOString();
				const attempt = {
					id: crypto.randomUUID(),
					admissionId: input.admissionId,
					workItemId: input.workItemId,
					orgId: input.orgId,
					executorType: input.executor.type,
					executorId: input.executor.id,
					executorSessionId: null,
					externalSessionKey: null,
					runId: input.runId ?? null,
					runtimeState: "running",
					outcome: null,
					attemptNumber: fake.workAttemptRows.length + 1,
					startedAt,
					heartbeatAt: startedAt,
					expiresAt: input.expiresAt ?? null,
					finishedAt: null,
					summary: null,
					version: 1,
					metadata: input.metadata ?? {},
				} as WorkAttemptRow;
				fake.workAttemptRows.push(attempt);
				return { workItem, attempt, resumed: false };
			},
		),
		settleWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					attemptId: string;
					outcome: "succeeded" | "failed" | "cancelled";
					settledAt?: string;
					summary?: string;
				},
			) => {
				const fake = db as { workAttemptRows: WorkAttemptRow[] };
				const attempt = fake.workAttemptRows.find(
					(row) => row.id === input.attemptId,
				);
				if (!attempt)
					throw new Error(`Missing Work attempt ${input.attemptId}`);
				attempt.outcome = input.outcome;
				attempt.runtimeState =
					input.outcome === "succeeded"
						? "finished"
						: input.outcome === "failed"
							? "failed"
							: "cancelled";
				attempt.finishedAt = input.settledAt ?? new Date().toISOString();
				attempt.summary = input.summary ?? null;
				attempt.version += 1;
				return attempt;
			},
		),
	};
});

vi.mock("@tedix/db/queries/work-items/evidence", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/evidence")
	>()),
	submitWorkItemEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as { workEvidenceRows: Array<Record<string, any>> };
			const evidence = {
				id: crypto.randomUUID(),
				attemptId: input.attemptId ?? null,
				claimKey: input.claimKey,
				digest: input.digest ?? null,
				disposition: "pending",
				kind: input.kind,
				metadata: input.metadata ?? {},
				uri: input.uri,
				workItemId: input.workItemId,
			};
			fake.workEvidenceRows.push(evidence);
			return evidence;
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/projections", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/projections")
	>()),
	listOrgWorkEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as {
				workEvidenceRows: Array<Record<string, any>>;
				workItemRows: WorkItemRow[];
			};
			return {
				data: fake.workEvidenceRows
					.filter(
						(row) =>
							row.workItemId === input.workItemId &&
							row.attemptId === input.attemptId,
					)
					.map((evidence) => ({
						evidence,
						workItem: fake.workItemRows.find(
							(item) => item.id === evidence.workItemId,
						),
					})),
				nextCursor: null,
				observedAt: new Date().toISOString(),
			};
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	completeWorkItem: vi.fn(async (db: unknown, input: Record<string, any>) => {
		const fake = db as { workItemRows: WorkItemRow[] };
		const item = fake.workItemRows.find((row) => row.id === input.workItemId);
		if (!item) throw new Error(`Missing Work Item ${input.workItemId}`);
		item.disposition = "completed";
		return item;
	}),
}));

describe("home approved-write layer (v1)", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		kernelRuntimeTestHooks.setKernelForTest(null);
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(null);
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(null);
	});

	const WRITE_ROUTE = {
		routeKind: "propose_tool_write" as const,
		rationale: "Operator asked to create a Globex invoice.",
		risk: "medium" as const,
		confidence: 0.82,
		toolIntent: {
			appSlug: "globex",
			capability: "globex.invoices.create",
			connectionStatus: "connected" as const,
		},
	};

	const PROPOSAL = {
		appSlug: "globex-tedix",
		toolName: "globex__create_invoice",
		args: { amount: 100, customerName: "ACME" },
		reasoning: "create the requested invoice",
		riskTier: "low" as const,
	};

	function stubWriteKernel() {
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "RECOMMEND:write",
				route: WRITE_ROUTE,
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);
	}

	// The initiator's membership as the settle path re-reads it.
	function withInitiatorMember(
		db: ReturnType<typeof createKernelRuntimeDb>,
		member?: { role: string; status: string; customPermissions?: string[] },
	) {
		const findFirst = vi.fn(async () =>
			member ? { ...member, organizationId: ORG_ID } : undefined,
		);
		(db as unknown as { query: unknown }).query = {
			organizationMembers: { findFirst },
		};
		return findFirst;
	}

	async function enqueueWriteProposalTurn(
		db: ReturnType<typeof createKernelRuntimeDb>,
		runId = "home-write-1",
		proposal = PROPOSAL,
		context = createContext(db),
	) {
		const client = createKernelRuntimeClient(context);
		stubWriteKernel();
		const planner = vi.fn(async () => proposal);
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			planner as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest
			>[0],
		);
		const result = await client.enqueueMessage({
			conversationId: "home:write",
			content: "create a globex invoice over 100 euros for ACME",
			idempotencyKey: runId,
		});
		return { context, client, planner, result };
	}

	it("a planned write parks behind an approval card: approval row + requires_approval run", async () => {
		const db = createKernelRuntimeDb();
		const { planner, result } = await enqueueWriteProposalTurn(db);

		expect(planner).toHaveBeenCalledTimes(1);
		expect(planner.mock.calls[0]?.[0]).toMatchObject({
			organizationId: ORG_ID,
			route: { routeKind: "propose_tool_write" },
			content: "create a globex invoice over 100 euros for ACME",
		});

		// The run is parked, not completed — nothing executed.
		expect(result.status).toBe("requires_approval");
		expect(result.run.status).toBe("requires_approval");
		expect(result.run.completedAt).toBeNull();

		// One approval row, deterministic uuid-shaped id, exact stored payload.
		expect(db.approvals).toHaveLength(1);
		const approval = db.approvals[0];
		expect(approval?.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(approval?.status).toBe("pending");
		expect(approval?.actionType).toBe("home.tool_write");
		expect(approval?.description).toBe("Create invoice — amount: 100");
		expect(result.run.metadata?.kernelWriteProposal).toMatchObject({
			summary: approval?.description,
		});
		// FK anchor only — true attribution lives in the payload.
		expect(approval?.tediId).toBe("tedi-cpo");
		expect(approval?.payload).toEqual({
			kind: "home_tool_write",
			appSlug: "globex-tedix",
			toolName: "globex__create_invoice",
			args: { amount: 100, customerName: "ACME" },
			organizationId: ORG_ID,
			homeRunId: "home-write-1",
			conversationId: "home:write",
			initiatedByUserId: null,
			riskTier: "low",
		});
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "kernel",
				actorType: "kernel",
				action: "approval.requested",
				resourceType: "approval_request",
				resourceId: approval?.id,
				metadata: expect.objectContaining({
					source: "kernelRuntime.proposeToolWrite",
					actionType: "home.tool_write",
					homeRunId: "home-write-1",
					conversationId: "home:write",
					appSlug: "globex-tedix",
					toolName: "globex__create_invoice",
				}),
			}),
		);

		// Run metadata carries the approval link + the proposed call.
		expect(result.run.metadata).toMatchObject({
			approvalRequestId: approval?.id,
			kernelWriteProposal: {
				appSlug: "globex-tedix",
				toolName: "globex__create_invoice",
				args: { amount: 100, customerName: "ACME" },
			},
			kernelRoute: { routeKind: "propose_tool_write" },
		});

		// Card text names the tool, the target app, and the exact arguments.
		expect(result.assistantMessage?.content).toContain(
			"globex__create_invoice",
		);
		expect(result.assistantMessage?.content).toContain("globex-tedix");
		expect(result.assistantMessage?.content).toContain('"amount":100');
		expect(result.assistantMessage?.content).toContain(
			"Nothing has been executed",
		);

		// approval.requested replaces the terminal run event.
		expect(
			db.events.some(
				(event) =>
					event.kind === "approval.requested" && event.runId === "home-write-1",
			),
		).toBe(true);
		expect(
			db.events.some(
				(event) =>
					event.kind === "run.completed" && event.runId === "home-write-1",
			),
		).toBe(false);
	});

	it.each(["approver-sub", "policy"])(
		"passes the approving human from the resolved approval (%s)",
		async (resolvedBy) => {
			const db = createKernelRuntimeDb();
			const { context } = await enqueueWriteProposalTurn(db);
			const executor = vi.fn(async () => ({
				ok: true as const,
				data: { ok: true },
			}));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);
			withInitiatorMember(db, { role: "member", status: "active" });
			const approval = db.approvals[0];
			if (!approval) throw new Error("approval row missing");
			await settleHomeToolWriteApproval(context, {
				approval: {
					...approval,
					status: "approved",
					resolvedBy,
					payload: {
						...(approval.payload as Record<string, unknown>),
						initiatedByUserId: "initiator-sub",
					},
				},
				status: "approved",
			});
			expect(executor).toHaveBeenCalledWith(
				expect.objectContaining({
					approvedWorkResponderUserId:
						resolvedBy === "policy" ? "initiator-sub" : "approver-sub",
				}),
			);
		},
	);

	it("executes an admin-approved write as the initiator, not the approver", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(db, "home-write-as");
		const executor = vi.fn(async () => ({
			ok: true as const,
			data: { ok: true },
		}));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);
		const findMember = withInitiatorMember(db, {
			role: "member",
			status: "active",
		});
		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		// The approver is an admin resolving from their own session.
		await settleHomeToolWriteApproval(
			{
				...context,
				authType: "user",
				user: { sub: "admin-approver" },
				userRole: "admin",
			} as unknown as BaseContext,
			{
				approval: {
					...approval,
					status: "approved",
					resolvedBy: "admin-approver",
					payload: {
						...(approval.payload as Record<string, unknown>),
						initiatedByUserId: "initiator-sub",
					},
				},
				status: "approved",
			},
		);
		expect(findMember).toHaveBeenCalledWith({
			where: { organizationId: ORG_ID, descopeUserId: "initiator-sub" },
		});
		expect(executor).toHaveBeenCalledOnce();
		expect(executor.mock.calls[0]?.[0]).toMatchObject({
			payload: { initiatedByUserId: "initiator-sub" },
		});
		expect(db.runs.find((row) => row.id === "home-write-as")?.status).toBe(
			"completed",
		);
	});

	it.each([
		["removed from the organization", undefined],
		["suspended", { role: "member", status: "suspended" }],
		["downgraded to viewer", { role: "viewer", status: "active" }],
	])(
		"never executes an approved write once the initiator was %s",
		async (_label, member) => {
			const db = createKernelRuntimeDb();
			const { context } = await enqueueWriteProposalTurn(
				db,
				"home-write-revoked",
			);
			const executor = vi.fn(async () => ({
				ok: true as const,
				data: { ok: true },
			}));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);
			withInitiatorMember(db, member);
			const approval = db.approvals[0];
			if (!approval) throw new Error("approval row missing");
			await expect(
				settleHomeToolWriteApproval(context, {
					approval: {
						...approval,
						status: "approved",
						resolvedBy: "admin-approver",
						payload: {
							...(approval.payload as Record<string, unknown>),
							initiatedByUserId: "initiator-sub",
						},
					},
					status: "approved",
				}),
			).resolves.toBe("closed");
			expect(executor).not.toHaveBeenCalled();
			const run = db.runs.find((row) => row.id === "home-write-revoked");
			expect(run?.status).toBe("canceled");
			expect(run?.metadata).toMatchObject({
				approvalStatus: "initiator_revoked",
			});
			expect(run?.metadata).not.toHaveProperty("kernelWriteExecutedAt");
		},
	);

	it("executes for an initiator whose Home access comes from a member grant", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(db, "home-write-grant");
		const executor = vi.fn(async () => ({
			ok: true as const,
			data: { ok: true },
		}));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);
		withInitiatorMember(db, {
			role: "viewer",
			status: "active",
			customPermissions: ["os:run"],
		});
		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		await settleHomeToolWriteApproval(context, {
			approval: {
				...approval,
				status: "approved",
				payload: {
					...(approval.payload as Record<string, unknown>),
					initiatedByUserId: "initiator-sub",
				},
			},
			status: "approved",
		});
		expect(executor).toHaveBeenCalledOnce();
	});

	it("approve executes the STORED call exactly once and records evidence + transcript", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(db);
		const executor = vi.fn(async () => ({
			ok: true as const,
			data: { result: { id: "INV-1", status: "draft" } },
		}));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "approved" },
			status: "approved",
		});

		expect(executor).toHaveBeenCalledTimes(1);
		// The executor receives only the server-stored payload.
		expect(executor.mock.calls[0]?.[0]).toMatchObject({
			payload: {
				kind: "home_tool_write",
				appSlug: "globex-tedix",
				toolName: "globex__create_invoice",
				args: { amount: 100, customerName: "ACME" },
				homeRunId: "home-write-1",
			},
		});

		const run = db.runs.find((row) => row.id === "home-write-1");
		expect(run?.status).toBe("completed");
		expect(run?.metadata).toMatchObject({
			kernelWriteExecutedAt: expect.any(String),
			kernelWriteExecutionId: "INV-1",
			kernelEvidence: {
				appSlug: "globex-tedix",
				toolName: "globex__create_invoice",
				data: { result: { id: "INV-1", status: "draft" } },
			},
		});

		const transcript = db.events.find(
			(event) =>
				event.kind === "message.completed" &&
				event.messageId === "home-write-1:home-write:assistant",
		);
		expect(
			(transcript?.payload as { content?: string } | null)?.content,
		).toContain("Executed globex__create_invoice on globex-tedix");
		expect(
			(
				transcript?.payload as {
					metadata?: { kernelWriteExecutionId?: string };
				} | null
			)?.metadata?.kernelWriteExecutionId,
		).toBe("INV-1");
		expect(
			db.events.some(
				(event) =>
					event.kind === "run.completed" && event.runId === "home-write-1",
			),
		).toBe(true);

		// Idempotency: a re-settle never re-executes.
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "approved" },
			status: "approved",
		});
		expect(executor).toHaveBeenCalledTimes(1);
	});

	it("keeps the durable retained-result handle when event append fails and never redispatches", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(
			db,
			"home-write-append-fail",
		);
		const executor = vi.fn(async () => ({
			ok: true as const,
			data: { result: { id: "INV-DURABLE" } },
		}));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);
		const reference = {
			id: "f84355c3-e163-47d2-8097-d3d295e78169",
			sha256: "a".repeat(64),
			byteSize: 128,
			expiresAt: "2026-09-23T00:00:00.000Z",
		};
		setKernelToolResultRetainerForTest(async () => reference);
		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		db.controls.kernelEventInsertError = new Error("event append unavailable");

		await expect(
			settleHomeToolWriteApproval(context, {
				approval: { ...approval, status: "approved" },
				status: "approved",
			}),
		).resolves.toBe("unknown");

		expect(
			db.runs.find((row) => row.id === "home-write-append-fail"),
		).toMatchObject({
			status: "completed",
			metadata: { kernelToolResultReference: reference },
		});
		db.controls.kernelEventInsertError = null;
		await expect(
			settleHomeToolWriteApproval(context, {
				approval: { ...approval, status: "approved" },
				status: "approved",
			}),
		).resolves.toBe("unknown");
		expect(executor).toHaveBeenCalledOnce();
	});

	it("reject NEVER executes and closes the run as canceled", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(db, "home-write-2");
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "rejected" },
			status: "rejected",
		});

		expect(executor).not.toHaveBeenCalled();
		const run = db.runs.find((row) => row.id === "home-write-2");
		expect(run?.status).toBe("canceled");
		const transcript = db.events.find(
			(event) =>
				event.kind === "message.completed" &&
				event.messageId === "home-write-2:home-write:assistant",
		);
		expect(
			(transcript?.payload as { content?: string } | null)?.content,
		).toContain("rejected — nothing was executed");
		expect(
			db.events.some(
				(event) =>
					event.kind === "run.canceled" && event.runId === "home-write-2",
			),
		).toBe(true);

		// A late approve after the rejection settle cannot execute either
		// (the run already left requires_approval).
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "approved" },
			status: "approved",
		});
		expect(executor).not.toHaveBeenCalled();
	});

	it.each(["Approve it.", "approve", "yes"])(
		"a bare '%s' reply resolves the parked card once instead of proposing a second write",
		async (content) => {
			const db = createKernelRuntimeDb();
			const { client, planner } = await enqueueWriteProposalTurn(
				db,
				"home-write-chat",
			);
			const executor = vi.fn(async () => ({
				ok: true as const,
				data: { result: { id: "INV-9" } },
			}));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
				executor as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
				>[0],
			);

			const reply = await client.enqueueMessage({
				conversationId: "home:write",
				content,
				idempotencyKey: "home-write-chat-reply",
			});

			expect(executor).toHaveBeenCalledTimes(1);
			expect(planner).toHaveBeenCalledTimes(1);
			expect(db.approvals).toHaveLength(1);
			expect(db.approvals[0]?.status).toBe("approved");
			expect(db.runs.find((row) => row.id === "home-write-chat")?.status).toBe(
				"completed",
			);
			expect(reply.run.status).toBe("completed");
			expect(reply.assistantMessage?.content).toBe(
				"Approved and ran `globex__create_invoice`.",
			);
		},
	);
	it.each(["approve", "reject"])(
		"a member chat reply cannot %s a parked write",
		async (content) => {
			const db = createKernelRuntimeDb();
			await enqueueWriteProposalTurn(db, "member-control-test");
			const executor = vi.fn();
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);
			const client = createKernelRuntimeClient({
				...createContext(db, { userSub: "member-1" }),
				authType: "user",
				apiKey: undefined,
				userRole: "member",
			});
			const result = await client.enqueueMessage({
				conversationId: "home:write",
				content,
				idempotencyKey: `member-control-${content}`,
			});
			expect(db.approvals[0]?.status).toBe("pending");
			expect(executor).not.toHaveBeenCalled();
			expect(result.status).toBe("failed");
			expect(result.assistantMessage?.content).toContain("os:approve");
		},
	);
	it.each(["admin", "owner"] as const)(
		"an active %s retains chat approval control",
		async (userRole) => {
			const db = createKernelRuntimeDb();
			await enqueueWriteProposalTurn(db, "operator-control-test");
			const executor = vi.fn(async () => ({
				ok: true as const,
				data: { result: { id: "INV-CONTROL" } },
			}));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);
			const client = createKernelRuntimeClient({
				...createContext(db, { userSub: "operator-1" }),
				authType: "user",
				apiKey: undefined,
				userRole,
			});
			await client.enqueueMessage({
				conversationId: "home:write",
				content: "approve",
				idempotencyKey: `operator-control-${userRole}`,
			});
			expect(db.approvals[0]?.status).toBe("approved");
			expect(executor).toHaveBeenCalledTimes(1);
		},
	);

	it("a later bare 'reject' still answers the parked card after another turn", async () => {
		const db = createKernelRuntimeDb();
		const { client } = await enqueueWriteProposalTurn(db, "home-write-later");
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "It is still waiting for you.",
				route: {
					routeKind: "answer_in_home" as const,
					rationale: "Status question.",
					risk: "low" as const,
					confidence: 0.9,
					answer: "It is still waiting for you.",
				},
			})),
		);
		await client.enqueueMessage({
			conversationId: "home:write",
			content: "what is it waiting for",
			idempotencyKey: "home-write-later-question",
		});

		const reply = await client.enqueueMessage({
			conversationId: "home:write",
			content: "reject",
			idempotencyKey: "home-write-later-reply",
		});

		expect(executor).not.toHaveBeenCalled();
		expect(db.approvals[0]?.status).toBe("rejected");
		expect(reply.assistantMessage?.content).toBe(
			"Rejected `globex__create_invoice`. Nothing ran.",
		);
	});

	// Trusted-write tier (plan item #2) — the audit row is always created; a
	// trusted/low-risk write is just auto-resolved (resolvedBy:'policy') through
	// the same latch instead of parking behind a human card.
	function trustedPolicyDb(trustedTools: string[]) {
		return createKernelRuntimeDb({
			policyPackRows: [
				{ definition: { governancePolicy: { writeTier: { trustedTools } } } },
			],
		});
	}

	// Exact tool keys from the v4 low-risk write tier.
	const v4SafeTools = [
		"create_os_workspace",
		"update_os_workspace",
		"create_os_workspace_resource",
		"rename_os_workspace_resource",
		"create_os_output",
		"revise_os_output",
		"rename_os_output",
		"patch_os_document",
		"patch_os_slides",
		"set_os_sheet_range",
		// Reversible workspace management under the platform default
		// (organization-autonomy.v1.json); permanent deletes stay gated below.
		"archive_os_workspace",
		"archive_os_output",
	].map((name) => `os.${name}`);
	const v4TrustedTools = ["tedix", "tedix-unified"].flatMap((slug) =>
		v4SafeTools.map((tool) => `${slug}:${tool}`),
	);
	const v4GatedTools = [
		"os.delete_os_output",
		"os.delete_os_workspace_resource",
		"os.create_os_share_link",
		"billing.configure_credit_billing",
		"billing.create_billing_portal_session",
		"messaging.send_message",
		"work.respond_work_interaction",
		"os.create_os_approval_rule",
		"os.set_os_approval_rule_enabled",
		"os.apply_os_approval_rules",
		"os.delete_os_approval_rule",
		"os.create_os_output_extra",
	];
	it.each(
		["tedix", "tedix-unified"].flatMap((appSlug) => [
			...v4SafeTools.map((toolName) => ({ appSlug, toolName, allowed: true })),
			...v4GatedTools.map((toolName) => ({
				appSlug,
				toolName,
				allowed: false,
			})),
		]),
	)(
		"v4 policy $appSlug:$toolName auto-approves=$allowed",
		async ({ appSlug, toolName, allowed }) => {
			const db = trustedPolicyDb(v4TrustedTools);
			const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);
			// Deliberately classify even gated tools as low: only exact allowlist
			// membership may authorize them, independent of planner risk labels.
			const { result } = await enqueueWriteProposalTurn(db, "v4-write", {
				...PROPOSAL,
				appSlug,
				toolName,
			});
			expect(db.approvals).toHaveLength(1);
			expect(db.approvals[0]).toMatchObject({
				status: allowed ? "approved" : "pending",
				resolvedBy: allowed ? "policy" : null,
			});
			expect(executor).toHaveBeenCalledTimes(allowed ? 1 : 0);
			expect(result.status).toBe(allowed ? "completed" : "requires_approval");
			if (allowed) {
				expect(executor.mock.calls[0]?.[0]).toMatchObject({
					approvedWorkResponderUserId: undefined,
				});
			}
		},
	);

	it.each([
		{ policyPackRows: [], allowed: true },
		{
			policyPackRows: [
				{ definition: { governancePolicy: { autonomy: false } } },
			],
			allowed: false,
		},
	])(
		"a Work-item create with no trusted list runs under the platform default (opt-out: $allowed)",
		async ({ policyPackRows, allowed }) => {
			const db = createKernelRuntimeDb({ policyPackRows });
			const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);
			const { result } = await enqueueWriteProposalTurn(db, "platform-work", {
				...PROPOSAL,
				appSlug: "tedix-unified",
				toolName: "work.create_work_items",
				args: { title: "Follow up", projectId: "project-1" } as never,
			});
			// The approval row is the audit record either way.
			expect(db.approvals).toHaveLength(1);
			expect(db.approvals[0]).toMatchObject({
				status: allowed ? "approved" : "pending",
				resolvedBy: allowed ? "policy" : null,
			});
			expect(executor).toHaveBeenCalledTimes(allowed ? 1 : 0);
			expect(result.status).toBe(allowed ? "completed" : "requires_approval");
		},
	);

	it("(a) low-risk trusted write auto-resolves WITH an audit row + resolvedBy:'policy' and executes", async () => {
		const db = trustedPolicyDb(["globex-tedix:globex__create_invoice"]);
		const executor = vi.fn(async () => {
			expect(
				db.auditRows.some((row) => row.action === "approval.approved"),
			).toBe(true);
			expect(db.runs.find((row) => row.id === "home-write-1")?.status).toBe(
				"running",
			);
			expect(
				db.events.some(
					(row) =>
						row.runId === "home-write-1" && row.kind === "approval.requested",
				),
			).toBe(false);
			return { ok: true as const, data: { result: { id: "INV-AUTO" } } };
		});
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const { result } = await enqueueWriteProposalTurn(db);

		// The audit row is still created — and auto-resolved by policy.
		expect(db.approvals).toHaveLength(1);
		const approval = db.approvals[0];
		expect(approval?.status).toBe("approved");
		expect(approval?.resolvedBy).toBe("policy");

		// Both audit events: the request and the policy-attributed approval.
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "approval.requested",
				resourceId: approval?.id,
			}),
		);
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "policy",
				action: "approval.approved",
				resourceId: approval?.id,
				metadata: expect.objectContaining({
					source: "kernelRuntime.autoResolveKernelWrite",
					resolverProvenance: "policy",
					autoResolveSource: "policy",
				}),
			}),
		);

		expect(result.assistantMessage.content).toContain(
			"Executed globex__create_invoice",
		);
		expect(result.assistantMessage.id).toBe(
			"home-write-1:home-write:assistant",
		);
		// The per-click tax is removed: the stored call executed in-turn.
		expect(executor).toHaveBeenCalledTimes(1);
		expect(db.approvalExecutionReceipts).toHaveLength(1);
		const run = db.runs.find((row) => row.id === "home-write-1");
		expect(run?.status).toBe("completed");
		expect(run?.outputMessageId).toBe(result.assistantMessage.id);
		expect(result.run.metadata).toMatchObject({
			kernelWriteApproval: {
				autoResolve: true,
				source: "policy",
				willAutoResolve: true,
			},
		});
	});

	it("never executes a policy-approved write whose approval audit row failed", async () => {
		const db = trustedPolicyDb(["globex-tedix:globex__create_invoice"]);
		db.controls.auditInsertErrorAction = "approval.approved";
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);

		const { result } = await enqueueWriteProposalTurn(db);

		expect(executor).not.toHaveBeenCalled();
		expect(result.status).toBe("requires_approval");
		expect(db.runs.find((row) => row.id === "home-write-1")).toMatchObject({
			status: "requires_approval",
		});
		expect(
			db.runs.find((row) => row.id === "home-write-1")?.metadata,
		).not.toHaveProperty("kernelWriteExecutedAt");
	});

	it("returns the canonical document receipt after a policy-approved write", async () => {
		const db = trustedPolicyDb(["fictional-os:os.create_os_output"]);
		const outputId = "7c0723ef-fed7-4482-9454-4716ddfd5879";
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(async () => ({
			ok: true as const,
			data: {
				output: { id: outputId, kind: "document", title: "Receipt check" },
			},
		}));
		const { result, client } = await enqueueWriteProposalTurn(
			db,
			"home-write-doc",
			{
				...PROPOSAL,
				appSlug: "fictional-os",
				toolName: "os.create_os_output",
				args: { amount: 100, customerName: "ACME" },
			},
		);
		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage.content).toBe(
			`Saved your document. [Open document](/outputs/${outputId}).`,
		);
		const receipt = db.events.find(
			(event) => event.messageId === result.assistantMessage.id,
		);
		expect(result.assistantMessage.content).toBe(receipt?.payload?.content);
		expect(result.status).toBe("completed");
		const read = await client.readRun({ runId: result.run.id });
		expect(read.run.metadata.kernelRoute).toMatchObject({
			answer: result.assistantMessage.content,
		});
	});

	it("(b) a non-trusted write still parks behind a human gate (no auto-resolve, no execution)", async () => {
		const db = trustedPolicyDb(["other-app:create_thing"]);
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const { result } = await enqueueWriteProposalTurn(db);

		expect(result.status).toBe("requires_approval");
		expect(result.run.status).toBe("requires_approval");
		expect(result.assistantMessage.content).toContain(
			"Nothing has been executed. Reply “approve” or “yes” to proceed",
		);
		expect(result.assistantMessage.content).not.toContain("Executed");
		expect(db.approvals[0]?.status).toBe("pending");
		expect(db.approvals[0]?.resolvedBy).toBeNull();
		expect(executor).not.toHaveBeenCalled();
		expect(db.auditRows.some((row) => row.action === "approval.approved")).toBe(
			false,
		);
	});

	it.each(["member", "admin", "owner"] as const)(
		"session pre-authorization retains its control guard for %s",
		async (role) => {
			const db = createKernelRuntimeDb();
			// Operator pre-authorized this tool for the conversation via a prior run's
			// session allowlist — no org policy at all.
			db.runs.push({
				id: "seed-grant",
				organizationId: ORG_ID,
				conversationId: "home:write",
				createdAt: "2020-01-01T00:00:00.000Z",
				metadata: {
					sessionWriteAllowlist: ["globex-tedix:globex__create_invoice"],
				},
			} as unknown as KernelRuntimeRunRow);
			const executor = vi.fn(async () => ({
				ok: true as const,
				data: { result: { id: "INV-SESSION" } },
			}));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
				executor as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
				>[0],
			);

			const context = {
				...createContext(db, { userSub: "operator-1" }),
				authType: "user" as const,
				apiKey: undefined,
				userRole: role,
			};
			const { result } = await enqueueWriteProposalTurn(
				db,
				"home-write-1",
				PROPOSAL,
				context,
			);
			if (role === "member") {
				expect(db.approvals[0]?.status).toBe("pending");
				expect(executor).not.toHaveBeenCalled();
				expect(result.status).toBe("requires_approval");
				return;
			}
			expect(db.approvals[0]?.status).toBe("approved");
			expect(db.approvals[0]?.resolvedBy).toBe("policy");
			expect(executor).toHaveBeenCalledTimes(1);
			expect(result.run.metadata).toMatchObject({
				kernelWriteApproval: { autoResolve: true, source: "session" },
			});
		},
	);

	it("(d) fail-closed default: no policy + no session => human gate, no approval.approved", async () => {
		const db = createKernelRuntimeDb();
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const { result } = await enqueueWriteProposalTurn(db);

		expect(result.status).toBe("requires_approval");
		expect(db.approvals[0]?.status).toBe("pending");
		expect(executor).not.toHaveBeenCalled();
		expect(db.auditRows.some((row) => row.action === "approval.approved")).toBe(
			false,
		);
		expect(result.run.metadata).toMatchObject({
			kernelWriteApproval: { autoResolve: false, willAutoResolve: false },
		});
	});

	it("records a failed direct policy write with its execution receipt", async () => {
		const db = trustedPolicyDb(["globex-tedix:globex__create_invoice"]);
		const executor = vi.fn(async () => ({
			ok: false as const,
			error: "Provider rejected the payload",
		}));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(executor);
		const { result } = await enqueueWriteProposalTurn(db);
		expect(result.status).toBe("failed");
		expect(result.assistantMessage.content).toContain(
			"Provider rejected the payload",
		);
		expect(db.approvalExecutionReceipts).toHaveLength(1);
		expect(db.approvalExecutionReceipts[0]).toMatchObject({
			outcome: "failed",
			observedError: { code: "provider_write_failed" },
		});
		expect(db.events.some((row) => row.kind === "approval.requested")).toBe(
			false,
		);
		expect(db.events.some((row) => row.kind === "run.failed")).toBe(true);
		expect(executor).toHaveBeenCalledTimes(1);
	});

	it("a failed approved write lands as run.failed with the bounded upstream error", async () => {
		const db = createKernelRuntimeDb();
		const { context } = await enqueueWriteProposalTurn(db, "home-write-3");
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			vi.fn(async () => ({
				ok: false as const,
				error: "Provider rejected the invoice payload",
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const approval = db.approvals[0];
		if (!approval) throw new Error("approval row missing");
		await settleHomeToolWriteApproval(context, {
			approval: { ...approval, status: "approved" },
			status: "approved",
		});

		const run = db.runs.find((row) => row.id === "home-write-3");
		expect(run?.status).toBe("failed");
		expect(run?.metadata).toMatchObject({
			kernelWriteError: "Provider rejected the invoice payload",
		});
		expect(
			db.events.some(
				(event) =>
					event.kind === "run.failed" && event.runId === "home-write-3",
			),
		).toBe(true);
	});

	it("planner failure falls back to the recommendation text (no approval, run completed)", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		stubWriteKernel();
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			vi.fn(async () => null),
		);

		const result = await client.enqueueMessage({
			conversationId: "home:write",
			content: "create a globex invoice",
			idempotencyKey: "home-write-fallback-1",
		});

		expect(result.status).toBe("needs_delegation");
		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage?.content).toBe("RECOMMEND:write");
		expect(db.approvals).toHaveLength(0);
		expect(result.run.metadata).toMatchObject({
			kernelRoute: { routeKind: "propose_tool_write" },
		});
		expect(
			(result.run.metadata as Record<string, unknown>).kernelWriteProposal,
		).toBeUndefined();
	});

	it("a declined proposal survives into the persisted run row (kernelWriteProposalDeclined)", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		stubWriteKernel();
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			vi.fn(
				async (args: {
					onDecline?: (declined: { stage: string; detail?: string }) => void;
				}) => {
					args.onDecline?.({
						stage: "planner_declined",
						detail: "test-detail",
					});
					return null;
				},
			) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:write",
			content: "create a globex invoice",
			idempotencyKey: "home-write-declined-1",
		});

		// Declined-write honesty: the operator sees an honest per-stage message,
		// not the planner's optimistic "Confirm and I'll prepare it for approval"
		// text — the write moat held and nothing was created or sent.
		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage?.content).toContain(
			"nothing was created or sent",
		);
		expect(result.assistantMessage?.content).not.toContain(
			"globex.invoices.create",
		);
		expect(result.assistantMessage?.content).toContain("globex");
		expect(result.assistantMessage?.content).not.toContain(
			"Confirm and I'll prepare it for approval",
		);
		expect(db.approvals).toHaveLength(0);

		// Fail-soft is not fail-silent: the decline reason survives the
		// turn-work metadata merge into the persisted run row, so the why is
		// diagnosable from readRun alone (no log tails).
		const read = await client.readRun({ runId: "home-write-declined-1" });
		expect(read.run.status).toBe("completed");
		expect(read.run.metadata).toMatchObject({
			kernelWriteProposalDeclined: {
				stage: "planner_declined",
				detail: "test-detail",
			},
			kernelRoute: { routeKind: "propose_tool_write" },
		});
		const metadata = read.run.metadata as Record<string, unknown>;
		// approvalRequestId is a baseline run-row field (null when no approval
		// was created); the write-proposal card fields never appear.
		expect(metadata.approvalRequestId).toBeNull();
		expect(metadata.kernelWriteProposal).toBeUndefined();
	});

	it('a planner crash persists stage "error" into the run row metadata', async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		stubWriteKernel();
		kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest(
			vi.fn(async () => {
				throw new Error("planner exploded");
			}) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteProposalPlannerForTest
			>[0],
		);

		const result = await client.enqueueMessage({
			conversationId: "home:write",
			content: "create a globex invoice",
			idempotencyKey: "home-write-declined-2",
		});

		// Declined-write honesty: planner crash → honest "nothing was created or
		// sent" message, not the optimistic planner text.
		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage?.content).toContain(
			"nothing was created or sent",
		);
		expect(result.assistantMessage?.content).toContain("globex");
		expect(result.assistantMessage?.content).not.toContain(
			"Confirm and I'll prepare it for approval",
		);
		expect(db.approvals).toHaveLength(0);

		const read = await client.readRun({ runId: "home-write-declined-2" });
		expect(read.run.metadata).toMatchObject({
			kernelWriteProposalDeclined: {
				stage: "error",
				detail: expect.stringContaining("planner exploded"),
			},
		});
	});

	it("a delegate_tedi delegation verdict survives into the persisted run row (homeDelegation)", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		// Kernel stub: a delegate_tedi route that resolved a carded target →
		// KernelResult.delegation carries the work order + the fail-closed
		// dispatch verdict. Typed via the real KernelResult so a shape drift
		// in HomeDelegationEvidence/DelegationWorkOrder/DispatchDecision breaks
		// this test.
		const delegation: NonNullable<KernelResult["delegation"]> = {
			workOrder: {
				objective: "Review the product roadmap priorities for the operator.",
				executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
				outputContract: "A short summary of the top 3 priorities.",
				toolGuidance: ['Use your "mcp:apps" scope group for this work.'],
				boundaries: ["Do not exceed your assigned scopes."],
				sourceContent: "Have the CPO review our roadmap.",
				targetTediId: "tedi-cpo",
				targetTediLabel: "CPO",
			},
			decision: {
				canAutoDispatch: false,
				mode: "needs_approval",
				reason: "target not active",
			},
		};
		const route: KernelRouteDecision = {
			routeKind: "delegate_tedi",
			rationale: "CPO owns product roadmap",
			risk: "low",
			confidence: 0.9,
			effortClass: null,
			answer: null,
			targetTediId: "tedi-cpo",
			targetTediLabel: "CPO",
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		};
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "CPO owns this — want me to set up the hand-off?",
				route,
				delegation,
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:deleg",
			content: "Have the CPO review our roadmap.",
			idempotencyKey: "home-deleg-1",
		});

		// The verdict + work order survive the turn-work metadata merge into the
		// persisted run row — diagnosable from readRun alone (proven live, now
		// pinned: a regression in the metadata spread can't silently drop it).
		const read = await client.readRun({ runId: "home-deleg-1" });
		expect(read.run.metadata).toMatchObject({
			kernelRoute: { routeKind: "delegate_tedi" },
			homeDelegation: {
				decision: { mode: "needs_approval", reason: "target not active" },
				workOrder: { targetTediLabel: "CPO" },
			},
		});
	});

	it("a non-delegation turn persists homeDelegation: null", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "42 active work items.",
				route: {
					routeKind: "answer_in_home" as const,
					rationale: "answerable from context",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "single_read" as const,
					answer: "42 active work items.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:answer",
			content: "how many active work items?",
			idempotencyKey: "home-answer-1",
		});

		const read = await client.readRun({ runId: "home-answer-1" });
		// `?? null` default: not spuriously set on non-delegation turns.
		expect(
			(read.run.metadata as Record<string, unknown>).homeDelegation,
		).toBeNull();
	});

	it("records explicit kernel correction metadata and a decision event", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "Captured.",
				route: {
					routeKind: "answer_in_home" as const,
					rationale: "answerable from Home context",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "single_read" as const,
					answer: "Captured.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:correction",
			content: "answer this in Home",
			idempotencyKey: "home-correction-prior",
		});
		await client.enqueueMessage({
			conversationId: "home:correction",
			content: "actually correct that route",
			idempotencyKey: "home-correction-current",
			metadata: {
				correctionOf: "home-correction-prior",
				correctionSignal: "explicit_user_action",
				operatorNote: "wrong route",
			},
		});

		const read = await client.readRun({
			runId: "home-correction-current",
		});
		expect(read.run.metadata).toMatchObject({
			kernelCorrection: {
				action: "kernel.route_corrected",
				correctionSignal: "explicit_user_action",
				operatorNote: "wrong route",
				priorRouteKind: "answer_in_home",
				priorRunFound: true,
				priorRunId: "home-correction-prior",
				priorRunStatus: "completed",
				source: "kernelRuntime.enqueueMessage",
			},
			kernelRoute: { routeKind: "answer_in_home" },
		});
		const decisionEvent = db.events.find(
			(event) =>
				event.kind === "decision.recorded" &&
				event.runId === "home-correction-current",
		);
		expect(decisionEvent?.payload).toMatchObject({
			action: "kernel.route_corrected",
			priorRunFound: true,
			priorRunId: "home-correction-prior",
		});
		expect(decisionEvent?.runtimeMetadata).toMatchObject({
			priorRunFound: true,
			priorRunId: "home-correction-prior",
			signal: "kernel.route_corrected",
			source: "kernelRuntime.enqueueMessage",
		});
	});

	it("records correction attempts when the prior run is not found", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "Captured.",
				route: {
					routeKind: "answer_in_home" as const,
					rationale: "answerable from Home context",
					risk: "low" as const,
					confidence: 0.95,
					effortClass: "single_read" as const,
					answer: "Captured.",
					targetTediId: null,
					targetTediLabel: null,
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);

		await client.enqueueMessage({
			conversationId: "home:correction",
			content: "correct a missing prior run",
			idempotencyKey: "home-correction-missing",
			metadata: {
				correction: { runId: "home-correction-missing-prior" },
				correctionNote: "prior run was outside this org or absent",
			},
		});

		const read = await client.readRun({
			runId: "home-correction-missing",
		});
		expect(read.run.metadata).toMatchObject({
			kernelCorrection: {
				action: "kernel.route_corrected",
				correctionSignal: "explicit_caller_metadata",
				operatorNote: "prior run was outside this org or absent",
				priorRouteKind: null,
				priorRunFound: false,
				priorRunId: "home-correction-missing-prior",
				priorRunStatus: null,
			},
		});
		const decisionEvent = db.events.find(
			(event) =>
				event.kind === "decision.recorded" &&
				event.runId === "home-correction-missing",
		);
		expect(decisionEvent?.payload).toMatchObject({
			priorRunFound: false,
			priorRunId: "home-correction-missing-prior",
		});
	});

	it("settle is a no-op for non home_tool_write approval payloads", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);
		await settleHomeToolWriteApproval(context, {
			approval: {
				id: "approval-other",
				tediId: "tedi-cto",
				orgId: ORG_ID,
				actionType: "workstation.attach",
				description: "x",
				payload: { source: "home.workstation_attach" },
				status: "approved",
				createdAt: "2026-06-10T08:00:00.000Z",
				expiresAt: "2026-06-11T08:00:00.000Z",
				resolvedAt: null,
				resolvedBy: null,
				resolution: null,
				workflowId: null,
			},
			status: "approved",
		});
		expect(executor).not.toHaveBeenCalled();
		expect(db.runs).toHaveLength(0);
	});

	describe("respondApproval — THE Home approval surface", () => {
		it("reuses a partially committed delegation Work Item by child-run intent", async () => {
			const db = createKernelRuntimeDb();
			const childRunId = "tedi-cpo:mcp:home-deleg-recovery_approved_tedi-cpo";
			const workItemId = "wi-partial-delegation";
			db.workItemRows.push(
				normalizeWorkItemInsert({
					id: workItemId,
					orgId: ORG_ID,
					title: "Partially committed delegation",
					disposition: "accepted",
					accountableOwnerType: "tedi",
					accountableOwnerId: "tedi-cpo",
					sourceIntentId: childRunId,
					sourceSessionKey: "home:recovery",
					workClass: "maintenance",
					purposeExceptionExpiresAt: "2099-01-01T00:00:00.000Z",
					createdAt: "2026-08-26T21:43:20.028Z",
				}),
			);
			db.workAttemptRows.push({
				...runningWorkAttempt(workItemId, "tedi-cpo", childRunId),
				runtimeState: "expired",
				outcome: "expired",
				expiresAt: "2026-08-26T21:48:20.028Z",
				finishedAt: "2026-08-26T21:50:07.000Z",
			});

			await expect(
				createDelegationWorkItem(createContext(db), {
					assigneeTediId: "tedi-cpo",
					childRunId,
					content: "Complete the approved delegation.",
					conversationId: "home:recovery",
					createdAt: "2026-08-27T01:00:00.000Z",
					executionRequirement: {
						surface: "managed_job",
						requiredCapabilities: ["repository_read"],
						fallbackSurface: "workstation",
						prohibitedSurfaces: [],
						satisfiable: true,
						reason: "test recovery",
					},
					homeRunId: "home-deleg-recovery",
					organizationId: ORG_ID,
				}),
			).resolves.toBe(workItemId);
			expect(db.workItemRows).toHaveLength(1);
			expect(db.workAttemptRows).toHaveLength(2);
		});

		it("refuses a tedi principal on a parked write card", async () => {
			const db = createKernelRuntimeDb();
			await enqueueWriteProposalTurn(db, "home-write-tedi-1");
			const executor = vi.fn(async () => ({
				ok: true as const,
				data: { id: "INV-9", status: "draft" },
			}));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
				executor as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
				>[0],
			);
			// The owning tedi reaches the API through the MCP edge's service
			// binding with its own tedi id: a tedi never decides a Home write.
			const context = createContext(db);
			const tediClient = createKernelRuntimeClient({
				...context,
				apiKey: undefined,
				authType: undefined,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": ORG_ID,
					"X-Tedix-Tedi-Id": "tedi-cpo",
					"X-Tedix-Tedi-Scopes": "tedis:write tedis:read",
				}),
			} as unknown as BaseContext);

			await expect(
				tediClient.respondApproval({
					runId: "home-write-tedi-1",
					decision: "approve",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(executor).not.toHaveBeenCalled();
			expect(db.approvals[0]?.status).toBe("pending");
		});

		it("decision approve on a write card resolves via the canonical latch and executes exactly once", async () => {
			const db = createKernelRuntimeDb();
			const { client } = await enqueueWriteProposalTurn(
				db,
				"home-write-respond-1",
			);
			const executor = vi.fn(async () => ({
				ok: true as const,
				data: { id: "INV-9", status: "draft" },
			}));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
				executor as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
				>[0],
			);

			await expect(
				client.respondApproval({
					runId: "home-write-respond-1",
					decision: "approve",
					delegateRecommendation: true,
				}),
			).rejects.toThrow("must match the current recommendation");
			expect(executor).not.toHaveBeenCalled();
			const result = await client.respondApproval({
				runId: "home-write-respond-1",
				decision: "approve",
				note: "ship it",
			});

			// The same settle seam fired with only the server-stored payload.
			expect(executor).toHaveBeenCalledTimes(1);
			expect(executor.mock.calls[0]?.[0]).toMatchObject({
				payload: {
					kind: "home_tool_write",
					appSlug: "globex-tedix",
					toolName: "globex__create_invoice",
					args: { amount: 100, customerName: "ACME" },
					homeRunId: "home-write-respond-1",
				},
			});

			// Canonical pending→resolved latch on the approval row.
			expect(db.approvals[0]).toMatchObject({
				status: "approved",
				resolvedBy: "apikey",
				resolution: "ship it",
			});
			// Audit parity with tediApprovals.resolve.
			expect(
				db.auditRows.some(
					(row) =>
						row.action === "approval.approved" &&
						row.resourceId === db.approvals[0]?.id,
				),
			).toBe(true);

			expect(result.run.status).toBe("completed");
			expect(result.run.metadata).toMatchObject({
				kernelWriteExecutedAt: expect.any(String),
				kernelWriteExecutionId: "INV-9",
				kernelEvidence: {
					toolName: "globex__create_invoice",
					data: { id: "INV-9", status: "draft" },
				},
			});
			expect(result.assignments).toEqual([]);

			// Exactly-once: a second respond hits the resolved latch, never the
			// executor.
			await expect(
				client.respondApproval({
					runId: "home-write-respond-1",
					decision: "approve",
				}),
			).rejects.toThrow(/already "approved"/);
			expect(executor).toHaveBeenCalledTimes(1);
		});

		it("decision reject on a write card NEVER executes and closes the run as canceled", async () => {
			const db = createKernelRuntimeDb();
			const { client } = await enqueueWriteProposalTurn(
				db,
				"home-write-respond-2",
			);
			const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
			kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
				executor as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
				>[0],
			);

			const result = await client.respondApproval({
				runId: "home-write-respond-2",
				decision: "reject",
				note: "not now",
			});

			expect(executor).not.toHaveBeenCalled();
			expect(db.approvals[0]).toMatchObject({
				status: "rejected",
				resolution: "not now",
			});
			expect(result.run.status).toBe("canceled");
			expect(result.assignments).toEqual([]);
			expect(
				db.events.some(
					(event) =>
						event.kind === "run.canceled" &&
						event.runId === "home-write-respond-2",
				),
			).toBe(true);
			// A late approve cannot resurrect the write.
			await expect(
				client.respondApproval({
					runId: "home-write-respond-2",
					decision: "approve",
				}),
			).rejects.toThrow(/already "rejected"/);
			expect(executor).not.toHaveBeenCalled();
		});

		it("decision reject on a proposed plan keeps the assignment-rejection behavior", async () => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));

			await client.enqueueMessage({
				conversationId: "home:test",
				content:
					"Plan this across CPO and Echo: CPO owns the checklist while Echo validates evidence.",
				idempotencyKey: "home-plan-respond-reject-1",
			});
			const result = await client.respondApproval({
				runId: "home-plan-respond-reject-1",
				decision: "reject",
				delegateRecommendation: true,
				note: "wrong owners",
			});

			expect(result.homePlan?.status).toBe("canceled");
			expect(result.run.status).toBe("canceled");
			expect(result.assignments).toHaveLength(2);
			expect(
				result.assignments.every(
					(assignment) => assignment.status === "canceled",
				),
			).toBe(true);
			expect(db.runs[0]?.metadata).toMatchObject({
				homePlanRejectionNote: expect.stringContaining("Decide for me:"),
			});
		});

		it("decision approve on a proposed plan delegates to the approve_home_plan core (Work Items + dispatch)", async () => {
			const db = createKernelRuntimeDb();
			const context = createContext(db);
			const client = createKernelRuntimeClient(context);
			const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}));
			kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

			await client.enqueueMessage({
				conversationId: "home:test",
				content:
					"Plan this across CPO and Echo: CPO owns the checklist while Echo validates evidence.",
				idempotencyKey: "home-plan-respond-approve-1",
			});
			const result = await client.respondApproval({
				runId: "home-plan-respond-approve-1",
				decision: "approve",
				note: "go",
			});
			await Promise.all(
				(context as BaseContext & { waitUntilPromises: Promise<unknown>[] })
					.waitUntilPromises,
			);

			expect(result.homePlan?.status).toBe("dispatching");
			expect(result.assignments).toHaveLength(2);
			expect(result.assignments.map((assignment) => assignment.status)).toEqual(
				["queued", "queued"],
			);
			expect(db.workItemRows).toHaveLength(2);
			expect(delegateRunner).toHaveBeenCalledTimes(2);
			expect(db.workItemRows[0]?.metadata).toMatchObject({
				approvalNote: "go",
			});
		});

		it.each([
			["approve", false],
			["reject", false],
			["approve", true],
			["reject", true],
		] as const)(
			"chat %s of a held delegation (member=%s) does not replan or duplicate dispatch",
			async (decision, member) => {
				const db = createKernelRuntimeDb();
				const context = createContext(db);
				const client = createKernelRuntimeClient(
					member
						? {
								...context,
								authType: "user",
								apiKey: undefined,
								user: { sub: "member-1" } as BaseContext["user"],
								userRole: "member",
							}
						: context,
				);
				db.runs.push(
					normalizeKernelRuntimeRunInsert({
						id: "held-delegation",
						organizationId: ORG_ID,
						conversationId: "home:test",
						status: "requires_approval",
						metadata: {
							homeDelegation: {
								decision: {
									mode: "needs_approval",
									canAutoDispatch: false,
									reason: "operator explicitly held dispatch for approval",
								},
								workOrder: {
									targetTediId: "tedi-cpo",
									targetTediLabel: "CPO",
									objective: "Review the roadmap",
									executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
									outputContract: "Return a short summary",
									toolGuidance: [],
									boundaries: ["Stay in-org"],
									sourceContent: "Review the roadmap",
									status: "draft",
								},
							},
						},
					}),
				);
				const kernel = vi.fn(
					async () =>
						({
							route: {
								routeKind: "delegate_tedi",
								targetTediId: "tedi-cpo",
								targetTediLabel: "CPO",
								risk: "high",
							},
							assistantContent: "Approve delegation to CPO",
							delegation: db.runs[0]!.metadata!.homeDelegation,
						}) as unknown as KernelResult,
				);
				kernelRuntimeTestHooks.setKernelForTest(kernel);
				const runner = vi.fn(async (input: { childRunId: string }) => ({
					childRunId: input.childRunId,
					status: "queued" as const,
				}));
				kernelRuntimeTestHooks.setDelegateRunnerForTest(runner);
				for (const key of ["follow-up-one", "follow-up-two"]) {
					const followUp = await client.enqueueMessage({
						conversationId: "home:test",
						content: "Please continue with that request",
						idempotencyKey: key,
					});
					expect(followUp.run.status).toBe("completed");
					expect(followUp.run.metadata?.pendingDelegationRunId).toBe(
						"held-delegation",
					);
					expect(
						db.runs.filter((run) => run.status === "requires_approval"),
					).toHaveLength(1);
					expect(runner).not.toHaveBeenCalled();
				}
				kernel.mockClear();
				const result = await client.enqueueMessage({
					conversationId: "home:test",
					content: decision,
					idempotencyKey: "delegation-chat-reply",
				});
				expect(kernel).not.toHaveBeenCalled();
				expect(runner).toHaveBeenCalledTimes(
					!member && decision === "approve" ? 1 : 0,
				);
				expect(db.runs).toHaveLength(4);
				if (member) {
					expect(result.status).toBe("failed");
					expect(
						db.runs.find((run) => run.id === "held-delegation")?.status,
					).toBe("requires_approval");
					expect(result.assistantMessage?.content).toContain("owner or admin");
				} else {
					expect(result.assistantMessage?.content).toContain(
						decision === "approve"
							? "Approved delegation"
							: "Rejected delegation",
					);
					await expect(
						client.respondApproval({
							runId: "held-delegation",
							decision: "approve",
						}),
					).rejects.toThrow();
					expect(runner).toHaveBeenCalledTimes(decision === "approve" ? 1 : 0);
				}
			},
		);

		it("decision approve on a Home delegation recommendation dispatches the target tedi by homeRunId", async () => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const delegateRunner = vi.fn(
				async (input: { childRunId: string; content: string }) => ({
					childConversationId: "agent:main:main",
					childRunId: input.childRunId,
					status: "queued" as const,
				}),
			);
			kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
			kernelRuntimeTestHooks.setKernelForTest(
				vi.fn(async () => ({
					assistantContent: "CPO owns this — want me to set up the hand-off?",
					route: {
						routeKind: "delegate_tedi" as const,
						rationale: "CPO owns product",
						risk: "low" as const,
						confidence: 0.9,
						effortClass: null,
						answer: null,
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
						toolIntent: null,
						workflowHint: null,
						clarifyingQuestion: null,
						evidenceExpectation: null,
					},
					delegation: {
						workOrder: {
							objective: "Review the roadmap",
							executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
							outputContract: "Return a short summary",
							toolGuidance: ["Use the product scope"],
							boundaries: ["Stay in-org"],
							sourceContent: "Have CPO review the roadmap.",
							targetTediId: "tedi-cpo",
							targetTediLabel: "CPO",
						},
						decision: {
							canAutoDispatch: false,
							mode: "needs_approval",
							reason: "target not active",
						},
					},
				})) as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelForTest
				>[0],
			);

			await client.enqueueMessage({
				conversationId: "home:test",
				content: "Have CPO review the roadmap.",
				idempotencyKey: "home-deleg-respond-approve-1",
				metadata: { requiredProofKind: "code" },
			});
			expect(delegateRunner).not.toHaveBeenCalled();

			const result = await client.respondApproval({
				runId: "home-deleg-respond-approve-1",
				decision: "approve",
				note: "approved handoff",
			});

			expect(delegateRunner).toHaveBeenCalledTimes(1);
			expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
				childRunId: "home-deleg-respond-approve-1:approved:tedi-cpo",
				delegateToTediId: "tedi-cpo",
			});
			expect(db.workItemRows).toHaveLength(1);
			expect(db.workAttemptRows).toHaveLength(1);
			const workItemId = db.workItemRows[0]?.id;
			expect(db.workItemRows[0]).toMatchObject({
				accountableOwnerId: "tedi-cpo",
				disposition: "accepted",
				metadata: {
					childRunId: expect.stringContaining(
						"home-deleg-respond-approve-1_approved_tedi-cpo",
					),
					homeRunId: "home-deleg-respond-approve-1",
					source: "kernelRuntime.directDelegation",
				},
			});
			expect(db.workAttemptRows[0]).toMatchObject({
				workItemId,
				executorId: "tedi-cpo",
				runtimeState: "running",
			});
			const delegateCall = delegateRunner.mock.calls[0]?.[0] as
				| { content: string; metadata: Record<string, unknown> }
				| undefined;
			expect(delegateCall).toBeDefined();
			expect(delegateCall?.content).toContain("[HOME DELEGATION WORK ORDER");
			expect(delegateCall?.content).toContain(`Work Item: ${workItemId}`);
			expect(delegateCall?.content).toContain(
				"Home owns the linked Work Item lifecycle below the model",
			);
			expect(delegateCall?.content).toContain(
				"You may read\nWork projects and items",
			);
			expect(delegateCall?.content).toContain(
				"Respect the original request's mutation limits exactly",
			);
			expect(delegateCall?.metadata).toMatchObject({
				workItemId,
				requiredProofKind: "code",
			});
			expect(result.run).toMatchObject({
				id: "home-deleg-respond-approve-1",
				status: "queued",
				delegatedTediId: "tedi-cpo",
				childRunId: "home-deleg-respond-approve-1:approved:tedi-cpo",
				metadata: {
					workItemId,
					homeDelegation: {
						resolutionStatus: "approved",
						workOrder: { status: "approved" },
					},
					homeApprovedDispatch: {
						workItemId,
						source: "kernelRuntime.respondApproval",
					},
				},
			});
			expect(result.assignments).toEqual([]);

			await expect(
				client.respondApproval({
					runId: "home-deleg-respond-approve-1",
					decision: "approve",
				}),
			).rejects.toThrow(/already "approved"/);
			expect(delegateRunner).toHaveBeenCalledTimes(1);
			// Recovery must preserve the same structured coding intent, not infer it
			// from the rendered work-order prose after an approval or failed attempt.
			db.workAttemptRows[0]!.runtimeState = "failed";
			db.workAttemptRows[0]!.finishedAt = new Date().toISOString();
			db.workAttemptRows[0]!.outcome = "failed";
			const previousRun = db.runs.find((run) => run.id === result.run.id)!;
			const previousChildRunId = previousRun.childRunId!;
			const oldTerminalAt = "2026-01-01T00:00:00.000Z";
			const oldSummary = {
				childRunStatus: "completed",
				childRunTerminalAt: oldTerminalAt,
				childRunLatestEventAt: oldTerminalAt,
				childRunPreview: "Old result",
				childRunTerminalEventKind: "run.completed",
				childRunEventCount: 10,
				childRunStopReason: "reported_partial",
				childRunStopDetail: "Old stop",
				delegationProof: { verdict: "failed" },
			};
			previousRun.status = "completed";
			previousRun.metadata = { ...previousRun.metadata, ...oldSummary };
			previousRun.runtimeMetadata = {
				...previousRun.runtimeMetadata,
				childRunId: previousChildRunId,
			};
			const recovery = await client.retryDelegation({
				workItemId: workItemId!,
			});
			expect(recovery.retryCount).toBe(1);
			expect(recovery.run).toMatchObject({
				status: "queued",
				completedAt: null,
				progress: { current: 24, label: "Dispatched" },
				runtime: { metadata: { childRunId: recovery.run.childRunId } },
				metadata: { homeRecoveryDispatch: { previousChildRunId } },
			});
			expect(recovery.run.updatedAt).not.toBe(oldTerminalAt);
			expect(recovery.run.metadata?.childRunPreview).not.toBe("Old result");
			expect(recovery.run.metadata?.delegationProof).toBeUndefined();
			const retriedRow = db.runs.find((run) => run.id === result.run.id)!;
			expect(
				normalizeHomeRunRecord(
					retriedRow,
					new Map([[`tedi-cpo:${previousChildRunId}`, oldSummary]]),
				).status,
			).toBe("queued");

			expect(delegateRunner).toHaveBeenLastCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({
						source: "kernelRuntime.retryDelegation",
						requiredProofKind: "code",
						delegationWorkOrder: expect.objectContaining({
							executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
						}),
					}),
				}),
			);
		});

		it("decision approve rewrites approval-held draft work orders into executable tasks", async () => {
			const source = `Prepare a CTO delegation work order. Do not dispatch CTO yet; park this for approval. The intended CTO task is to inspect docs and return one improvement.\n${"Task context. ".repeat(300)}\nAcceptance: never alter the independent oracle; preserve each merge parent.`;
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const delegateRunner = vi.fn(
				async (input: {
					childRunId: string;
					content: string;
					delegateToTediId: string;
					metadata: { delegationWorkOrder?: Record<string, unknown> };
				}) => ({
					childConversationId: "agent:main:main",
					childRunId: input.childRunId,
					status: "queued" as const,
				}),
			);
			kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
			kernelRuntimeTestHooks.setKernelForTest(
				vi.fn(async () => ({
					assistantContent:
						"I prepared a delegation to CTO. It is not dispatched yet; approve this Home run to dispatch the work order.",
					route: {
						routeKind: "delegate_tedi" as const,
						rationale: "The operator asked for an approval-held delegation.",
						risk: "medium" as const,
						confidence: 0.9,
						effortClass: "single_read" as const,
						answer: null,
						targetTediId: "tedi-cto-agent",
						targetTediLabel: "CTO",
						toolIntent: null,
						workflowHint: null,
						clarifyingQuestion: null,
						evidenceExpectation:
							"A parked pending-approval work item for the CTO.",
					},
					delegation: {
						workOrder: {
							objective:
								"Deliver on this request for the operator: prepare a CTO delegation work order. Do not dispatch CTO yet; park this for approval.",
							executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
							outputContract:
								"Return: A parked pending-approval work item for the CTO.",
							toolGuidance: ["Use the coding scope"],
							boundaries: ["Stay in-org"],
							sourceContent: source,
							targetTediId: "tedi-cto-agent",
							targetTediLabel: "CTO",
						},
						decision: {
							canAutoDispatch: false,
							mode: "needs_approval",
							reason: "operator explicitly held dispatch for approval",
						},
					},
				})) as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelForTest
				>[0],
			);

			await client.enqueueMessage({
				conversationId: "home:test",
				content: source,
				idempotencyKey: "home-deleg-held-approve-1",
			});

			await client.respondApproval({
				runId: "home-deleg-held-approve-1",
				decision: "approve",
				note: "approved parked CTO delegation",
			});

			const dispatch = delegateRunner.mock.calls[0]?.[0];
			expect(db.workItemRows).toHaveLength(1);
			expect(db.workAttemptRows).toHaveLength(1);
			expect(dispatch).toMatchObject({
				delegateToTediId: "tedi-cto-agent",
				metadata: {
					workItemId: db.workItemRows[0]?.id,
				},
			});
			expect(dispatch?.content).toContain(
				`Work Item: ${db.workItemRows[0]?.id}`,
			);
			expect(dispatch?.content).toContain(
				"Home owns the linked Work Item lifecycle below the model",
			);
			expect(dispatch?.content).toContain(
				"You may read\nWork projects and items",
			);
			expect(dispatch?.content).toContain(
				"Respect the original request's mutation limits exactly",
			);
			expect(dispatch?.childRunId).toContain("home-deleg-held-approve-1");
			expect(dispatch?.content).toContain(
				"Execute the intended delegated task now.",
			);
			expect(dispatch?.content).toContain(
				"Do not create another approval gate",
			);
			expect(dispatch?.content).toContain(
				"Return the completed delegated task result",
			);
			expect(dispatch?.content).not.toContain(
				"Output contract: Return: A parked pending-approval work item",
			);
			expect(dispatch?.metadata.delegationWorkOrder).toMatchObject({
				status: "approved",
				outputContract: expect.stringContaining(
					"Return the completed delegated task result",
				),
				sourceContent: expect.stringContaining("Approved Home delegation"),
			});
			expect(dispatch?.content).toContain(source);
			expect(dispatch?.metadata.delegationWorkOrder?.sourceContent).toContain(
				source,
			);
			// Retry the approved task under a new fenced Attempt. Its original
			// acceptance constraints must survive the stored work order too.
			db.workAttemptRows[0]!.runtimeState = "failed";
			db.workAttemptRows[0]!.finishedAt = new Date().toISOString();
			db.workAttemptRows[0]!.outcome = "failed";
			await client.retryDelegation({ workItemId: db.workItemRows[0]!.id });
			expect(delegateRunner).toHaveBeenCalledTimes(2);
			expect(db.workAttemptRows).toHaveLength(2);
			expect(delegateRunner).toHaveBeenLastCalledWith(
				expect.objectContaining({ content: expect.stringContaining(source) }),
			);
		});

		it("decision reject on a Home delegation recommendation cancels it without dispatching", async () => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
				childRunId: input.childRunId,
				status: "queued" as const,
			}));
			kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
			kernelRuntimeTestHooks.setKernelForTest(
				vi.fn(async () => ({
					assistantContent: "CPO owns this — want me to set up the hand-off?",
					route: {
						routeKind: "delegate_tedi" as const,
						rationale: "CPO owns product",
						risk: "low" as const,
						confidence: 0.9,
						effortClass: null,
						answer: null,
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
						toolIntent: null,
						workflowHint: null,
						clarifyingQuestion: null,
						evidenceExpectation: null,
					},
					delegation: {
						workOrder: {
							objective: "Review the roadmap",
							executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
							outputContract: "Return a short summary",
							toolGuidance: ["Use the product scope"],
							boundaries: ["Stay in-org"],
							sourceContent: "Have CPO review the roadmap.",
							targetTediId: "tedi-cpo",
							targetTediLabel: "CPO",
						},
						decision: {
							canAutoDispatch: false,
							mode: "needs_approval",
							reason: "target not active",
						},
					},
				})) as unknown as Parameters<
					typeof kernelRuntimeTestHooks.setKernelForTest
				>[0],
			);

			await client.enqueueMessage({
				conversationId: "home:test",
				content: "Have CPO review the roadmap.",
				idempotencyKey: "home-deleg-respond-reject-1",
			});

			const result = await client.respondApproval({
				runId: "home-deleg-respond-reject-1",
				decision: "reject",
				note: "not now",
			});

			expect(delegateRunner).not.toHaveBeenCalled();
			expect(result.run).toMatchObject({
				id: "home-deleg-respond-reject-1",
				status: "canceled",
				metadata: {
					homeDelegation: {
						resolutionStatus: "rejected",
						workOrder: { status: "rejected" },
					},
				},
			});
			expect(result.assignments).toEqual([]);
		});

		it("names what the run is waiting on when it is neither a write card nor a plan", async () => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));

			// A completed answer-in-home turn: nothing pending.
			await client.enqueueMessage({
				conversationId: "home:test",
				content: "hello there",
				idempotencyKey: "home-respond-neither-1",
			});
			await expect(
				client.respondApproval({
					runId: "home-respond-neither-1",
					decision: "approve",
				}),
			).rejects.toThrow(/not waiting on an approval/);

			// Unknown run id.
			await expect(
				client.respondApproval({
					runId: "home-respond-missing",
					decision: "reject",
				}),
			).rejects.toThrow(/Home run not found/);
		});
	});
});
