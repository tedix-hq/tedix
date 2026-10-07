/** Observer inference follows the configured provider and propagates failures. */

import {
	cloudflareAutoRouterModel,
	CLOUDFLARE_AUTO_MODEL_REF,
	DEFAULT_WORKERS_AI_MODEL,
} from "@tedix/workers-ai/model-select";
import { callWorkersAi } from "@tedix/workers-ai/transport";
import {
	aigMetadataRecord,
	observerCompletion as azureObserverCompletion,
	type ObserverCallOptions,
} from "./llm";
import { workersAiClient, type WorkersAiRuntimeEnv } from "./workers-ai-client";

export type ObserverEnv = ObserverCallOptions["env"] & WorkersAiRuntimeEnv;

export interface ConfiguredObserverCallOptions extends Omit<
	ObserverCallOptions,
	"env"
> {
	env: ObserverEnv;
	modelRef?: string | null;
}

async function observerViaAutoRouter(
	opts: ConfiguredObserverCallOptions,
): Promise<string> {
	const model = cloudflareAutoRouterModel(
		workersAiClient(opts.env, opts.beforeDispatch),
		{
			gatewayId: opts.env.AI_GATEWAY_LLM_ID?.trim() ?? "",
			attribution: aigMetadataRecord(opts.metadata) ?? undefined,
		},
	);
	const result = await model.doGenerate({
		prompt: opts.messages.map((message) =>
			message.role === "system"
				? { role: "system", content: message.content }
				: {
						role: message.role,
						content: [{ type: "text", text: message.content }],
					},
		),
		temperature: opts.temperature ?? 0.3,
		maxOutputTokens: opts.maxCompletionTokens ?? 4000,
		responseFormat: { type: "json" },
		abortSignal: opts.signal,
	} as never);
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** Explicit Workers AI model selection. */
async function observerViaWorkersAi(
	opts: ConfiguredObserverCallOptions,
): Promise<string> {
	const modelId = opts.modelRef?.startsWith("workers-ai/")
		? opts.modelRef.slice("workers-ai/".length)
		: opts.env.TEDI_WORKERS_AI_MODEL?.trim() || DEFAULT_WORKERS_AI_MODEL;
	const result = await callWorkersAi(
		workersAiClient(opts.env, opts.beforeDispatch),
		modelId,
		{
			messages: opts.messages,
			temperature: opts.temperature ?? 0.3,
			max_tokens: opts.maxCompletionTokens ?? 4000,
			response_format: { type: "json_object" },
			signal: opts.signal,
			attribution: aigMetadataRecord(opts.metadata) ?? undefined,
		},
	);
	return result.text;
}

export async function observerCompletion(
	opts: ConfiguredObserverCallOptions,
): Promise<string> {
	opts.signal?.throwIfAborted();
	try {
		// No ref = the observer's env default Azure deployment (the runtime's
		// model policy resolves `cloudflare/auto` to no ref for this surface).
		if (opts.modelRef === CLOUDFLARE_AUTO_MODEL_REF)
			return await observerViaAutoRouter(opts);
		if (opts.modelRef?.startsWith("workers-ai/"))
			return await observerViaWorkersAi(opts);
		return await azureObserverCompletion(opts);
	} catch (error) {
		opts.signal?.throwIfAborted();
		throw error;
	}
}
