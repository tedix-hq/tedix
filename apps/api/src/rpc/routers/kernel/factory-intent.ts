import type { FactoryChatHealth } from "./factory-chat-tools";
import type { KernelContext } from "./context-assembly";
import type { KernelRouteDecision } from "./route-schema";
import { outputWriteApp } from "./output-create-intent";

export function factoryIntent(
	content: string,
): "create" | "pause" | "resume" | "archive" | "health" | "run" | null {
	// Only the opening request line names a factory command. Pasted context
	// below it (commit subjects, logs) must not turn into a factory operation.
	const text = (content.trim().split(/\r?\n/, 1)[0] ?? "")
		.trim()
		.replace(/^(?:please|can you|could you)\s+/i, "");
	if (text.length > 240) return null;
	if (
		/^(?:explain|how (?:do|can|to)|what is|describe|don't|do not)\b/i.test(text)
	)
		return null;
	const factory = /\bfactor(?:y|ies)\b/i.test(text);
	if (factory && /^(?:pause|resume|archive)\b/i.test(text))
		return text.match(/^(pause|resume|archive)/i)![1]!.toLowerCase() as
			| "pause"
			| "resume"
			| "archive";
	if (factory && /\b(?:health|status|how.*doing)\b/i.test(text))
		return "health";
	if (/^run\b.*\b(?:factory|it|that)\b.*\bnow\b/i.test(text)) return "run";
	if (
		(factory &&
			/^(?:create|build|make|set up)\s+(?:(?:a|an|the|new|small|daily|hourly|comment|inbox)\s+)*factory\b/i.test(
				text,
			)) ||
		/^(?:every morning|every day|daily|every \d+ hours?)\b.*\b(?:summarise|summarize|write|report|collect)\b/i.test(
			text,
		)
	)
		return "create";
	return null;
}

/** Selects the existing planner; schemas, approval and ownership still gate writes. */
export async function factoryChatDecision(
	content: string,
	context: Pick<KernelContext, "apps" | "history">,
	load: () => Promise<FactoryChatHealth[]>,
): Promise<KernelRouteDecision | null> {
	const intent = factoryIntent(content);
	if (!intent) return null;
	const appSlug = outputWriteApp(context.apps);
	if (!appSlug) return null;
	const base: KernelRouteDecision = {
		routeKind: "propose_tool_write",
		answer: null,
		rationale: `The operator requested factory ${intent}.`,
		risk: "medium",
		confidence: 1,
		effortClass: "single_read",
		targetTediId: null,
		targetTediLabel: null,
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: {
			appSlug,
			capability: `factories.${intent}`,
			connectionStatus: "connected",
		},
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation:
			"The approved factory operation's receipt and current schedule state.",
	};
	if (intent === "create") return base;
	let lanes: FactoryChatHealth[];
	try {
		lanes = await load();
	} catch {
		return {
			...base,
			routeKind: "answer_in_home",
			risk: "low",
			toolIntent: null,
			answer:
				"I could not read current factory health. No factory operation was proposed; retry shortly.",
		};
	}

	const matches = (text: string) =>
		lanes.filter((lane) => {
			const escaped = lane.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return (
				new RegExp(`\\b${escaped}\\b`, "i").test(text) ||
				text.toLowerCase().includes(lane.name.toLowerCase())
			);
		});
	let selected = matches(content);
	if (!selected.length && /\b(?:it|that|this)\b/i.test(content)) {
		for (const message of [...context.history].reverse()) {
			const found = matches(message.content);
			if (found.length) {
				selected = found;
				break;
			}
		}
	}
	if (!selected.length && intent === "run" && !/\bfactory\b/i.test(content))
		return null;
	if (selected.length !== 1)
		return {
			...base,
			routeKind: "ask_human",
			risk: "low",
			toolIntent: null,
			clarifyingQuestion: "Which factory do you mean? Give its name or slug.",
			answer: lanes.length
				? `Available factories: ${lanes.map((lane) => lane.slug).join(", ")}.`
				: "No active factory lanes were found.",
		};
	const lane = selected[0]!;
	if (intent === "health")
		return {
			...base,
			routeKind: "answer_in_home",
			risk: "low",
			toolIntent: null,
			answer: `${lane.name}: ${lane.verdict} — ${lane.reason}\nNext scheduled run: ${lane.scheduleEnabled ? (lane.nextFireAt ?? "unknown") : "none"}.${lane.runs[0] ? `\nLatest run: ${lane.runs[0].runId} (${lane.runs[0].status}).` : ""}`,
		};
	return {
		...base,
		rationale: `${base.rationale} Exact factory slug: ${lane.slug}; lane skill id: ${lane.skillId}; owner tedi id: ${lane.ownerTediId}.`,
	};
}
