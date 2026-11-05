import { describe, expect, it, vi } from "vite-plus/test";
import type {
	SignedTaskApproval,
	TaskApproval,
	TaskReceipt,
	TaskResult,
} from "../schemas/task-contract";
import {
	digestTaskPayload,
	executeTaskContract,
	exportWorkTaskContract,
	importTaskResult,
	serializeTaskPayload,
	type TaskContractServices,
} from "./task-contract";

async function sign<T>(payload: T, keyId: string, privateKey: CryptoKey) {
	const signature = await crypto.subtle.sign(
		"Ed25519",
		privateKey,
		new TextEncoder().encode(serializeTaskPayload(payload)),
	);
	return {
		payload,
		signature: {
			keyId,
			value: btoa(String.fromCharCode(...new Uint8Array(signature))),
		},
	};
}

async function fixture() {
	const orgId = "00000000-0000-4000-8000-000000000001";
	const work = {
		id: "00000000-0000-4000-8000-000000000002",
		orgId,
		version: 3,
		title: "Review a report",
		description:
			"Acceptance:\n- [ ] Report has sources\n- [x] Total reconciles",
		disposition: "accepted" as const,
		acceptanceContract: {
			version: 1 as const,
			doneLooksLike: "A sourced, reconciled report",
		},
		requiredCapabilities: ["report_read"],
		requiredAuthorities: ["report_release"],
	};
	const contract = exportWorkTaskContract({
		work,
		contractId: "00000000-0000-4000-8000-000000000003",
		nonce: "00000000-0000-4000-8000-000000000004",
		resources: ["reports/inbox"],
		budget: { maxTokens: 1000, maxCostUsd: 0.5 },
		humanGates: [{ id: "report_release", approverId: "report-owner" }],
		execution: {
			runtimeId: "external-hierarchy",
			spiffeId: "spiffe://example.test/runtime/report",
			modelCalls: "external_gateway",
		},
		expiresAt: "2026-12-01T01:00:00.000Z",
	});
	const runtimeKeys = await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	]);
	const approvalKeys = await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	]);
	const contractDigest = await digestTaskPayload(contract);
	const approval: SignedTaskApproval = await sign<TaskApproval>(
		{
			orgId,
			contractDigest,
			gateId: "report_release",
			approverId: "report-owner",
			actorType: "human",
			decision: "approved",
			reference: "approval:report-release:1",
			expiresAt: "2026-12-01T01:00:00.000Z",
		},
		"human-key",
		approvalKeys.privateKey,
	);
	const payload: TaskResult = {
		orgId,
		contractDigest,
		contractId: contract.contractId,
		nonce: contract.nonce,
		runId: "external-run-1",
		runtimeId: contract.execution.runtimeId,
		spiffeId: contract.execution.spiffeId,
		claims: ["All checks passed"],
		evidenceRefs: ["https://runtime.example.test/runs/1/evidence"],
	};
	const result = await sign(payload, "runtime-key", runtimeKeys.privateKey);
	const receipts = new Map<string, TaskReceipt>();
	const services: TaskContractServices = {
		orgId,
		runtime: {
			...contract.execution,
			keys: new Map([["runtime-key", runtimeKeys.publicKey]]),
		},
		approvalKeys: new Map([["human-key", approvalKeys.publicKey]]),
		store: {
			get: vi.fn(async (tenant, id) =>
				structuredClone(receipts.get(`${tenant}:${id}`) ?? null),
			),
			insertOnce: vi.fn(async (receipt) => {
				const key = `${receipt.orgId}:${receipt.contractId}`;
				if (!receipts.has(key)) receipts.set(key, structuredClone(receipt));
				return structuredClone(receipts.get(key)!);
			}),
		},
		assertActive: vi.fn(async () => {}),
		assertApproval: vi.fn(async () => {}),
		verify: vi.fn(async () => [
			{
				checkId: "check-1",
				passed: true,
				evidenceRefs: ["verifier:source-readback"],
			},
			{
				checkId: "check-2",
				passed: false,
				evidenceRefs: ["verifier:total-mismatch"],
			},
		]),
		now: () => new Date("2026-12-01T00:00:00.000Z"),
	};
	const gateway = { execute: vi.fn(async () => structuredClone(result)) };
	const input = { contract, approvals: [approval], services, gateway };
	return { input, result, receipts, work, runtimeKeys, approvalKeys };
}

