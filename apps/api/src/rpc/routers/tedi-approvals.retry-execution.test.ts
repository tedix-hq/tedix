/**
 * "Try again" on an approved owner tool call whose first run failed on the
 * platform's side. The procedure runs the stored call once more through the
 * real settlement and the real D1-shaped claim; only the gateway executor and
 * the side ledgers are stubbed.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import {
	createApprovalRequest,
	consumeOwnerToolApproval,
	getApprovalRequestById,
	listDueOwnerToolApprovals,
} from "@tedix/db/queries/approvals";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { eq } from "drizzle-orm";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { bindTestContexts } from "../test-context";

const mocks = vi.hoisted(() => ({
	insertAuditEvent: vi.fn(async () => ({}) as never),
	recordApprovalExecutionReceipt: vi.fn(async () => ({}) as never),
	getMemberByUserId: vi.fn(),
	getOrganizationById: vi.fn(),
	executor: vi.fn(),
}));
vi.mock("@tedix/db/queries/audit", () => ({
	insertAuditEvent: mocks.insertAuditEvent,
}));
vi.mock("@tedix/db/queries/approval-simulations", async (load) => ({
	...(await load<object>()),
	recordApprovalExecutionReceipt: mocks.recordApprovalExecutionReceipt,
}));
vi.mock("@tedix/db/queries/organization-members", async (load) => ({
	...(await load<object>()),
	getMemberByUserId: mocks.getMemberByUserId,
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<object>()),
	getOrganizationById: mocks.getOrganizationById,
}));

import {
	runQueuedOwnerToolApprovals,
	settleOwnerToolCallApproval,
	setOwnerToolExecutorForTest,
} from "./kernel/owner-tool-approval-settlement";
import { tediApprovalsContractRouter } from "./tedi-approvals";

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const FUTURE = "2030-01-01T00:00:00.000Z";

function createFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(tediApprovalRequests));
	const facade = createD1Facade(sqlite);
	const env = {
		ENVIRONMENT: "test",
		DB: facade,
		MCP_URL: "https://mcp.example.test",
		MCP_SERVICE: { fetch: vi.fn() },
	} as unknown as CloudflareEnv;
	return { env, db: createDbClient(facade) };
}
type Fixture = ReturnType<typeof createFixture>;

const { userContext } = bindTestContexts({
	url: "https://api.tedix.test/rpc/tediApprovals/retryExecution",
	user: { permissions: ["settings:manage"], sub: "admin-2" },
});

async function seedFailedCall(
	fixture: Fixture,
	execution: Record<string, unknown> | undefined = {
		status: "failed",
		startedAt: "2026-10-28T13:23:45.692Z",
		finishedAt: "2026-10-28T13:23:46.311Z",
		error:
			'Tool "tedix__delete_descope_aih_mcp_client" is no longer available on example-unified',
	},
	overrides: { status?: string; expiresAt?: string } = {},
) {
	await createApprovalRequest(fixture.db, {
		id: APPROVAL_ID,
		tediId: "9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d",
		orgId: "org-1",
		actionType: "mcp.tool_call",
		description: "Delete descope aih mcp client",
		payload: {
			kind: "mcp_tool_call",
			initiatedByUserId: "owner-1",
			appSlug: "example-unified",
			toolId: "tedix__delete_descope_aih_mcp_client",
			target: { transport: "rpc", endpoint: "descopeAih/deleteMcpClient" },
			args: { id: "TPA-1", mcpServerId: "RS-1", confirmDestructive: true },
			fingerprint: "fp-1",
			...(execution ? { execution } : {}),
		},
		createdAt: "2026-10-28T12:42:13.198Z",
		expiresAt: overrides.expiresAt ?? FUTURE,
	});
	await fixture.db
		.update(tediApprovalRequests)
		.set({
			status: overrides.status ?? "approved",
			resolvedBy: "user:owner-1",
			resolvedAt: "2026-10-28T13:23:45.091Z",
		})
		.where(eq(tediApprovalRequests.id, APPROVAL_ID));
}

function client(fixture: Fixture, organizationId = "org-1") {
	return createRouterClient(tediApprovalsContractRouter, {
		context: userContext({ db: fixture.db, env: fixture.env, organizationId }),
	});
}

async function storedExecution(fixture: Fixture) {
	const [row] = await fixture.db
		.select({ payload: tediApprovalRequests.payload })
		.from(tediApprovalRequests)
		.where(eq(tediApprovalRequests.id, APPROVAL_ID));
	return (row?.payload as { execution?: Record<string, unknown> }).execution;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getMemberByUserId.mockResolvedValue({
		role: "owner",
		status: "active",
	});
	mocks.getOrganizationById.mockResolvedValue({ id: "org-1", slug: "example" });
	mocks.executor.mockResolvedValue({ ok: true, data: { success: true } });
	setOwnerToolExecutorForTest(mocks.executor);
});
afterEach(() => setOwnerToolExecutorForTest(null));

describe("tediApprovals.retryExecution", () => {
	it("runs the approved call once more and returns the recorded result", async () => {
		const fixture = createFixture();
		await seedFailedCall(fixture);
		const result = await client(fixture).retryExecution({ id: APPROVAL_ID });
		expect(mocks.executor).toHaveBeenCalledTimes(1);
		expect(mocks.executor).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalRequestId: APPROVAL_ID,
				payload: expect.objectContaining({
					appSlug: "example-unified",
					toolId: "tedix__delete_descope_aih_mcp_client",
					args: { id: "TPA-1", mcpServerId: "RS-1", confirmDestructive: true },
					initiatedByUserId: "owner-1",
				}),
			}),
		);
		expect(result.payload.execution).toMatchObject({
			status: "executed",
			attempt: 2,
			retriedBy: "admin-2",
			summary: "Execution details are available to the requester",
		});
		expect(await storedExecution(fixture)).toMatchObject({
			status: "executed",
			attempt: 2,
		});
	});

	it("retries a run that never finished and leaves a fresh run alone", async () => {
		const fixture = createFixture();
		await seedFailedCall(fixture, {
			status: "running",
			startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
			attempt: 2,
			retriedBy: "admin-1",
		});
		const result = await client(fixture).retryExecution({ id: APPROVAL_ID });
		expect(result.payload.execution).toMatchObject({
			status: "executed",
			attempt: 3,
			retriedBy: "admin-2",
		});
		const fresh = createFixture();
		await seedFailedCall(fresh, {
			status: "running",
			startedAt: new Date().toISOString(),
		});
		await expect(
			client(fresh).retryExecution({ id: APPROVAL_ID }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("running now"),
		});
		expect(mocks.executor).toHaveBeenCalledTimes(1);
	});

	it("allows another retry while the platform keeps failing and the approval is unconsumed", async () => {
		const fixture = createFixture();
		await seedFailedCall(fixture);
		mocks.executor.mockResolvedValueOnce({
			ok: false,
			error: "Provider tool call failed (transport)",
			retryable: true,
		});
		const result = await client(fixture).retryExecution({ id: APPROVAL_ID });
		expect(result.payload.execution).toMatchObject({
			status: "failed",
			attempt: 2,
			retryable: true,
		});
		const again = await client(fixture).retryExecution({ id: APPROVAL_ID });
		expect(again.payload.execution).toMatchObject({
			status: "executed",
			attempt: 3,
		});
		expect(mocks.executor).toHaveBeenCalledTimes(2);
	});

	it("refuses a target refusal, a run that succeeded and an expired request", async () => {
		const fixture = createFixture();
		await seedFailedCall(fixture, {
			status: "failed",
			startedAt: "x",
			error: "insufficient_scope: platform:admin",
			retryable: false,
		});
		await expect(
			client(fixture).retryExecution({ id: APPROVAL_ID }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("request a new approval"),
		});

		const done = createFixture();
		await seedFailedCall(done, { status: "executed", startedAt: "x" });
		await expect(
			client(done).retryExecution({ id: APPROVAL_ID }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const expired = createFixture();
		await seedFailedCall(expired, undefined, {
			expiresAt: "2026-10-01T12:42:13.239Z",
		});
		await expect(
			client(expired).retryExecution({ id: APPROVAL_ID }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("could not be claimed"),
		});
		expect(mocks.executor).not.toHaveBeenCalled();
	});

	it("is for owners and admins of the request's organization only", async () => {
		const fixture = createFixture();
		await seedFailedCall(fixture);
		await expect(
			client(fixture, "org-2").retryExecution({ id: APPROVAL_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		mocks.getMemberByUserId.mockResolvedValueOnce({
			role: "member",
			status: "active",
		});
		await expect(
			client(fixture).retryExecution({ id: APPROVAL_ID }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("owner or admin"),
		});
		expect(mocks.executor).not.toHaveBeenCalled();
	});
});

describe("approved burst queue", () => {
	it("runs all 31 calls at five per window, without a manual retry or duplicate effect", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-31T12:00:00.000Z"));
			const fixture = createFixture();
			const context = userContext({
				db: fixture.db,
				env: fixture.env,
				organizationId: "org-1",
			});
			const effects = new Set<string>();
			let window = Date.now(),
				used = 0;
			mocks.executor.mockImplementation(
				async ({ approvalRequestId }: { approvalRequestId: string }) => {
					if (Date.now() - window >= 60_000) {
						window = Date.now();
						used = 0;
					}
					if (used >= 5)
						return {
							ok: false,
							error: "Tool rate limit exceeded. No side effect was executed.",
							retryable: true,
							rateLimitRetryAfterSeconds: 60,
						};
					used++;
					const consumed = await consumeOwnerToolApproval(fixture.db, {
						id: approvalRequestId,
						organizationId: "org-1",
						fingerprint: approvalRequestId,
						now: new Date().toISOString(),
					});
					expect(consumed).toBe(true);
					expect(effects.has(approvalRequestId)).toBe(false);
					effects.add(approvalRequestId);
					return { ok: true, data: { success: true } };
				},
			);
			const rows = [];
			for (let i = 0; i < 31; i++) {
				const id = `burst-${i}`;
				await createApprovalRequest(fixture.db, {
					id,
					orgId: "org-1",
					tediId: "anchor",
					actionType: "mcp.tool_call",
					description: "Delete a skill",
					payload: {
						kind: "mcp_tool_call",
						initiatedByUserId: "owner-1",
						appSlug: "example-unified",
						toolId: "delete_skills",
						target: { transport: "rpc", endpoint: "skills/delete" },
						args: { id },
						fingerprint: id,
					},
					createdAt: new Date().toISOString(),
					expiresAt: FUTURE,
				});
				await fixture.db
					.update(tediApprovalRequests)
					.set({ status: "approved", resolvedBy: "user:owner-1" })
					.where(eq(tediApprovalRequests.id, id));
				rows.push((await getApprovalRequestById(fixture.db, id))!);
			}
			const outcomes = await Promise.all(
				rows.map((approval) =>
					settleOwnerToolCallApproval(context, {
						approval,
						status: "approved",
					}),
				),
			);
			expect(outcomes.filter((x) => x === "succeeded")).toHaveLength(5);
			expect(outcomes.filter((x) => x === "queued")).toHaveLength(26);
			expect(
				await listDueOwnerToolApprovals(fixture.db, new Date().toISOString()),
			).toHaveLength(0);
			for (let minute = 1; minute <= 6; minute++) {
				vi.setSystemTime(new Date(Date.now() + 120_000));
				// Competing cron deliveries use the same persisted claim.
				await Promise.all([
					runQueuedOwnerToolApprovals(context),
					runQueuedOwnerToolApprovals(context),
				]);
			}
			expect(effects.size).toBe(31);
			for (const row of rows)
				expect(
					(await getApprovalRequestById(fixture.db, row.id))?.payload.execution,
				).toMatchObject({ status: "executed" });
			expect(await runQueuedOwnerToolApprovals(context)).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

it.each(["expired", "revoked", "target failure", "consumed"])(
	"stops queued execution safely after %s",
	async (reason) => {
		const fixture = createFixture();
		await seedFailedCall(
			fixture,
			{
				status: "queued",
				startedAt: "2026-10-31T10:00:00.000Z",
				nextAttemptAt: "2026-10-31T10:01:00.000Z",
			},
			reason === "expired" ? { expiresAt: "2026-10-31T10:01:00.000Z" } : {},
		);
		const context = userContext({
			db: fixture.db,
			env: fixture.env,
			organizationId: "org-1",
		});
		if (reason === "revoked")
			mocks.getMemberByUserId.mockResolvedValue({
				status: "inactive",
				role: "owner",
			});
		if (reason === "target failure")
			mocks.executor.mockResolvedValue({
				ok: false,
				error: "The target refused this call",
			});
		if (reason === "consumed")
			await consumeOwnerToolApproval(fixture.db, {
				id: APPROVAL_ID,
				organizationId: "org-1",
				fingerprint: "fp-1",
				now: "2026-10-31T10:02:00.000Z",
			});
		await runQueuedOwnerToolApprovals(context);
		if (reason === "consumed")
			expect(await storedExecution(fixture)).toMatchObject({
				status: "queued",
			});
		else
			expect(await storedExecution(fixture)).toMatchObject({
				status: "failed",
				retryable: false,
			});
		expect(mocks.executor).toHaveBeenCalledTimes(
			reason === "target failure" ? 1 : 0,
		);
	},
);
