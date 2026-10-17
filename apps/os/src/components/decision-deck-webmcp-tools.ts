import {
	webMcpResult,
	type WebMcpToolDef,
} from "@tedix/webmcp-core/model-context";
import type { DecisionEnvelope } from "@tedix/api-contract/schemas/os-decision-deck";

export interface DecisionDeckController {
	mode: string;
	card: {
		id: string;
		kind: string;
		label: string;
		decision: DecisionEnvelope | null;
	} | null;
	readiness: {
		unchanged: number;
		ready: boolean;
		delegated: number;
		total: number;
	} | null;
	remaining: number;
}

export function buildDecisionDeckWebMcpTools(
	current: () => DecisionDeckController,
): WebMcpToolDef[] {
	return [
		{
			name: "get_decision_deck_card",
			description:
				"Read the open Decision deck card, its options, consequences, reasoning, cited lessons and readiness. Practice mode has no real effects. Human decisions remain in the app's controls.",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async () => webMcpResult({ ...current() }),
		},
	];
}
