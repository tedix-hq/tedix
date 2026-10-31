import { AgentTurnDefaultsSchema } from "../schemas/agent-turn-defaults";
import { AGENT_REPLY_LABELS } from "../schemas/agent-turn-triage";

/** Fictional installation configuration for tests; never a production fallback. */
export function agentTurnDefaults() {
	return AgentTurnDefaultsSchema.parse({
		assetVersion: 1,
		policy: {
			enabled: true,
			model: "@cf/cloudflare/clef-flash",
			version: 1,
			questions: [
				{
					id: "example_blocker",
					instructions: "Does this report a blocker?",
					urgentWhen: { gte: 0.5 },
				},
			],
			drafting: { enabled: false },
			autoSend: { enabled: false, maxConsecutive: 3 },
			fyi: { autoAcknowledge: false },
			deliveryGate: {
				model: "@cf/cloudflare/clef-flash",
				questions: [
					{
						id: "example_review",
						instructions: "Does this require review?",
						autoWhen: { lte: 0.2 },
					},
				],
			},
			steering: {
				enabled: false,
				id: "off_track",
				instructions: "Does this violate the configured project rules?",
				steerWhen: { gte: 0.7 },
				draft: "Follow the configured project rules.",
				gateSkips: [],
				escalateNeed: "Please review: {{message}}",
			},
		},
		replyLabel: {
			instructions: "Classify the reply.",
			criteria: Object.fromEntries(
				AGENT_REPLY_LABELS.map((label) => [label, `Example ${label} reply`]),
			),
		},
		replyDraft: {
			promptVersion: 1,
			lines: [
				"Question: {{requestId}}",
				"{{prompt}}",
				"{{sessions}}",
				"{{board}}",
				"{{skill}}",
				"{{turnKind}}",
				"{{examples}}",
			],
		},
		attention: {
			ask: {
				id: "asks_user",
				instructions: "Does this ask the user for a decision?",
				needsYouWhen: { gte: 0.5 },
				noAskPatterns: ["\\bno action needed\\b"],
			},
			turnKind: { fyi: "A status update.", needs_you: "The user is needed." },
			need: {
				maxChars: 160,
				lines: ["Describe what the user must do: {{prompt}}"],
			},
		},
	});
}
