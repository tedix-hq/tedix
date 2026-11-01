import { isRecord } from "@tedix/api-contract/utils/is-record";

/** Observes the authorized MCP callback, without reading any extra content. */
export async function readWithEvaluationBoundary(input: {
	args: { path?: string; maxChars?: number; evaluationInstructions?: boolean };
	read: () => Promise<unknown>;
	identity: {
		runtimeSource: string;
		environment: string;
		tediId: string;
		slug: string;
	};
}): Promise<unknown> {
	let result: unknown;
	try {
		result = await input.read();
	} catch (error) {
		if (
			input.args.path !== "AGENTS.md" ||
			input.args.evaluationInstructions !== true
		)
			throw error;
		// Keep storage/authorization details private; a failure is never an empty file.
		result = { ok: false, error: "Evaluation instructions unavailable" };
	}
	if (input.args.path !== "AGENTS.md" || !isRecord(result)) return result;
	return {
		...result,
		evaluationReadBoundary: {
			version: 1,
			...input.identity,
			evaluationInstructionsPresent: Object.hasOwn(
				input.args,
				"evaluationInstructions",
			),
			evaluationInstructions: input.args.evaluationInstructions === true,
		},
	};
}
