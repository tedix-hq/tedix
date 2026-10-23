import {
	webMcpError,
	webMcpResult,
	type WebMcpToolDef,
	type WebMcpToolResult,
} from "@tedix/webmcp-core/model-context";
import type { DecisionEnvelope } from "@tedix/api-contract/schemas/os-decision-deck";
// Type-only: erased at runtime, so the module stays import-inert.
import type {
	DeckCardAgentHandle,
	DeckCardAgentOutcome,
	DeckNotUsefulHandle,
} from "@/lib/deck-card-agent";
import type { PageChatToolExtras } from "@/lib/page-chat-tools";

/**
 * WebMCP tools for the Decision Deck. Reads return the card on screen. Every
 * write names that card's id, acts through the same controls as the card's
 * buttons so the person watches it happen, and refuses any other card. Only
 * `respond_decision_card` submits a chosen option, and only after the option
 * was prepared on screen and the person explicitly asked to submit it.
 */
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
	/** Upcoming cards, so a card the person names can be shown first. */
	queue?: readonly { id: string; label: string }[];
	/**
	 * Every card still waiting on the person — Deck decisions, approvals and
	 * open factory cards from every card sheet — in the order the Deck ranks
	 * them. Answers "what is waiting for me?" without deciding anything.
	 */
	waiting?: readonly {
		id: string;
		kind: string;
		askKind: string;
		label: string;
		source: string;
		project: string;
		requestedAt?: string;
		deadline: string | null;
		overdue: boolean;
		expired: boolean;
		costOfWaiting: string | null;
	}[];
	agent?: () => DeckCardAgentHandle | null;
	notUseful?: () => DeckNotUsefulHandle | null;
	/** The Deck's Later control for the card on screen, when it offers one. */
	later?: (() => void) | null;
	/** Show a named card; returns false when it is not in this view. */
	show?: (cardId: string) => boolean;
}

const READ = "get_decision_deck_card";
const LIST = "list_decision_deck_cards";
const SHOW = "set_decision_deck_card";
const OPTION = "set_decision_card_option";

const cardIdProperty = {
	type: "string",
	description: `The id of the card on screen, exactly as ${READ} returns it.`,
};

function outcome(result: DeckCardAgentOutcome, cardId: string) {
	return result.ok
		? webMcpResult({ cardId, status: result.status })
		: webMcpError(result.error);
}

function guarded(
	current: () => DecisionDeckController,
	args: Record<string, unknown>,
	act: (
		state: DecisionDeckController,
		cardId: string,
	) => Promise<WebMcpToolResult>,
): Promise<WebMcpToolResult> {
	let state: DecisionDeckController;
	try {
		state = current();
	} catch {
		return Promise.resolve(
			webMcpError("The Decision deck is unavailable. Try again in a moment."),
		);
	}
	const cardId = typeof args.cardId === "string" ? args.cardId : "";
	if (!state.card) return Promise.resolve(webMcpError("No card is on screen."));
	if (cardId !== state.card.id)
		return Promise.resolve(
			webMcpError(
				`Card "${cardId}" is not the card on screen ("${state.card.id}"). Act only on the card in view; if the person named another card, show it with ${SHOW} first.`,
			),
		);
	if (state.mode === "history")
		return Promise.resolve(webMcpError("Past decisions are read-only."));
	return act(state, cardId).catch(() =>
		webMcpError("The card could not be changed. Try again in a moment."),
	);
}

function snapshot(state: DecisionDeckController) {
	const agent = state.agent?.() ?? null;
	return {
		mode: state.mode,
		card: state.card
			? {
					...state.card,
					...(agent
						? {
								answer: {
									field: agent.field,
									value: agent.value,
									suggestedAnswers: agent.suggestedAnswers,
								},
								options: agent.actions,
								preparedOptionId: agent.stagedOptionId,
							}
						: {}),
					canMarkNotUseful: Boolean(state.notUseful?.()),
					canSnooze: Boolean(
						state.later ||
						agent?.actions.some((action) => action.intent === "later"),
					),
				}
			: null,
		readiness: state.readiness,
		remaining: state.remaining,
		queue: state.queue ?? [],
	};
}

