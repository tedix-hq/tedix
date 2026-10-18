import type { BaseContext } from "../rpc/orpc";

/** One bounded rewrite retains the kernel's region, billing and usage checks. */
export async function runDecisionCardCopyModel(
	context: Pick<BaseContext, "env">,
	prompt: string,
	options: {
		orgId: string;
		model: string;
		maxTokens: number;
		timeoutMs: number;
		system: string;
		rewriteInstruction: string;
		onFailure?: (reason: string) => void;
	},
): Promise<string | null> {
	const deadline = Date.now() + options.timeoutMs;
	try {
		const [{ kernelModel }, { tracedAi }] = await Promise.all([
			import("../rpc/routers/kernel/llm"),
			import("../lib/traced-ai"),
		]);
		const selected = kernelModel(
			context.env,
			{ modelRef: options.model },
			{
				organizationId: options.orgId,
				source: "decision_card_copy",
			},
		);
		if (!selected) {
			options.onFailure?.("model_binding_unavailable");
			return null;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Card copy budget exhausted");
		const rewritten = await tracedAi.generateText({
			maxOutputTokens: options.maxTokens,
			maxRetries: 0,
			system: options.system,
			runtimeContext: { orgId: options.orgId, source: "decision_card_copy" },
			model: selected.model,
			prompt: JSON.stringify({
				source: prompt,
				instruction: options.rewriteInstruction,
			}),
			abortSignal: AbortSignal.timeout(remaining),
		});
		return rewritten.text || null;
	} catch {
		options.onFailure?.(
			Date.now() >= deadline ? "model_timeout" : "model_provider_failed",
		);
		return null;
	}
}
