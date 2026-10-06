/**
 * Reflector — HTTP/LLM runtime side.
 *
 * Pure shape helpers (`noopReflection`, `finalizeReflection`,
 * `tokensForSerialized`, `parseReflectorObservations`) live in
 * `@tedix/context-core/reflector`. This module wires:
 *   - injected `LlmClient` for the chat call (Azure for container, Workers AI
 *     binding for isolate tedis)
 *   - injected serializer so we don't reach into the tedix-context store layer
 */

import {
	finalizeReflection,
	noopReflection,
	parseReflectorObservations,
	tokensForSerialized,
} from "@tedix/context-core/reflector";
import { REFLECTOR_SYSTEM_PROMPT } from "@tedix/context-core/prompts";
import type { Observation, ReflectionResult } from "@tedix/context-core/types";
import type { LlmClient } from "./llm-client.js";

interface Logger {
	log(msg: string): void;
	error?(msg: string, err?: unknown): void;
}

const defaultLogger: Logger = {
	log: (msg) => console.log(msg),
	error: (msg, err) => console.error(msg, err),
};

export interface ReflectOptions {
	observations: Observation[];
	llm: LlmClient;
	/** Deployment / model name for the reflector. */
	model: string;
	/** Serializer for token counting + LLM input. Caller-owned. */
	serialize: (observations: Observation[]) => string;
	logger?: Logger;
	signal?: AbortSignal;
}

/** Call the Reflector LLM to condense observations. */
export async function reflect(
	options: ReflectOptions,
): Promise<ReflectionResult> {
	const {
		observations,
		llm,
		model,
		serialize,
		logger = defaultLogger,
		signal,
	} = options;
	const tokensBefore = tokensForSerialized(serialize(observations));

	const input = { observations };

	let response: { content: string | null };
	try {
		response = await llm.chat({
			model,
			messages: [
				{ role: "system", content: REFLECTOR_SYSTEM_PROMPT },
				{
					role: "user",
					content: `Today is ${new Date().toISOString().split("T")[0]}.\n\nObservations to condense:\n\n${JSON.stringify(input)}`,
				},
			],
			temperature: 0.2,
			maxCompletionTokens: 6000,
			responseFormatJson: true,
			signal,
		});
	} catch (err) {
		logger.error?.("[brain-bridge] Reflector LLM error:", err);
		return noopReflection(observations, tokensBefore);
	}

	const content = response.content;
	if (!content) return noopReflection(observations, tokensBefore);

	const condensed = parseReflectorObservations(content);
	if (condensed.length === 0) {
		return noopReflection(observations, tokensBefore);
	}

	const tokensAfter = tokensForSerialized(serialize(condensed));

	if (tokensAfter >= tokensBefore) {
		logger.log(
			`[brain-bridge] Reflector expanded ${tokensBefore} → ${tokensAfter} tokens — keeping original`,
		);
	}

	return finalizeReflection({
		original: observations,
		condensed,
		tokensBefore,
		tokensAfter,
	});
}
