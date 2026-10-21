import { DatabaseSync } from "node:sqlite";
import type { KernelGovernancePolicy } from "@tedix/api-contract/utils/approval-policy";
import { createRouterClient } from "@orpc/server";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { tediApprovalDependencyEvents } from "@tedix/db/schema/approval-simulations";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { userContext } from "../../test-context";
import {
	enqueueMessageRoute,
	getRepoCommitApprovalStatusRoute,
	proposeCodemodeExecuteRoute,
	proposeRepoCommitRoute,
} from "./execution-proposals";

const effects = vi.hoisted(() => ({
	policy: vi.fn<() => Promise<KernelGovernancePolicy | null>>(async () => ({
		writeTier: { trustedTools: ["repo:repo_commit"] },
	})),
	grants: vi.fn(async () => ["repo:repo_commit"]),
	dispatch: vi.fn(),
	execute: vi.fn(),
}));
vi.mock("./policy-normalization", async (original) => ({
	...(await original<typeof import("./policy-normalization")>()),
	readOrgGovernancePolicy: effects.policy,
	readSessionWriteAllowlist: effects.grants,
	kernelDelegateRunner: effects.dispatch,
}));
vi.mock("../kernel/write-executor", async (original) => ({
	...(await original<typeof import("../kernel/write-executor")>()),
	executeApprovedKernelWrite: effects.execute,
}));

const ORG = "00000000-0000-4000-8000-000000000071";
const AT = "2026-01-01T00:00:00.000Z";
const repoInput = {
	tediId: "tedi-builder",
	orgId: ORG,
	conversationId: "home:test",
	owner: "fictional-team",
	repo: "example",
	baseRef: "a".repeat(40),
	branch: "feature/widget",
	message: "Add widget",
	openPr: false,
	changeSummary: {
		fileCount: 1,
		addedOrModified: ["src/widget.ts"],
		deleted: [],
		totalBytes: 10,
	},
	executionLedgerId: "execution",
	riskTier: "low" as const,
};
const codeInput = {
	tediId: "tedi-builder",
	orgId: ORG,
	conversationId: "home:test",
	sessionKey: "coding-session",
	executionId: "execution",
	codeHash: "b".repeat(64),
	approvalRequestId: "approval",
};
const databases: DatabaseSync[] = [];
function fixture(service = true) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			tediApprovalRequests,
			tediApprovalDependencyEvents,
			auditEvents,
			kernelRuntimeRuns,
		),
	);
	const writes: string[] = [];
	const DB = createD1Facade(sqlite, {
		onPrepare: (sql) => {
			if (/^\s*(insert|update|delete|replace)\b/i.test(sql)) writes.push(sql);
		},
	});
	const fetch = vi.fn(() => {
		throw new Error("Unexpected external call");
	});
	vi.stubGlobal("fetch", fetch);
	const context = userContext({
		organizationId: ORG,
		permissions: ["tedis:update"],
		headers: service ? { "X-Service-Binding": "true" } : {},
		env: { ENVIRONMENT: "test", DB } as CloudflareEnv,
	});
	const client = createRouterClient(
		{
			repo: proposeRepoCommitRoute,
			code: proposeCodemodeExecuteRoute,
			status: getRepoCommitApprovalStatusRoute,
			enqueue: enqueueMessageRoute,
		},
		{ context },
	);
	return { sqlite, context, client, writes, fetch };
}
function approval(f: ReturnType<typeof fixture>) {
	return f.sqlite
		.prepare("SELECT * FROM tedi_approval_requests")
		.get() as Record<string, unknown>;
}
function noExecution(f: ReturnType<typeof fixture>) {
	expect(effects.dispatch).not.toHaveBeenCalled();
	expect(effects.execute).not.toHaveBeenCalled();
	expect(f.fetch).not.toHaveBeenCalled();
}
function noEffects(f: ReturnType<typeof fixture>) {
	expect(f.writes).toEqual([]);
	noExecution(f);
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
	vi.unstubAllGlobals();
	for (const sqlite of databases.splice(0)) sqlite.close();
});

