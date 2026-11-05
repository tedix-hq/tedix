import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import candidate from "@tedix/api-contract/assets/decision-cascade.v1.json";
import { DecisionCascadePolicySchema } from "@tedix/api-contract/schemas/decision-cascade";
import { dispatchCascadeJev } from "./decision-cascade-jev";
import {
	evaluateDecisionCascade,
	type CascadeDispatch,
} from "./decision-cascade";
import { JevResponseError } from "@tedix/workers-ai/jev";

const mocks = vi.hoisted(() => ({
	call: vi.fn(),
	reserve: vi.fn(),
	rate: vi.fn(),
	insert: vi.fn(),
}));
vi.mock("@tedix/workers-ai/jev", async (original) => ({
	...(await original<typeof import("@tedix/workers-ai/jev")>()),
	callJev: mocks.call,
}));
vi.mock("../rpc/routers/kernel/billing-reservation", () => ({
	reserveKernelBilling: mocks.reserve,
}));
vi.mock("./provider-model-pricing", () => ({
	resolveProviderModelRate: mocks.rate,
}));
vi.mock("@tedix/db/queries/tedi-usage", () => ({
	insertCallCosts: mocks.insert,
}));

const execution = {
	db: {} as never,
	env: {},
	context: { organizationId: "fictional-org" },
	billingSource: "system" as const,
	sessionType: "unattributed" as const,
};
const request: CascadeDispatch = {
	tier: "judgment",
	model: candidate.judgmentModel,
	sampleId: "sample-1",
	perspective: "counterexample",
	skipResponseCache: true,
	judgment: null,
	input: {
		request: "Is revision 4 delivered?",
		labels: ["SUPPORTED", "UNKNOWN"],
		evidence: [
			{ id: "source", revision: "4", excerpt: "Revision 4 delivered." },
		],
		reserved: false,
		risky: false,
		synthesis: false,
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.insert.mockResolvedValue([]);
	mocks.rate.mockResolvedValue({
		status: "resolved",
		rate: {
			id: "rate-1",
			inputMicrousdPerMillion: 42000,
			outputMicrousdPerMillion: 0,
			cacheReadMicrousdPerMillion: 0,
			cacheWriteMicrousdPerMillion: 0,
		},
	});
	mocks.reserve.mockImplementation(async (_env, input) => {
		const executionId = crypto.randomUUID();
		input.context.executionAttempts.push({
			identity: input.execution,
			occurredAt: "2026-11-01T00:00:00Z",
			executionId,
		});
		return {
			...input.context,
			executionId,
			billingReservationId: "reservation",
		};
	});
	mocks.call.mockImplementation(async (client, input) => {
		const { resolveJevExecution } = await vi.importActual<
			typeof import("@tedix/workers-ai/jev")
		>("@tedix/workers-ai/jev");
		await client.authorize({
			execution: resolveJevExecution(
				{ AI_GATEWAY_ACCOUNT_ID: "fictional", AI_GATEWAY_LLM_ID: "fictional" },
				input.model,
			),
			body: JSON.stringify(input),
		});
		return {
			model: "clef-flash",
			usage: { input_tokens: 100, output_tokens: 0 },
			answers: {
				decision: { type: "choice", choice: "l0", confidence: 0.97 },
				c0: { type: "choice", choice: "supported", confidence: 0.92 },
			},
		};
	});
});

describe("admitted cascade judgment adapter", () => {
	it("uses typed questions and joins the actual persisted execution and price", async () => {
		const result = await dispatchCascadeJev(execution, request);
		expect(result).toMatchObject({
			status: "ok",
			value: {
				label: "SUPPORTED",
				confidence: 0.92,
				citations: [{ id: "source", revision: "4" }],
			},
			receipt: {
				requestedModel: request.model,
				resolvedModel: "clef-flash",
				costMicros: 5,
				usagePersisted: true,
			},
		});
		expect(result.status !== "blocked" && result.receipt?.executionId).toBe(
			mocks.insert.mock.calls[0]![1][0].executionId,
		);
		expect(mocks.call.mock.calls[0]![1]).toMatchObject({
			model: request.model,
			state: { sampleId: request.sampleId, perspective: request.perspective },
			questions: {
				decision: {
					type: "choice",
					criteria: { l0: "SUPPORTED", l1: "UNKNOWN", l2: "ABSTAIN" },
				},
				c0: { type: "choice" },
			},
		});
		expect(mocks.call).toHaveBeenCalledTimes(1);
	});
	it("does not return a receipt before the paid usage write settles", async () => {
		let persist!: () => void;
		mocks.insert.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					persist = resolve;
				}),
		);
		let finished = false;
		const pending = dispatchCascadeJev(execution, request).then((result) => {
			finished = true;
			return result;
		});
		await vi.waitFor(() => expect(mocks.insert).toHaveBeenCalledTimes(1));
		expect(finished).toBe(false);
		persist();
		expect((await pending).status).toBe("ok");
	});
	it("stops without escalation when admission or transport leaves no receipt", async () => {
		mocks.reserve.mockRejectedValueOnce(new Error("billing denied"));
		const result = await evaluateDecisionCascade(
			DecisionCascadePolicySchema.parse({ ...candidate, mode: "evaluate" }),
			request.input,
			{
				dispatch: (send) => dispatchCascadeJev(execution, send),
				validateCitations: () => true,
			},
		);
		expect(result).toMatchObject({
			status: "stopped",
			reason: "accounting",
			receipts: [],
		});
		expect(mocks.call).toHaveBeenCalledTimes(1);
		expect(mocks.insert).not.toHaveBeenCalled();
	});
	it("retains usage but never invents a resolved model for rejected paid answers", async () => {
		const send = mocks.call.getMockImplementation()!;
		mocks.call.mockImplementationOnce(async (...args) => {
			await send(...args);
			throw new JevResponseError("invalid answer", {
				input_tokens: 100,
				output_tokens: 0,
			});
		});
		expect(await dispatchCascadeJev(execution, request)).toMatchObject({
			status: "unavailable",
			receipt: { resolvedModel: null, usagePersisted: true, costMicros: 5 },
		});
		expect(mocks.call).toHaveBeenCalledTimes(1);
		expect(mocks.insert).toHaveBeenCalledTimes(1);
	});
	it("never publishes successful accounting after failed persistence", async () => {
		mocks.insert.mockRejectedValue(new Error("D1 down"));
		await expect(dispatchCascadeJev(execution, request)).rejects.toMatchObject({
			name: "JevUsagePersistenceError",
		});
		expect(mocks.call).toHaveBeenCalledTimes(1);
	});
	it.each(["draft", "strong"] as const)(
		"rejects %s before sending a bounded judgment",
		async (tier) => {
			expect(await dispatchCascadeJev(execution, { ...request, tier })).toEqual(
				{ status: "blocked", reason: "admission" },
			);
			expect(mocks.call).not.toHaveBeenCalled();
		},
	);
	it("reserved input never dispatches", async () => {
		expect(
			await dispatchCascadeJev(execution, {
				...request,
				input: { ...request.input, reserved: true },
			}),
		).toEqual({ status: "blocked", reason: "admission" });
		expect(mocks.call).not.toHaveBeenCalled();
	});
});
