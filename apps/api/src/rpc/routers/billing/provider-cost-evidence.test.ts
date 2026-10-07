import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { providerCostEvidenceDigest } from "@tedix/api-contract/schemas/provider-cost-evidence";
import type { BaseContext } from "../../orpc";
const m = vi.hoisted(() => ({
	db: { batch: vi.fn() },
	external: vi.fn(),
	approval: vi.fn(),
	bundle: vi.fn(),
	source: vi.fn(),
	current: vi.fn(),
	prior: vi.fn(),
	relationships: vi.fn(),
	append: vi.fn(),
	execute: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => m.db }));
vi.mock("../work-items-principal", () => ({
	verifiedExternalAgent: m.external,
}));
vi.mock(
	"@tedix/db/queries/billing/provider-cost-evidence",
	async (original) => ({
		...(await original<
			typeof import("@tedix/db/queries/billing/provider-cost-evidence")
		>()),
		getProviderCostEvidenceApproval: m.approval,
		getProviderCostEvidenceAuthorityBundle: m.bundle,
		getProviderCostEvidenceSource: m.source,
		getProviderCostEvidenceCurrent: m.current,
		getProviderCostEvidenceByIdempotency: m.prior,
		getProviderCostEvidenceRelationships: m.relationships,
		buildAppendProviderCostEvidenceStatement: m.append,
		executeProviderCostEvidenceBatch: m.execute,
	}),
);
import { recordProviderCostEvidence } from "../../../services/provider-cost-evidence";
const id = (n: number) =>
	`00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
let c: BaseContext,
	input: Parameters<typeof recordProviderCostEvidence>[1],
	a: any,
	b: any,
	source: any;
beforeEach(async () => {
	vi.clearAllMocks();
	m.execute.mockResolvedValue([]);
	const org = id(1),
		expiry = "2099-01-01T00:00:00.000Z";
	c = {
		authType: "user",
		organizationId: org,
		user: { sub: "operator", scope: "platform:admin", roles: [] },
		env: {
			DB: {},
			TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			GIT_SHA: "a".repeat(40),
		},
	} as unknown as BaseContext;
	source = {
		id: "call",
		orgId: org,
		gatewayId: "fictional",
		gatewayLogId: "log",
		provider: "provider",
		model: "model",
		snapshotAt: "2026-01-01T00:00:00.000Z",
		costBasis: "unknown",
		dataQuality: "quarantined_no_pricing",
		tediId: null,
		runId: null,
		workItemId: null,
		executionId: null,
		billingReservationId: null,
	};
	const digest = await providerCostEvidenceDigest("source", source);
	const facts = {
		pricingBasis: "reported_estimate",
		provider: "provider",
		nativeModel: "model",
		originalOrgId: org,
		nativeOrgId: org,
		sourceGatewayId: "fictional",
		gatewayLogId: "log",
		sourceCallId: "call",
		occurredAt: source.snapshotAt,
		sourceSnapshotDigest: digest,
		detailReceiptDigest: "b".repeat(64),
		listReceiptDigest: "c".repeat(64),
		usage: {
			inputTokens: 10,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			known: true,
		},
		currency: "USD",
		originalSourceSnapshot: source,
		nativeSourceFingerprint: "d".repeat(64),
		reporter: "cloudflare_ai_gateway",
		reportedCostDecimal: "0.00219662",
		customCost: false,
		wholesale: false,
		costMeaning: "provider_estimate",
		complete: true,
	};
	const manifest = {
		version: 2,
		kind: "provider_estimate_correction",
		action: "billing.recordProviderCostEvidence",
		organizationId: org,
		financialWorkItemId: id(2),
		workVersion: 3,
		specRevision: "e".repeat(32),
		designatedApproverId: id(9),
		deliveredSourceSha: "a".repeat(40),
		expiresAt: expiry,
		currency: "USD",
		manifestMaxMicros: 2197,
		records: [
			{
				facts,
				basisFactsDigest: await providerCostEvidenceDigest("basis", facts),
				expectedParentEvidenceVersionId: null,
				expectedCostMicros: 2197,
				maxCostMicros: 2197,
			},
		],
	};
	a = {
		proposal: {
			id: id(3),
			workItemId: id(2),
			workItemVersion: 3,
			action: manifest.action,
			status: "approved",
			version: 2,
			approverId: id(9),
			approverType: "tedi",
			authorityKey: "risk:high",
			expiresAt: expiry,
			proposal: manifest,
		},
		decision: {
			id: id(4),
			decision: "approved",
			resolvedProposalVersion: 2,
			deciderId: id(9),
			deciderType: "tedi",
		},
		rawProposal: JSON.stringify(manifest),
	};
	b = {
		work: {
			id: id(2),
			orgId: org,
			version: 3,
			admissionSpecRevision: manifest.specRevision,
			disposition: "accepted",
			requiredAuthorities: ["risk:high"],
		},
		attempt: {
			id: id(5),
			runtimeState: "running",
			outcome: null,
			finishedAt: null,
			expiresAt: expiry,
			executorType: "external_agent",
			executorId: id(7),
			executorSessionId: id(8),
			externalSessionKey: "fixture",
		},
		admission: {
			id: id(6),
			decision: "admitted",
			workItemId: id(2),
			workItemVersion: 3,
			admissionSpecRevision: manifest.specRevision,
			expiresAt: expiry,
		},
		requirements: [],
		resources: [],
	};
	input = {
		mode: "validate_only",
		financialWorkItemId: id(2),
		approvalProposalId: id(3),
		approvalDecisionId: id(4),
		attemptId: null,
		records: [
			{
				sourceCallId: "call",
				expectedSourceDigest: digest,
				expectedParentEvidenceVersionId: null,
				idempotencyDigest: "f".repeat(64),
			},
		],
	};
	m.external.mockResolvedValue({
		executor: { id: id(7), sessionId: id(8), type: "external_agent" },
		externalSessionKey: "fixture",
		clientRecordId: "fixture-client",
	});
	m.approval.mockResolvedValue(a);
	m.bundle.mockResolvedValue(b);
	m.source.mockResolvedValue(source);
	m.current.mockResolvedValue(null);
	m.prior.mockResolvedValue(null);
	m.relationships.mockResolvedValue({
		executionSnapshot: null,
		reservationSnapshot: null,
		quarantineSnapshot: null,
	});
	m.append.mockImplementation((_db, p) => ({ row: p.row }));
});
describe("governed provider evidence handler", () => {
	it("validates expired write leases without writes on same DB", async () => {
		b.attempt.expiresAt = "2000-01-01T00:00:00Z";
		a.proposal.expiresAt = b.attempt.expiresAt;
		expect(await recordProviderCostEvidence(c, input)).toMatchObject({
			writes: 0,
			records: [{ status: "validated", calculatedMicros: 2197 }],
		});
		expect(m.append).not.toHaveBeenCalled();
		expect(m.external.mock.calls[0]?.[0].db).toBe(m.db);
	});
	it.each(["tedi", "unprivileged"])(
		"rejects %s before canonical reads",
		async (kind) => {
			if (kind === "tedi") c.authType = "tedi";
			else c.user!.scope = "";
			await expect(recordProviderCostEvidence(c, input)).rejects.toThrow();
			expect(m.approval).not.toHaveBeenCalled();
		},
	);
	it("requires verified external identity too", async () => {
		m.external.mockResolvedValue(null);
		await expect(recordProviderCostEvidence(c, input)).rejects.toThrow();
		expect(m.append).not.toHaveBeenCalled();
	});
	it.each(["source", "decision", "digest", "cap"])(
		"refuses changed %s before writes",
		async (kind) => {
			if (kind === "source") c.env.GIT_SHA = "0".repeat(40);
			if (kind === "decision") a.decision.resolvedProposalVersion = 1;
			if (kind === "digest")
				a.proposal.proposal.records[0].basisFactsDigest = "0".repeat(64);
			if (kind === "cap") a.proposal.proposal.manifestMaxMicros = 2196;
			await expect(recordProviderCostEvidence(c, input)).rejects.toThrow();
			expect(m.append).not.toHaveBeenCalled();
		},
	);
	it("requires a fresh owned Attempt to append", async () => {
		input.mode = "append";
		input.attemptId = id(5);
		b.attempt.expiresAt = "2000-01-01T00:00:00Z";
		await expect(recordProviderCostEvidence(c, input)).rejects.toThrow();
		expect(m.append).not.toHaveBeenCalled();
	});
	it("refuses changed source without a write", async () => {
		m.source.mockResolvedValue({ ...source, gatewayLogId: "changed" });
		expect(await recordProviderCostEvidence(c, input)).toMatchObject({
			writes: 0,
			records: [{ status: "refused" }],
		});
		expect(m.append).not.toHaveBeenCalled();
	});
	it("reads back atomic race refusal", async () => {
		input.mode = "append";
		input.attemptId = id(5);
		expect(await recordProviderCostEvidence(c, input)).toMatchObject({
			writes: 0,
			records: [{ status: "refused" }],
		});
		expect(m.append).toHaveBeenCalledOnce();
		expect(m.execute).toHaveBeenCalledOnce();
		expect(m.append.mock.calls[0]![1].rawProposal).toBe(a.rawProposal);
	});
	it("counts only confirmed append readback", async () => {
		input.mode = "append";
		input.attemptId = id(5);
		m.execute.mockImplementation(async (_db, statements) =>
			m.prior.mockResolvedValue(statements[0].row),
		);
		expect(await recordProviderCostEvidence(c, input)).toMatchObject({
			writes: 1,
			records: [{ status: "appended", persistedMicros: 2197 }],
		});
	});
	it("preserves confirmed writes when a later scoped record is refused", async () => {
		input.mode = "append";
		input.attemptId = id(5);
		input.records.push({
			...input.records[0]!,
			sourceCallId: "unapproved-call",
			idempotencyDigest: "1".repeat(64),
		});
		m.execute.mockImplementation(async (_db, statements) =>
			m.prior.mockResolvedValue(statements[0].row),
		);
		const response = await recordProviderCostEvidence(c, input);
		expect(response.writes).toBe(1);
		expect(response.records.map((r) => r.status)).toEqual([
			"appended",
			"refused",
		]);
		expect(m.append).toHaveBeenCalledOnce();
	});
	it("retries exact evidence without another append and rejects conflicting retry payload", async () => {
		input.mode = "append";
		input.attemptId = id(5);
		let saved: any;
		m.execute.mockImplementation(async (_db, statements) => {
			saved = statements[0].row;
			m.prior.mockResolvedValue(saved);
		});
		expect((await recordProviderCostEvidence(c, input)).writes).toBe(1);
		m.current.mockResolvedValue(saved);
		expect(await recordProviderCostEvidence(c, input)).toMatchObject({
			writes: 0,
			records: [{ status: "existing", persistedMicros: 2197 }],
		});
		m.prior.mockResolvedValue({ ...saved, payloadDigest: "0".repeat(64) });
		expect(await recordProviderCostEvidence(c, input)).toMatchObject({
			writes: 0,
			records: [{ status: "refused" }],
		});
		expect(m.append).toHaveBeenCalledOnce();
	});
	it("refuses an unavailable same-D1 authority binding", async () => {
		c.env.TEDIX_FLEET_AUTHORITY_MODE = "disabled";
		await expect(recordProviderCostEvidence(c, input)).rejects.toThrow();
		expect(m.external).not.toHaveBeenCalled();
	});
	it("retains retired evidence as read-only and refuses append", async () => {
		input.mode = "append";
		input.attemptId = id(5);
		let saved: any;
		m.execute.mockImplementation(async (_db, statements) => {
			saved = statements[0].row;
			m.prior.mockResolvedValue(saved);
		});
		await recordProviderCostEvidence(c, input);
		m.source.mockResolvedValue(null);
		m.current.mockResolvedValue(saved);
		input.mode = "validate_only";
		input.attemptId = null;
		expect(await recordProviderCostEvidence(c, input)).toMatchObject({
			writes: 0,
			records: [
				{ status: "existing", sourceRetired: true, persistedMicros: 2197 },
			],
		});
		input.mode = "append";
		input.attemptId = id(5);
		expect(await recordProviderCostEvidence(c, input)).toMatchObject({
			writes: 0,
			records: [{ status: "refused" }],
		});
		expect(m.append).toHaveBeenCalledOnce();
	});
	it("rejects an expired resource reservation before append", async () => {
		input.mode = "append";
		input.attemptId = id(5);
		b.requirements = [{ resourceKey: "financial-evidence", quantity: 1 }];
		b.resources = [
			{
				resourceKey: "financial-evidence",
				quantity: 1,
				state: "active",
				expiresAt: "2000-01-01T00:00:00Z",
			},
		];
		await expect(recordProviderCostEvidence(c, input)).rejects.toThrow();
		expect(m.append).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		"constructs all records before one batch; transport rejection=%s preserves readback truth",
		async (reject) => {
			input.mode = "append";
			input.attemptId = id(5);
			const secondSource = { ...source, id: "call-2", gatewayLogId: "log-2" };
			const sourceDigest = await providerCostEvidenceDigest(
				"source",
				secondSource,
			);
			const secondFacts = {
				...a.proposal.proposal.records[0].facts,
				sourceCallId: "call-2",
				gatewayLogId: "log-2",
				originalSourceSnapshot: secondSource,
				sourceSnapshotDigest: sourceDigest,
			};
			a.proposal.proposal.records.push({
				...a.proposal.proposal.records[0],
				facts: secondFacts,
				basisFactsDigest: await providerCostEvidenceDigest(
					"basis",
					secondFacts,
				),
			});
			a.proposal.proposal.manifestMaxMicros = 4394;
			a.rawProposal = JSON.stringify(a.proposal.proposal);
			input.records.push({
				...input.records[0]!,
				sourceCallId: "call-2",
				expectedSourceDigest: sourceDigest,
				idempotencyDigest: "1".repeat(64),
			});
			const persisted = new Map<string, any>();
			const phases: string[] = [];
			let executed = false;
			m.source.mockImplementation(async (_db, _org, call) =>
				call === "call" ? source : secondSource,
			);
			m.prior.mockImplementation(async (_db, _org, key) => {
				phases.push(executed ? "readback" : "preflight");
				return persisted.get(key) ?? null;
			});
			m.append.mockImplementation((_db, p) => {
				expect(persisted.size).toBe(0);
				expect(executed).toBe(false);
				phases.push("construct:" + p.row.sourceCallId);
				return { row: p.row };
			});
			m.execute.mockImplementation(async (_db, statements) => {
				expect(statements).toHaveLength(2);
				expect(persisted.size).toBe(0);
				executed = true;
				phases.push("batch");
				for (const statement of statements)
					persisted.set(statement.row.idempotencyDigest, statement.row);
				if (reject) throw new Error("Response lost after commit");
			});
			const response = await recordProviderCostEvidence(c, input);
			expect(response.writes).toBe(2);
			expect(response.records.map((r) => [r.sourceCallId, r.status])).toEqual([
				["call", "appended"],
				["call-2", "appended"],
			]);
			expect(
				phases.filter(
					(p) => p.startsWith("construct") || p === "batch" || p === "readback",
				),
			).toEqual([
				"construct:call",
				"construct:call-2",
				"batch",
				"readback",
				"readback",
			]);
			expect(m.execute).toHaveBeenCalledOnce();
		},
	);
	it("does not invent writes when batch rejects and readback is empty", async () => {
		input.mode = "append";
		input.attemptId = id(5);
		m.execute.mockRejectedValue(new Error("Batch transport refused"));
		expect(await recordProviderCostEvidence(c, input)).toMatchObject({
			writes: 0,
			records: [{ status: "refused", persistedMicros: null }],
		});
		expect(m.execute).toHaveBeenCalledOnce();
	});
});