describe("Work Task Contract adapter", () => {
	it("imports a successful verified mock gateway receipt", async () => {
		const { input, receipts } = await fixture();
		input.services.verify = async (contract) =>
			contract.acceptanceChecks.map((check) => ({
				checkId: check.id,
				passed: true,
				evidenceRefs: [`verifier:${check.id}:readback`],
			}));
		const receipt = await executeTaskContract(input);
		expect(receipt.verifiedOutcomes.every((outcome) => outcome.passed)).toBe(
			true,
		);
		expect(receipts.get(`${receipt.orgId}:${receipt.contractId}`)).toEqual(
			receipt,
		);
		expect(receipt.result.payload.spiffeId).toBe(
			input.services.runtime.spiffeId,
		);
		expect(receipt.approvals[0]?.payload.reference).toBe(
			"approval:report-release:1",
		);
	});

	it("round-trips through a mock external hierarchy and retains signed claims, approvals and verifier evidence", async () => {
		const { input, result, work, receipts } = await fixture();
		const receipt = await executeTaskContract(input);
		expect(input.contract).toMatchObject({
			workItemId: work.id,
			workVersion: work.version,
			acceptedOutcome: work.acceptanceContract.doneLooksLike,
			budget: { maxTokens: 1000, maxCostUsd: 0.5 },
			scope: {
				capabilities: work.requiredCapabilities,
				resources: ["reports/inbox"],
			},
			requiredAuthorities: work.requiredAuthorities,
			acceptanceChecks: [
				{ id: "check-1", description: "Report has sources" },
				{ id: "check-2", description: "Total reconciles" },
			],
		});
		expect(input.gateway.execute).toHaveBeenCalledWith(input.contract, {
			idempotencyKey: await digestTaskPayload(input.contract),
			approvals: input.approvals,
		});
		expect(receipt.result).toEqual(result);
		expect(receipt.approvals).toEqual(input.approvals);
		expect(receipt.verifiedOutcomes[1]).toMatchObject({
			passed: false,
			evidenceRefs: ["verifier:total-mismatch"],
		});
		expect(receipt.result.payload.claims).toEqual(["All checks passed"]);
		expect(receipts.size).toBe(1);
		expect(work.disposition).toBe("accepted");
	});

	it("makes sequential and concurrent retries idempotent, including a new adapter process using the same store", async () => {
		const { input, receipts } = await fixture();
		const [first, concurrent] = await Promise.all([
			executeTaskContract(input),
			executeTaskContract(input),
		]);
		expect(concurrent).toEqual(first);
		const retried = await executeTaskContract({
			...input,
			services: { ...input.services },
		});
		expect(retried).toEqual(first);
		expect(input.gateway.execute).toHaveBeenCalledTimes(2);
		expect(receipts.size).toBe(1);
	});

	it.each([
		"tenant",
		"nonce",
		"contract",
		"spiffe",
		"runtime",
		"tampered",
		"key",
	])("rejects %s results before receipt insertion", async (attack) => {
		const { input, result, runtimeKeys } = await fixture();
		if (attack === "tenant")
			result.payload.orgId = "00000000-0000-4000-8000-000000000099";
		if (attack === "nonce")
			result.payload.nonce = "00000000-0000-4000-8000-000000000099";
		if (attack === "contract") result.payload.contractDigest = "a".repeat(64);
		if (attack === "spiffe")
			result.payload.spiffeId = "spiffe://attacker.test/runtime/report";
		if (attack === "runtime") result.payload.runtimeId = "attacker";
		if (attack === "tampered") result.payload.claims.push("Forged claim");
		if (attack === "key") result.signature.keyId = "unknown";
		const signed = [
			"tenant",
			"nonce",
			"contract",
			"spiffe",
			"runtime",
		].includes(attack)
			? await sign(result.payload, "runtime-key", runtimeKeys.privateKey)
			: result;
		await expect(
			importTaskResult({ ...input, result: signed }),
		).rejects.toThrow();
		expect(input.services.store.insertOnce).not.toHaveBeenCalled();
		expect(input.services.verify).not.toHaveBeenCalled();
	});

	it("rejects conflicting signed replays and changed contracts while accepting exact retries", async () => {
		const { input, result, runtimeKeys } = await fixture();
		const receipt = await executeTaskContract(input);
		expect(await importTaskResult({ ...input, result })).toEqual(receipt);
		const conflict = await sign(
			{ ...result.payload, runId: "different-run" },
			"runtime-key",
			runtimeKeys.privateKey,
		);
		await expect(
			importTaskResult({ ...input, result: conflict }),
		).rejects.toThrow("replay conflict");
		await expect(
			importTaskResult({
				...input,
				contract: {
					...input.contract,
					budget: { maxTokens: 2000, maxCostUsd: 1 },
				},
				result,
			}),
		).rejects.toThrow();
	});

	it.each([
		"missing",
		"duplicate",
		"tampered",
		"expired",
		"wrong-human",
		"wrong-tenant",
		"revoked",
	])("blocks %s approval before gateway execution", async (attack) => {
		const { input, approvalKeys } = await fixture();
		const approval = input.approvals[0]!;
		if (attack === "missing") input.approvals = [];
		if (attack === "duplicate") input.approvals.push(approval);
		if (attack === "tampered") approval.payload.reference = "forged-reference";
		if (attack === "expired")
			approval.payload.expiresAt = "2026-11-30T00:00:00.000Z";
		if (attack === "wrong-human") approval.payload.approverId = "someone-else";
		if (attack === "wrong-tenant")
			approval.payload.orgId = "00000000-0000-4000-8000-000000000099";
		if (["expired", "wrong-human", "wrong-tenant"].includes(attack))
			input.approvals = [
				await sign(approval.payload, "human-key", approvalKeys.privateKey),
			];
		if (attack === "revoked")
			input.services.assertApproval = async () => {
				throw new Error("Revoked approval");
			};
		await expect(executeTaskContract(input)).rejects.toThrow();
		expect(input.gateway.execute).not.toHaveBeenCalled();
		expect(input.services.store.insertOnce).not.toHaveBeenCalled();
	});

	it.each(["approval", "admission"])(
		"rechecks %s after verification",
		async (gate) => {
			const { input } = await fixture();
			input.services.verify = async () => {
				const reject = async () => {
					throw new Error("Revoked during verification");
				};
				if (gate === "approval") input.services.assertApproval = reject;
				else input.services.assertActive = reject;
				return input.contract.acceptanceChecks.map((check) => ({
					checkId: check.id,
					passed: true,
					evidenceRefs: ["verifier:checked"],
				}));
			};
			await expect(executeTaskContract(input)).rejects.toThrow(
				"Revoked during verification",
			);
			expect(input.services.store.insertOnce).not.toHaveBeenCalled();
		},
	);

	it.each(["missing", "duplicate", "unknown"])(
		"rejects %s verifier checks",
		async (attack) => {
			const { input } = await fixture();
			input.services.verify = async () => {
				const outcome = {
					checkId: "check-1",
					passed: true,
					evidenceRefs: ["verifier:proof"],
				};
				return attack === "missing"
					? [outcome]
					: [
							outcome,
							{
								...outcome,
								checkId: attack === "duplicate" ? "check-1" : "unknown",
							},
						];
			};
			await expect(executeTaskContract(input)).rejects.toThrow(
				"every acceptance check exactly once",
			);
			expect(input.services.store.insertOnce).not.toHaveBeenCalled();
		},
	);

	it("rejects tenant mismatch, expired contracts and stale kernel admission before dispatch", async () => {
		const { input } = await fixture();
		await expect(
			executeTaskContract({
				...input,
				services: { ...input.services, orgId: "other" },
			}),
		).rejects.toThrow("tenant mismatch");
		await expect(
			executeTaskContract({
				...input,
				contract: { ...input.contract, expiresAt: "2026-11-30T00:00:00.000Z" },
			}),
		).rejects.toThrow("expired");
		input.services.assertActive = async () => {
			throw new Error("Work version changed or cancelled");
		};
		await expect(executeTaskContract(input)).rejects.toThrow(
			"Work version changed or cancelled",
		);
		expect(input.gateway.execute).not.toHaveBeenCalled();
	});

	it("fails closed for unaccepted Work, missing checks, duplicate IDs and local model execution", async () => {
		const { input, work } = await fixture();
		const exportInput = {
			...input.contract,
			work,
			resources: input.contract.scope.resources,
		};
		expect(() =>
			exportWorkTaskContract({
				...exportInput,
				work: { ...work, disposition: "proposed" },
			}),
		).toThrow("not accepted");
		expect(() =>
			exportWorkTaskContract({
				...exportInput,
				work: { ...work, acceptanceContract: null },
			}),
		).toThrow("no accepted outcome");
		expect(() =>
			exportWorkTaskContract({
				...exportInput,
				work: { ...work, description: "No checks" },
			}),
		).toThrow();
		await expect(
			executeTaskContract({
				...input,
				contract: {
					...input.contract,
					acceptanceChecks: [
						input.contract.acceptanceChecks[0]!,
						input.contract.acceptanceChecks[0]!,
					],
				},
			}),
		).rejects.toThrow("must be unique");
		await expect(
			executeTaskContract({
				...input,
				contract: {
					...input.contract,
					humanGates: [
						...input.contract.humanGates,
						...input.contract.humanGates,
					],
				},
			}),
		).rejects.toThrow("must be unique");
		await expect(
			executeTaskContract({
				...input,
				contract: {
					...input.contract,
					execution: {
						...input.contract.execution,
						modelCalls: "local" as "external_gateway",
					},
				},
			}),
		).rejects.toThrow();
		expect(input.gateway.execute).not.toHaveBeenCalled();
	});
});