export function buildDecisionDeckWebMcpTools(
	current: () => DecisionDeckController,
): WebMcpToolDef[] {
	return [
		{
			name: READ,
			description:
				"Read the Decision deck card on screen with its options, answer field, reasoning and readiness, plus the upcoming card ids. Practice mode has no real effects.",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async () => {
				try {
					return webMcpResult(snapshot(current()));
				} catch {
					return webMcpError(
						"The Decision deck is unavailable. Try again in a moment.",
					);
				}
			},
		},
		{
			name: LIST,
			description:
				"List every card still waiting for the person — Deck decisions, Work and organization approvals, and open factory cards from every card sheet — each with its id, kind, what it asks, its source, how long it has waited and the cost of waiting. Read-only: it answers and changes none of them.",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async () => {
				try {
					return webMcpResult({ cards: current().waiting ?? [] });
				} catch {
					return webMcpError(
						"The Decision deck is unavailable. Try again in a moment.",
					);
				}
			},
		},
		{
			name: SHOW,
			description:
				"Bring a card the person named in this chat onto the screen. Use it only for a card the person asked about; it changes nothing on the card.",
			annotations: {
				readOnlyHint: false,
				untrustedContentHint: false,
				consequentialHint: true,
			},
			inputSchema: {
				type: "object",
				properties: {
					cardId: {
						type: "string",
						description: `A card id from the queue that ${READ} returns.`,
					},
				},
				required: ["cardId"],
				additionalProperties: false,
			},
			execute: async (args) => {
				try {
					const state = current();
					const cardId = typeof args.cardId === "string" ? args.cardId : "";
					if (!state.show?.(cardId))
						return webMcpError(`Card "${cardId}" is not in this Deck view.`);
					return webMcpResult({ cardId, status: "shown" });
				} catch {
					return webMcpError(
						"The Decision deck is unavailable. Try again in a moment.",
					);
				}
			},
		},
		{
			name: "set_decision_card_answer",
			description:
				"Fill the answer or draft on the card on screen with text the person asked for in this chat. Nothing is saved or sent.",
			annotations: {
				readOnlyHint: false,
				untrustedContentHint: false,
				consequentialHint: true,
			},
			inputSchema: {
				type: "object",
				properties: {
					cardId: cardIdProperty,
					text: {
						type: "string",
						minLength: 1,
						maxLength: 4000,
						description: "The answer or draft text the person asked for.",
					},
				},
				required: ["cardId", "text"],
				additionalProperties: false,
			},
			execute: (args) =>
				guarded(current, args, async (state, cardId) => {
					const agent = state.agent?.();
					if (!agent)
						return webMcpError("This card has no answer or draft to fill.");
					if (typeof args.text !== "string" || !args.text.trim())
						return webMcpError("text is required.");
					return outcome(agent.fill(args.text.slice(0, 4000)), cardId);
				}),
		},
		{
			name: OPTION,
			description:
				"Select an option on the card on screen so the person can review it before anything is saved. It does not submit the decision.",
			annotations: {
				readOnlyHint: false,
				untrustedContentHint: false,
				consequentialHint: true,
			},
			inputSchema: {
				type: "object",
				properties: {
					cardId: cardIdProperty,
					optionId: {
						type: "string",
						description: `An option id from ${READ}.`,
					},
				},
				required: ["cardId", "optionId"],
				additionalProperties: false,
			},
			execute: (args) =>
				guarded(current, args, async (state, cardId) => {
					const agent = state.agent?.();
					if (!agent) return webMcpError("This card has no options here.");
					return outcome(agent.stage(String(args.optionId ?? "")), cardId);
				}),
		},
		{
			name: "set_decision_card_later",
			description:
				"Put the card on screen aside for later, as the Deck's Later control does. Use it only when the person asked to snooze or skip this card.",
			annotations: {
				readOnlyHint: false,
				untrustedContentHint: false,
				consequentialHint: true,
			},
			inputSchema: {
				type: "object",
				properties: { cardId: cardIdProperty },
				required: ["cardId"],
				additionalProperties: false,
			},
			execute: (args) =>
				guarded(current, args, async (state, cardId) => {
					const agent = state.agent?.();
					const option = agent?.actions.find(
						(action) => action.intent === "later",
					);
					if (agent && option)
						return outcome(await agent.submit(option.id), cardId);
					if (!state.later)
						return webMcpError("This card has no Later option.");
					state.later();
					return webMcpResult({ cardId, status: "later" });
				}),
		},
		{
			name: "set_decision_card_not_useful",
			description:
				"Mark the card on screen as not useful with the reason the person gave in this chat. The Deck shows Undo afterwards.",
			annotations: {
				readOnlyHint: false,
				untrustedContentHint: false,
				consequentialHint: true,
			},
			inputSchema: {
				type: "object",
				properties: {
					cardId: cardIdProperty,
					reason: {
						type: "string",
						enum: [
							"already_decided",
							"expired",
							"agent_could_do",
							"duplicate",
							"not_for_me",
						],
						description: "Why the card is not useful, as the person said.",
					},
				},
				required: ["cardId", "reason"],
				additionalProperties: false,
			},
			execute: (args) =>
				guarded(current, args, async (state, cardId) => {
					const handle = state.notUseful?.();
					if (!handle)
						return webMcpError("This card cannot be marked not useful here.");
					return outcome(await handle.mark(String(args.reason ?? "")), cardId);
				}),
		},
		{
			name: "respond_decision_card",
			description: `Submit the option already prepared with ${OPTION} on the card on screen, through the card's own controls and confirmation. Set confirmedByUser only when the person explicitly asked in this chat to submit this decision.`,
			annotations: {
				readOnlyHint: false,
				untrustedContentHint: false,
				consequentialHint: true,
			},
			inputSchema: {
				type: "object",
				properties: {
					cardId: cardIdProperty,
					optionId: {
						type: "string",
						description: `The option prepared with ${OPTION}.`,
					},
					confirmedByUser: {
						type: "boolean",
						const: true,
						description:
							"True only when the person explicitly told you in this chat to submit this decision.",
					},
				},
				required: ["cardId", "optionId", "confirmedByUser"],
				additionalProperties: false,
			},
			execute: (args) =>
				guarded(current, args, async (state, cardId) => {
					if (args.confirmedByUser !== true)
						return webMcpError(
							"Not submitted: the person has not explicitly asked to submit this decision. Ask them first.",
						);
					const agent = state.agent?.();
					if (!agent) return webMcpError("This card cannot be submitted here.");
					const optionId = String(args.optionId ?? "");
					if (agent.stagedOptionId !== optionId)
						return webMcpError(
							`Prepare the option with ${OPTION} first so the person sees the filled card, then submit it.`,
						);
					return outcome(await agent.submit(optionId), cardId);
				}),
		},
	];
}

