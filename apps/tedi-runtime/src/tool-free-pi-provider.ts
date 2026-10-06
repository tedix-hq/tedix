import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import type { TediSessionModelIdentity } from "@tedix/tedi-session/session-harness";
import { createTedixPiProvider, type TedixSdkModel } from "./pi-model";
import type { PiTurnAccounting, PiProviderAttempt } from "./pi-turn-accounting";
import { TEDI_CONTEXT_WINDOW_TOKENS } from "./model-input-budget";

export interface ToolFreePiProviderHost {
	runId(): string | null | undefined;
	assertDispatch?(): Promise<void>;
	receiptOperation?(): string | undefined;
	assertOriginalReceipt?(runId: string, operationId?: string): Promise<void>;
	selected(): { model: TedixSdkModel; identity: TediSessionModelIdentity };
	accounting: Pick<
		PiTurnAccounting,
		"begin" | "prepareStep" | "recordProviderUsage" | "captureProviderAttempt"
	>;
}

export function toolFreePiModel(
	identity: TediSessionModelIdentity,
): Model<Api> {
	return {
		id: `${identity.provider}/${identity.model}`,
		name: identity.model,
		provider: "tedix",
		api: "tedix-ai-sdk",
		baseUrl: "",
		input: ["text", "image"],
		reasoning: true,
		contextWindow: TEDI_CONTEXT_WINDOW_TOKENS,
		maxTokens: 4096,
		// Diagnostic costs never substitute for the canonical budget ledger.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/** Shared dispatch mechanics; the owning facet retains selection, state and receipts. */
export function createToolFreePiModels(host: ToolFreePiProviderHost) {
	const models = createModels();
	models.setProvider(
		createTedixPiProvider<{
			runId: string;
			stepNumber: number;
			providerAttempt: PiProviderAttempt;
			operationId?: string;
		}>({
			catalog: () => [toolFreePiModel(host.selected().identity)],
			resolveModel: (model) => {
				const selected = host.selected();
				if (model.id !== toolFreePiModel(selected.identity).id)
					throw new Error(
						"Pinned tool-free model changed during an admitted turn",
					);
				return selected.model;
			},
			prepare: async (_model, context) => {
				const runId = host.runId();
				if (!runId) throw new Error("Tool-free inference has no admitted run");
				await host.assertDispatch?.();
				await host.accounting.begin(runId);
				const stepNumber = await host.accounting.prepareStep(
					{ messages: context.messages },
					{ maxSteps: 10 },
				);
				return {
					receipt: {
						providerAttempt: await host.accounting.captureProviderAttempt(),
						runId,
						stepNumber,
						operationId: host.receiptOperation?.(),
					},
					callOptions: { toolChoice: { type: "none" }, tools: [] },
				};
			},
			settled: async (receipt, message, measurement) => {
				if (
					!receipt ||
					(!host.assertOriginalReceipt && receipt.runId !== host.runId()) ||
					receipt.runId !== receipt.providerAttempt.runId
				)
					throw new Error("Tool-free usage receipt has stale run identity");
				await host.assertOriginalReceipt?.(receipt.runId, receipt.operationId);
				const usage = measurement.hasUsage
					? {
							inputTokens:
								message.usage.input +
								message.usage.cacheRead +
								message.usage.cacheWrite,
							outputTokens: message.usage.output,
							totalTokens: message.usage.totalTokens,
						}
					: measurement.dispatched
						? { inputTokens: null, outputTokens: null, totalTokens: null }
						: { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
				await host.accounting.recordProviderUsage(
					usage,
					[],
					receipt.providerAttempt,
				);
			},
		}),
	);
	return models;
}