describe("proposal service boundary", () => {
	it.each(["repo", "code", "status"] as const)(
		"refuses a direct user calling %s before any write or policy read",
		async (route) => {
			const f = fixture(false);
			const request =
				route === "repo"
					? f.client.repo(repoInput)
					: route === "code"
						? f.client.code(codeInput)
						: f.client.status({
								approvalRequestId: "approval",
								tediId: "tedi-builder",
							});
			await expect(request).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				message: expect.stringContaining("Service binding required"),
			});
			expect(effects.policy).not.toHaveBeenCalled();
			expect(effects.grants).not.toHaveBeenCalled();
			noEffects(f);
		},
	);
	it("refuses worker dispatch by a user lacking tedis:update before ingress writes", async () => {
		const f = fixture(false);
		f.context.user!.permissions = ["home:use"];
		await expect(
			f.client.enqueue({
				content: "Review the widget",
				delegateToTediId: "tedi-builder",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		noEffects(f);
	});
});

describe("repo proposal decisions", () => {
	it("auto-approves a trusted feature commit and persists the exact fingerprint without execution", async () => {
		const f = fixture();
		const fingerprint = "c".repeat(64);
		const result = await f.client.repo({
			...repoInput,
			changeFingerprint: fingerprint,
		});
		expect(result).toMatchObject({ status: "approved", autoResolved: true });
		expect(approval(f)).toMatchObject({
			id: result.approvalRequestId,
			status: "approved",
			org_id: ORG,
			tedi_id: repoInput.tediId,
		});
		expect(JSON.parse(String(approval(f).payload))).toMatchObject({
			kind: "repo_commit_write",
			riskTier: "low",
			changeFingerprint: fingerprint,
		});
		expect(
			f.sqlite.prepare("SELECT action FROM audit_events ORDER BY rowid").all(),
		).toEqual([
			{ action: "approval.requested" },
			{ action: "approval.approved" },
		]);
		noExecution(f);
	});
	it.each(["main", "master"])(
		"keeps protected branch %s pending despite a forged low risk and session grant",
		async (branch) => {
			const f = fixture();
			const result = await f.client.repo({ ...repoInput, branch });
			expect(result).toMatchObject({ status: "pending", autoResolved: false });
			expect(JSON.parse(String(approval(f).payload))).toMatchObject({
				riskTier: "high",
			});
			expect(approval(f).status).toBe("pending");
			expect(f.writes.filter((sql) => /^update/i.test(sql))).toEqual([]);
			noExecution(f);
		},
	);
	it("leaves an untrusted feature commit pending", async () => {
		const f = fixture();
		effects.policy.mockResolvedValueOnce(null);
		effects.grants.mockResolvedValueOnce([]);
		expect(await f.client.repo(repoInput)).toMatchObject({
			status: "pending",
			autoResolved: false,
		});
		expect(approval(f).status).toBe("pending");
		noExecution(f);
	});
	it.each(["wrong-tedi", "wrong-kind", "missing"])(
		"does not disclose a status for %s",
		async (failure) => {
			const f = fixture();
			const proposed = await f.client.repo(repoInput);
			if (failure === "wrong-kind")
				f.sqlite.exec("UPDATE tedi_approval_requests SET payload = '{}'");
			f.writes.length = 0;
			await expect(
				f.client.status({
					approvalRequestId:
						failure === "missing" ? "absent" : proposed.approvalRequestId,
					tediId: failure === "wrong-tedi" ? "another-tedi" : repoInput.tediId,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			noEffects(f);
		},
	);
});

describe("Code Mode proposal identity and replay", () => {
	it("parks arbitrary code even with broad trusted grants, and replays without duplicate writes", async () => {
		const f = fixture();
		expect(await f.client.code(codeInput)).toEqual({
			approvalRequestId: "approval",
			status: "pending",
		});
		expect(JSON.parse(String(approval(f).payload))).toMatchObject({
			riskTier: "high",
			executionId: "execution",
			codeHash: codeInput.codeHash,
		});
		f.writes.length = 0;
		expect(await f.client.code(codeInput)).toEqual({
			approvalRequestId: "approval",
			status: "pending",
		});
		noEffects(f);
	});
	it.each(["orgId", "tediId", "executionId", "codeHash"] as const)(
		"refuses replay with mismatched %s before any mutation",
		async (field) => {
			const f = fixture();
			await f.client.code(codeInput);
			const before = approval(f);
			f.writes.length = 0;
			await expect(
				f.client.code({ ...codeInput, [field]: "different" }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("bound to another"),
			});
			expect(approval(f)).toEqual(before);
			noEffects(f);
		},
	);
	it.each(["rejected", "expired", "cancelled"])(
		"does not revive an already %s approval",
		async (status) => {
			const f = fixture();
			await f.client.code(codeInput);
			f.sqlite
				.prepare("UPDATE tedi_approval_requests SET status = ?")
				.run(status);
			f.writes.length = 0;
			await expect(f.client.code(codeInput)).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining(`already "${status}"`),
			});
			noEffects(f);
		},
	);
	it("returns an already approved execution without creating or executing it again", async () => {
		const f = fixture();
		await f.client.code(codeInput);
		f.sqlite.exec("UPDATE tedi_approval_requests SET status = 'approved'");
		f.writes.length = 0;
		expect(await f.client.code(codeInput)).toEqual({
			approvalRequestId: "approval",
			status: "approved",
		});
		noEffects(f);
	});
	it.each(["homeRunId", "orgId", "tediId", "childRunId"] as const)(
		"refuses a durable call with mismatched %s before creating an approval",
		async (field) => {
			const f = fixture();
			await f.context.db.insert(kernelRuntimeRuns).values({
				id: "home-run",
				organizationId: ORG,
				conversationId: "home:test",
				status: "running",
				delegatedTediId: codeInput.tediId,
				childRunId: "child-run",
				createdAt: AT,
				updatedAt: AT,
			});
			f.writes.length = 0;
			await expect(
				f.client.code({
					...codeInput,
					executionMode: "durable_call",
					homeRunId: "home-run",
					childRunId: "child-run",
					pendingSeq: 1,
					connector: "example",
					method: "update",
					[field]: "different",
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("does not match"),
			});
			noEffects(f);
		},
	);
	it("parks a matching durable call on its existing Home run", async () => {
		const f = fixture();
		await f.context.db.insert(kernelRuntimeRuns).values({
			id: "home-run",
			organizationId: ORG,
			conversationId: "home:test",
			status: "running",
			delegatedTediId: codeInput.tediId,
			childRunId: "child-run",
			createdAt: AT,
			updatedAt: AT,
		});
		expect(
			await f.client.code({
				...codeInput,
				executionMode: "durable_call",
				homeRunId: "home-run",
				childRunId: "child-run",
				pendingSeq: 1,
				connector: "example",
				method: "update",
			}),
		).toMatchObject({ status: "pending" });
		expect(
			f.sqlite
				.prepare("SELECT status, metadata FROM kernel_runtime_runs")
				.get(),
		).toMatchObject({
			status: "requires_approval",
			metadata: expect.stringContaining('"approvalRequestId":"approval"'),
		});
		noExecution(f);
	});
});