/**
 * What the quick chat adds to the Deck tools when it runs them for the
 * person: plain activity wording, Undo where the card can put itself back,
 * and an inline confirm in the chat before any tool that saves a change
 * (submit, Later, Not useful) runs, even when the model says the person
 * already agreed.
 */
export function buildDecisionDeckPageChatExtras(
	current: () => DecisionDeckController,
): Record<string, PageChatToolExtras> {
	const agent = () => {
		try {
			return current().agent?.() ?? null;
		} catch {
			return null;
		}
	};
	const optionLabel = (optionId: unknown) =>
		agent()?.actions.find((action) => action.id === optionId)?.label ??
		String(optionId ?? "");
	return {
		[READ]: { describe: () => null },
		[LIST]: { describe: () => null },
		[SHOW]: { describe: () => "showed the card" },
		set_decision_card_answer: {
			describe: () =>
				agent()?.field === "draft" ? "filled the draft" : "filled the answer",
			prepareUndo: () => {
				const handle = agent();
				if (!handle?.field) return null;
				const previous = handle.value;
				return () => agent()?.fill(previous);
			},
		},
		[OPTION]: {
			describe: (args) => `chose "${optionLabel(args.optionId)}"`,
			prepareUndo: () => {
				const handle = agent();
				if (!handle?.unstage) return null;
				const previous = handle.stagedOptionId;
				return () => {
					const live = agent();
					if (previous) live?.stage(previous);
					else live?.unstage?.();
				};
			},
		},
		// Later and Not useful save a change, so the person confirms them in
		// the chat like a submit. The Deck shows its own Undo for Not useful.
		set_decision_card_later: {
			confirm: true,
			describe: () => "put the card aside for later",
		},
		set_decision_card_not_useful: {
			confirm: true,
			describe: () => "marked the card not useful",
		},
		respond_decision_card: {
			confirm: true,
			describe: (args) => `submitted "${optionLabel(args.optionId)}"`,
		},
	};
}
