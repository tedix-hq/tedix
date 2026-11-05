import type * as z from "zod";
import {
	SignedTaskApprovalSchema,
	SignedTaskResultSchema,
	TaskContractSchema,
	TaskContractWorkSchema,
	TaskReceiptSchema,
	TaskVerifiedOutcomeSchema,
	type SignedTaskApproval,
	type TaskContract,
	type TaskReceipt,
	type TaskResult,
	type TaskVerifiedOutcome,
} from "../schemas/task-contract";

const encoder = new TextEncoder();

/** Sorted JSON keys make signatures independent of transport key order. */
export function serializeTaskPayload(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return `${value}`;
	if (Array.isArray(value))
		return `[${value.map(serializeTaskPayload).join(",")}]`;
	if (typeof value === "object" && value !== null)
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${serializeTaskPayload((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	throw new TypeError("Task payload must contain JSON values only");
}

export async function digestTaskPayload(value: unknown): Promise<string> {
	return [
		...new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				encoder.encode(serializeTaskPayload(value)),
			),
		),
	]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function exportWorkTaskContract(input: {
	work: z.infer<typeof TaskContractWorkSchema>;
	contractId: string;
	nonce: string;
	resources: string[];
	budget: TaskContract["budget"];
	humanGates: TaskContract["humanGates"];
	execution: TaskContract["execution"];
	expiresAt: string;
}): TaskContract {
	const work = TaskContractWorkSchema.parse(input.work);
	if (work.disposition !== "accepted") throw new Error("Work is not accepted");
	const acceptedOutcome = work.acceptanceContract?.doneLooksLike;
	if (!acceptedOutcome) throw new Error("Work has no accepted outcome");
	const checks = [
		...(work.description ?? "").matchAll(/^\s*- \[[ xX]\] (.+)$/gm),
	];
	return TaskContractSchema.parse({
		format: "tedix.task-contract/v1",
		contractId: input.contractId,
		nonce: input.nonce,
		workItemId: work.id,
		workVersion: work.version,
		orgId: work.orgId,
		title: work.title,
		acceptedOutcome,
		acceptanceChecks: checks.map((match, index) => ({
			id: `check-${index + 1}`,
			description: match[1],
		})),
		scope: {
			capabilities: work.requiredCapabilities,
			resources: input.resources,
		},
		budget: input.budget,
		requiredAuthorities: work.requiredAuthorities,
		humanGates: input.humanGates,
		execution: input.execution,
		expiresAt: input.expiresAt,
	});
}

export interface TaskReceiptStore {
	/** Durable, tenant-scoped lookup; never share a cache across tenants. */
	get(orgId: string, contractId: string): Promise<TaskReceipt | null>;
	/**
	 * Atomically insert once per (orgId, contractId), returning the stored row.
	 * A conflicting result must not replace the original receipt. Persist receipt
	 * and its Work evidence link together; this does not settle the Work Attempt.
	 */
	insertOnce(receipt: TaskReceipt): Promise<TaskReceipt>;
}

export interface TaskContractServices {
	orgId: string;
	/** Trusted registration, not identities or public keys supplied by a result. */
	runtime: {
		runtimeId: string;
		spiffeId: string;
		keys: ReadonlyMap<string, CryptoKey>;
	};
	approvalKeys: ReadonlyMap<string, CryptoKey>;
	store: TaskReceiptStore;
	/** Kernel rechecks admission, Work version, budget, gates and cancellation. */
	assertActive(contract: TaskContract): Promise<void>;
	/** Consult the canonical approval record, including revocation and human identity. */
	assertApproval(
		approval: SignedTaskApproval,
		contract: TaskContract,
	): Promise<void>;
	verify(
		contract: TaskContract,
		result: TaskResult,
	): Promise<TaskVerifiedOutcome[]>;
	now(): Date;
}

async function verifySignature(
	value: { payload: unknown; signature: { keyId: string; value: string } },
	keys: ReadonlyMap<string, CryptoKey>,
): Promise<void> {
	const key = keys.get(value.signature.keyId);
	if (!key || key.type !== "public" || key.algorithm.name !== "Ed25519")
		throw new Error("Untrusted signing key");
	const signature = Uint8Array.from(atob(value.signature.value), (char) =>
		char.charCodeAt(0),
	);
	if (
		!(await crypto.subtle.verify(
			"Ed25519",
			key,
			signature,
			encoder.encode(serializeTaskPayload(value.payload)),
		))
	)
		throw new Error("Invalid task signature");
}

async function validateContract(
	contract: TaskContract,
	services: TaskContractServices,
) {
	if (contract.orgId !== services.orgId)
		throw new Error("Task tenant mismatch");
	if (
		contract.execution.runtimeId !== services.runtime.runtimeId ||
		contract.execution.spiffeId !== services.runtime.spiffeId
	)
		throw new Error("Untrusted external runtime");
	if (Date.parse(contract.expiresAt) <= services.now().getTime())
		throw new Error("Task expired");
	await services.assertActive(contract);
}

async function validateApprovals(
	contract: TaskContract,
	raw: unknown[],
	services: TaskContractServices,
) {
	const approvals = raw.map((value) => SignedTaskApprovalSchema.parse(value));
	const digest = await digestTaskPayload(contract);
	if (
		approvals.length !== contract.humanGates.length ||
		new Set(approvals.map((item) => item.payload.gateId)).size !==
			approvals.length
	)
		throw new Error("Required human approvals missing or duplicated");
	for (const approval of approvals) {
		const gate = contract.humanGates.find(
			(item) => item.id === approval.payload.gateId,
		);
		if (
			!gate ||
			approval.payload.orgId !== contract.orgId ||
			approval.payload.contractDigest !== digest ||
			approval.payload.approverId !== gate.approverId ||
			Date.parse(approval.payload.expiresAt) <= services.now().getTime()
		)
			throw new Error("Human approval binding mismatch or expired");
		await verifySignature(approval, services.approvalKeys);
		await services.assertApproval(approval, contract);
	}
	return approvals;
}

/** Import evidence only. Runtime claims cannot settle Work or bypass its gates. */
export async function importTaskResult(input: {
	contract: TaskContract;
	result: unknown;
	approvals: unknown[];
	services: TaskContractServices;
}): Promise<TaskReceipt> {
	const contract = TaskContractSchema.parse(input.contract);
	const services = input.services;
	await validateContract(contract, services);
	const approvals = await validateApprovals(
		contract,
		input.approvals,
		services,
	);
	const result = SignedTaskResultSchema.parse(input.result);
	const contractDigest = await digestTaskPayload(contract);
	if (
		result.payload.orgId !== contract.orgId ||
		result.payload.contractId !== contract.contractId ||
		result.payload.contractDigest !== contractDigest ||
		result.payload.nonce !== contract.nonce ||
		result.payload.runtimeId !== contract.execution.runtimeId ||
		result.payload.spiffeId !== contract.execution.spiffeId
	)
		throw new Error("Task result binding mismatch");
	await verifySignature(result, services.runtime.keys);
	const resultDigest = await digestTaskPayload(result.payload);
	function checkStored(raw: TaskReceipt): TaskReceipt {
		const stored = TaskReceiptSchema.parse(raw);
		if (
			stored.orgId !== contract.orgId ||
			stored.contractId !== contract.contractId ||
			stored.contractDigest !== contractDigest ||
			stored.resultDigest !== resultDigest
		)
			throw new Error("Task result replay conflict");
		return stored;
	}
	const existing = await services.store.get(
		contract.orgId,
		contract.contractId,
	);
	if (existing) return checkStored(existing);
	const verifiedOutcomes = (
		await services.verify(
			structuredClone(contract),
			structuredClone(result.payload),
		)
	).map((outcome) => TaskVerifiedOutcomeSchema.parse(outcome));
	if (
		verifiedOutcomes.length !== contract.acceptanceChecks.length ||
		new Set(verifiedOutcomes.map((outcome) => outcome.checkId)).size !==
			verifiedOutcomes.length ||
		contract.acceptanceChecks.some(
			(check) =>
				!verifiedOutcomes.some((outcome) => outcome.checkId === check.id),
		)
	)
		throw new Error("Verifier must cover every acceptance check exactly once");
	await validateContract(contract, services);
	await validateApprovals(contract, approvals, services);
	const receipt = TaskReceiptSchema.parse({
		format: "tedix.task-receipt/v1",
		orgId: contract.orgId,
		workItemId: contract.workItemId,
		workVersion: contract.workVersion,
		contractId: contract.contractId,
		contractDigest,
		resultDigest,
		result,
		approvals,
		verifiedOutcomes,
		verifiedAt: services.now().toISOString(),
	});
	return checkStored(await services.store.insertOnce(receipt));
}

export async function executeTaskContract(input: {
	contract: TaskContract;
	approvals: unknown[];
	services: TaskContractServices;
	/** External gateway owns its hierarchy, checkpoints and all model calls. */
	gateway: {
		execute(
			contract: TaskContract,
			options: { idempotencyKey: string; approvals: SignedTaskApproval[] },
		): Promise<unknown>;
	};
}): Promise<TaskReceipt> {
	const contract = TaskContractSchema.parse(input.contract);
	await validateContract(contract, input.services);
	const approvals = await validateApprovals(
		contract,
		input.approvals,
		input.services,
	);
	const existing = await input.services.store.get(
		contract.orgId,
		contract.contractId,
	);
	if (existing)
		return importTaskResult({ ...input, contract, result: existing.result });
	await validateContract(contract, input.services);
	const result = await input.gateway.execute(structuredClone(contract), {
		idempotencyKey: await digestTaskPayload(contract),
		approvals: structuredClone(approvals),
	});
	return importTaskResult({ ...input, contract, result });
}
