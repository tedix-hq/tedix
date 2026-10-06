import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { workApprovalsContractRouter } from "../work-approvals";
import { admitWorkAttempt } from "../work-items/attempt-admission";
import { requestHomeDelegationAgentReview } from "./delegation-agent-review";

const respondCore = vi.hoisted(() => vi.fn());
vi.mock("./approval-control", () => ({
	respondKernelDelegationRecommendationApprovalCore: respondCore,
}));

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "home-run-held-1";

const migrationRoot = new URL(
	"../../../../../../packages/db/drizzle/",
	import.meta.url,
);

/** Real migrated schema: the approval-decision triggers are load-bearing. */
function migratedSqlite(): DatabaseSync {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	for (const name of readdirSync(migrationRoot).sort()) {
		sqlite.exec(
			readFileSync(new URL(`${name}/migration.sql`, migrationRoot), "utf8"),
		);
	}
	sqlite.exec("PRAGMA foreign_keys=ON");
	return sqlite;
}

function fixture() {
	const sqlite = migratedSqlite();
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('${ORG_ID}','Org','org');
		INSERT INTO tedis(id,organization_id,name,slug,status,mcp_capability_profile)
		VALUES
			('tedi-cto','${ORG_ID}','CTO','cto','active','standard'),
			('tedi-cpo','${ORG_ID}','CPO','cpo','active','standard');
	`);
	const delegation = {
		workOrder: {
			kind: "tedi.delegate",
			objective: "Review the roadmap.",
			outputContract: "Return a short summary.",
			status: "draft",
			sourceContent: "Have CPO review the roadmap.",
			targetTediId: "tedi-cpo",
			targetTediLabel: "CPO",
		},
		decision: {
			mode: "needs_approval",
			approvalRoute: "agent",
			canAutoDispatch: false,
			reason: "route classified as high risk",
		},
		approver: { tediId: "tedi-cto", label: "CTO" },
	};
	sqlite
		.prepare(
			`INSERT INTO kernel_runtime_runs(id,organization_id,conversation_id,status,metadata,created_at,updated_at)
			VALUES (?,?,?,?,json(?),?,?)`,
		)
		.run(
			RUN_ID,
			ORG_ID,
			"home:main",
			"requires_approval",
			JSON.stringify({ homeDelegation: delegation }),
			"2026-09-26T10:00:00.000Z",
			"2026-09-26T10:00:01.000Z",
		);
	const facade = createD1Facade(sqlite);
	const context = {
		db: createDbClient(facade),
		env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/work-approvals"),
	} as BaseContext;
	const clientForTedi = (tediId: string) =>
		createRouterClient(workApprovalsContractRouter, {
			context: {
				...context,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": ORG_ID,
					"X-Tedix-Tedi-Id": tediId,
					"X-Tedix-Tedi-Scopes": "mcp:messaging.read mcp:messaging.write",
				}),
			} as BaseContext,
		});
	return { sqlite, context, clientForTedi, delegation };
}

async function requestReview(f: ReturnType<typeof fixture>) {
	const requestedAt = new Date().toISOString();
	const review = await requestHomeDelegationAgentReview(f.context, {
		organizationId: ORG_ID,
		conversationId: "home:main",
		homeRunId: RUN_ID,
		content: "Have CPO review the roadmap.",
		approverTediId: "tedi-cto",
		approverTediLabel: "CTO",
		targetTediId: "tedi-cpo",
		targetTediLabel: "CPO",
		holdReason: "route classified as high risk",
		route: {
			risk: "high",
			targetActivityId: null,
			effortClass: "multi_hop_read",
			rationale: "Roadmap review belongs to the CPO.",
		},
		workOrder: f.delegation.workOrder,
		executionRequirement: {
			surface: "native",
			requiredCapabilities: [],
			fallbackSurface: null,
			prohibitedSurfaces: [],
			satisfiable: true,
			reason: "test",
		},
		requestedAt,
		expiresAt: new Date(Date.parse(requestedAt) + 3_600_000).toISOString(),
	});
	// What the turn body stamps on the parked run.
	f.sqlite
		.prepare(
			"UPDATE kernel_runtime_runs SET metadata=json_set(metadata,'$.homeDelegation.agentReview',json(?)) WHERE id=?",
		)
		.run(JSON.stringify(review), RUN_ID);
	return review;
}

afterEach(() => {
	respondCore.mockReset();
});

describe("Home delegation agent review over the Work approval plane", () => {
	it("holds an accepted, unadmitted Work Item and proposes it to the approver tedi", async () => {
		const f = fixture();
		const review = await requestReview(f);

		expect(review).toMatchObject({
			status: "pending",
			approverTediId: "tedi-cto",
			proposalVersion: 1,
		});
		const item = await getWorkItemById(f.context.db, review.workItemId!);
		expect(item).toMatchObject({
			disposition: "accepted",
			requiredAuthorities: ["home_delegation"],
			sourceIntentId: `${RUN_ID}:delegation-review`,
			accountableOwnerId: "tedi-cpo",
			metadata: expect.objectContaining({
				source: "kernelRuntime.homeDelegationReview",
				homeRunId: RUN_ID,
			}),
		});
		expect(item?.description).toContain("route classified as high risk");
		expect(item?.description).toContain("authorizes this one dispatch only");
		const proposal = f.sqlite
			.prepare(
				"SELECT status, approver_id, requester_type, requester_id, authority_key, proposal FROM work_approval_proposals WHERE id=?",
			)
			.get(review.proposalId!) as Record<string, string>;
		expect(proposal).toMatchObject({
			status: "pending",
			approver_id: "tedi-cto",
			requester_type: "system",
			requester_id: "tedix",
			authority_key: "home_delegation",
		});
		expect(JSON.parse(proposal.proposal)).toMatchObject({
			kind: "home_delegation",
			homeRunId: RUN_ID,
			targetTediId: "tedi-cpo",
		});
		// Held: without the approver's receipt the item cannot be admitted.
		await expect(
			admitWorkAttempt(f.context.db, {
				workItem: item!,
				executor: { type: "tedi", id: "tedi-cpo" },
				leaseTtlMs: 300_000,
				now: new Date().toISOString(),
			}),
		).rejects.toThrow(/home_delegation/);
	});

	it("the target tedi cannot decide its own delegation", async () => {
		const f = fixture();
		const review = await requestReview(f);
		await expect(
			f.clientForTedi("tedi-cpo").decide({
				proposalId: review.proposalId!,
				expectedProposalVersion: 1,
				decision: "approved",
				rationale: "I approve my own work",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(respondCore).not.toHaveBeenCalled();
	});

	it("an approval admits the held item and dispatches through the Home approval core", async () => {
		const f = fixture();
		const review = await requestReview(f);

		await f.clientForTedi("tedi-cto").decide({
			proposalId: review.proposalId!,
			expectedProposalVersion: 1,
			decision: "approved",
			rationale: "Bounded roadmap review; no production mutation.",
		});

		expect(respondCore).toHaveBeenCalledTimes(1);
		const [coreContext, coreInput] = respondCore.mock.calls[0]!;
		expect(coreContext.authType).toBe("service-binding");
		expect(coreInput).toMatchObject({
			decision: "approve",
			organizationId: ORG_ID,
			approvedWorkItemId: review.workItemId,
			resolvedBy: { type: "tedi", id: "tedi-cto" },
			note: expect.stringContaining("Bounded roadmap review"),
		});
		expect(coreInput.run.metadata.homeDelegation.agentReview).toMatchObject({
			status: "approved",
			rationale: "Bounded roadmap review; no production mutation.",
		});
		// The approver's receipt is exactly what admission needs.
		const item = await getWorkItemById(f.context.db, review.workItemId!);
		await expect(
			admitWorkAttempt(f.context.db, {
				workItem: item!,
				executor: { type: "tedi", id: "tedi-cpo" },
				leaseTtlMs: 300_000,
				now: new Date().toISOString(),
			}),
		).resolves.toMatchObject({ id: expect.any(String) });
	});

	it("a rejection cancels the held item and hands the run back to the operator", async () => {
		const f = fixture();
		const review = await requestReview(f);

		await f.clientForTedi("tedi-cto").decide({
			proposalId: review.proposalId!,
			expectedProposalVersion: 1,
			decision: "rejected",
			rationale: "Roadmap is frozen this week.",
		});

		expect(respondCore).not.toHaveBeenCalled();
		const item = await getWorkItemById(f.context.db, review.workItemId!);
		expect(item?.disposition).toBe("cancelled");
		const run = await getKernelRuntimeRun(f.context.db, {
			id: RUN_ID,
			organizationId: ORG_ID,
		});
		expect(run?.status).toBe("requires_approval");
		expect(run?.metadata).toMatchObject({
			homeDelegation: {
				agentReview: {
					status: "rejected",
					rationale: "Roadmap is frozen this week.",
				},
			},
		});
		const metadata = run?.metadata as {
			homeDelegation: Record<string, unknown>;
		};
		expect(metadata.homeDelegation.resolutionStatus).toBeUndefined();
	});

	it("an approval that cannot be carried out falls back to the operator", async () => {
		const f = fixture();
		const review = await requestReview(f);
		respondCore.mockRejectedValueOnce(new Error("Delegated tedi not found"));

		await f.clientForTedi("tedi-cto").decide({
			proposalId: review.proposalId!,
			expectedProposalVersion: 1,
			decision: "approved",
			rationale: "Fine to proceed.",
		});

		const run = await getKernelRuntimeRun(f.context.db, {
			id: RUN_ID,
			organizationId: ORG_ID,
		});
		expect(run?.status).toBe("requires_approval");
		expect(run?.metadata).toMatchObject({
			homeDelegation: {
				agentReview: {
					status: "rejected",
					reason: expect.stringContaining("Delegated tedi not found"),
				},
			},
		});
		const item = await getWorkItemById(f.context.db, review.workItemId!);
		expect(item?.disposition).toBe("cancelled");
	});
});
