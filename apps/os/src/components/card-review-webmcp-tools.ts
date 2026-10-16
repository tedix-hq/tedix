import type {
	WebMcpToolDef,
	WebMcpToolResult,
} from "@tedix/webmcp-core/model-context";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
// Type-only: erased at runtime, so the module stays import-inert.
import type { PendingRule, ReviewCard } from "@/lib/card-review";

/**
 * WebMCP tools for the Card review app (`tedix:app/card-review`), registered
 * while the app is open through `useAppWebMcpTools`. Every tool calls the
 * same state and callbacks as the app's buttons, so the human sees the card
 * change, the reason chips light up and the "left" count move as the agent
 * works. A verdict is the same sheet-cell write the button makes; "Do it"
 * keeps the button's behaviour and never sends or posts anything.
 */

export type CardReviewActionResult =
	| { ok: true }
	| { ok: false; error: string };

/** The live app state and button callbacks the tools act through. */
export interface CardReviewController {
	loading: boolean;
	card: ReviewCard | null;
	/** Rule text by id for the current card's source. */
	ruleText: ReadonlyMap<string, string> | undefined;
	doIt: "approve" | "copy_and_open" | null;
	/** The open card's Do it label, or null when the card has no action. */
	doItLabel: string | null;
	reasonChips: { useful: readonly string[]; notUseful: readonly string[] };
	channel: string | null;
	channels: readonly string[];
	left: number;
	total: number;
	undoLabel: string | null;
	pendingRules: readonly PendingRule[];
	setVerdict(input: {
		verdict: "useful" | "not_useful" | "do_it";
		chips: string[];
		note: string;
	}): Promise<CardReviewActionResult>;
	snooze(): CardReviewActionResult;
	skip(): CardReviewActionResult;
	undo(): Promise<CardReviewActionResult>;
	setChannel(channel: string | null): void;
	decideRule(
		ruleKey: string,
		status: "accepted" | "rejected",
	): Promise<CardReviewActionResult>;
}

const NEXT = "card_review_next_card";

function projectCard(state: CardReviewController, card: ReviewCard) {
	return {
		cardKey: card.key,
		number: card.number,
		channel: card.channel,
		sourceLabel: card.sourceLabel,
		type: card.type,
		who: card.who,
		source: card.sourceText,
		link: card.link,
		why: card.why,
		rules: card.ruleIds.flatMap((id) => {
			const text = state.ruleText?.get(id);
			return text ? [{ id, text }] : [];
		}),
		action: card.action,
		draft: card.draft,
		sheet: {
			outputId: card.outputId,
			title: card.sheetTitle,
			rowIndex: card.rowIndex,
		},
	};
}

function progress(state: CardReviewController) {
	return {
		left: state.left,
		total: state.total,
		filter: state.channel ?? "all",
	};
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/** The screen re-renders after the call returns; read progress with card_review_next_card. */
function done(
	outcome: CardReviewActionResult,
	data: Record<string, unknown>,
): WebMcpToolResult {
	if (!outcome.ok) return webMcpError(outcome.error);
	return webMcpResult(data);
}

/** The open card, checked against the key the agent read, or an error. */
function currentCard(
	state: CardReviewController,
	cardKey: unknown,
): ReviewCard | WebMcpToolResult {
	if (state.loading && !state.card)
		return webMcpError("Cards are still loading; try again in a moment.");
	const card = state.card;
	if (!card) return webMcpError("No card is open: every card has a verdict.");
	if (typeof cardKey === "string" && cardKey !== card.key)
		return webMcpError(
			`The open card changed (the person may have acted on it). Call ${NEXT} and use its cardKey.`,
		);
	return card;
}

function isCard(value: ReviewCard | WebMcpToolResult): value is ReviewCard {
	return "key" in value;
}

/** Reason chips and note, checked against the chips the app offers. */
function reasonInput(
	state: CardReviewController,
	args: Record<string, unknown>,
): { chips: string[]; note: string } | WebMcpToolResult {
	const offered = [...state.reasonChips.notUseful, ...state.reasonChips.useful];
	const chips = stringList(args.chips);
	const unknown = chips.filter((chip) => !offered.includes(chip));
	if (unknown.length > 0)
		return webMcpError(
			`Unknown reason chip ${unknown.map((c) => `"${c}"`).join(", ")}. Offered: ${offered.join(", ")}.`,
		);
	const note = typeof args.reason === "string" ? args.reason.slice(0, 300) : "";
	return { chips: [...new Set(chips)], note };
}

const reasonProperties = {
	chips: {
		type: "array",
		items: { type: "string" },
		description: `Reason chips exactly as ${NEXT} lists them in reasonChips.`,
	},
	reason: {
		type: "string",
		maxLength: 300,
		description: "Optional reason in the person's words.",
	},
} as const;

const cardKeyProperty = {
	type: "string",
	description: `The cardKey returned by ${NEXT}; the call fails if another card is open.`,
} as const;

/** Build the Card review tool set. Pure so tests can drive execute(). */
export function buildCardReviewWebMcpTools(
	current: () => CardReviewController,
	channels: readonly string[],
): WebMcpToolDef[] {
	const nextCard: WebMcpToolDef = {
		name: NEXT,
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"Read the card the Card review app shows now: its source, type, who, why (with the rules it cites), suggested action, draft, link, and the sheet and row its verdict is written to. Also returns how many cards are left, the active filter, the reason chips, what Do it does and its button label (doItLabel null: the card has no action and Do it is unavailable). card is null when every card has a verdict.",
		inputSchema: { type: "object", properties: {} },
		execute: async () => {
			const state = current();
			return webMcpResult({
				loading: state.loading,
				card: state.card ? projectCard(state, state.card) : null,
				progress: progress(state),
				filters: ["all", ...state.channels],
				reasonChips: state.reasonChips,
				doIt: state.doIt,
				doItLabel: state.doItLabel,
				undo: state.undoLabel,
				pendingRules: state.pendingRules.length,
			});
		},
	};

	const setVerdict: WebMcpToolDef = {
		name: "card_review_set_verdict",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Mark the open card useful or not useful, with optional reason chips and text, exactly like the app's buttons: the verdict is written into the card's sheet row and the next card slides in. card_review_undo reverts it.",
		inputSchema: {
			type: "object",
			properties: {
				cardKey: cardKeyProperty,
				verdict: { type: "string", enum: ["useful", "not_useful"] },
				...reasonProperties,
			},
			required: ["cardKey", "verdict"],
			additionalProperties: false,
		},
		execute: async (args) => {
			const state = current();
			const card = currentCard(state, args.cardKey);
			if (!isCard(card)) return card;
			if (args.verdict !== "useful" && args.verdict !== "not_useful")
				return webMcpError('verdict must be "useful" or "not_useful".');
			const reason = reasonInput(state, args);
			if (!("chips" in reason)) return reason;
			const outcome = await state.setVerdict({
				verdict: args.verdict,
				...reason,
			});
			return done(outcome, {
				cardKey: card.key,
				verdict: args.verdict,
			});
		},
	};

	const doIt: WebMcpToolDef = {
		name: "card_review_do_it",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Press the open card's Do it button (labelled with the card's action). It fails when the card has no action. It writes yes into the card's done column and never sends, posts or changes a mailbox. For a copy_and_open source it also copies the draft and opens the source link, as the button does. card_review_undo reverts the write.",
		inputSchema: {
			type: "object",
			properties: { cardKey: cardKeyProperty, ...reasonProperties },
			required: ["cardKey"],
			additionalProperties: false,
		},
		execute: async (args) => {
			const state = current();
			const card = currentCard(state, args.cardKey);
			if (!isCard(card)) return card;
			const reason = reasonInput(state, args);
			if (!("chips" in reason)) return reason;
			const outcome = await state.setVerdict({ verdict: "do_it", ...reason });
			return done(outcome, { cardKey: card.key, verdict: "do_it" });
		},
	};

	const snooze: WebMcpToolDef = {
		name: "card_review_snooze",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Snooze the open card until tomorrow for this viewer. Writes nothing to the sheet.",
		inputSchema: {
			type: "object",
			properties: { cardKey: cardKeyProperty },
			additionalProperties: false,
		},
		execute: async (args) => {
			const state = current();
			const card = currentCard(state, args.cardKey);
			if (!isCard(card)) return card;
			return done(state.snooze(), { cardKey: card.key });
		},
	};

	const skip: WebMcpToolDef = {
		name: "card_review_skip",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Move the open card to the end of the queue without a verdict. Fails when it is the last card.",
		inputSchema: {
			type: "object",
			properties: { cardKey: cardKeyProperty },
			additionalProperties: false,
		},
		execute: async (args) => {
			const state = current();
			const card = currentCard(state, args.cardKey);
			if (!isCard(card)) return card;
			return done(state.skip(), { cardKey: card.key });
		},
	};

	const undo: WebMcpToolDef = {
		name: "card_review_undo",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Undo the last action in the app (a verdict, Do it, snooze or skip), like its Undo button. A verdict's cells get back their earlier values.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		execute: async () => {
			const state = current();
			const label = state.undoLabel;
			if (!label) return webMcpError("There is nothing to undo.");
			return done(await state.undo(), { undone: label });
		},
	};

	const filter: WebMcpToolDef = {
		name: "card_review_filter",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Show only cards from one channel, or all of them. Changes the filter buttons on screen; writes nothing.",
		inputSchema: {
			type: "object",
			properties: {
				channel: {
					type: "string",
					enum: ["all", ...channels.map((c) => c.toLowerCase())],
				},
			},
			required: ["channel"],
			additionalProperties: false,
		},
		execute: async (args) => {
			const state = current();
			const wanted =
				typeof args.channel === "string" ? args.channel.toLowerCase() : "";
			const match =
				wanted === "all"
					? null
					: state.channels.find((c) => c.toLowerCase() === wanted);
			if (match === undefined)
				return webMcpError(
					`No "${String(args.channel)}" cards here. Filters: all, ${state.channels.join(", ")}.`,
				);
			state.setChannel(match);
			return webMcpResult({ filter: match ?? "all" });
		},
	};

	const listRules: WebMcpToolDef = {
		name: "card_review_pending_rules",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List the rule changes the factory suggested (rules-sheet rows with status proposed) that the app shows above the cards.",
		inputSchema: { type: "object", properties: {} },
		execute: async () =>
			webMcpResult({
				rules: current().pendingRules.map((rule) => ({
					ruleKey: rule.key,
					id: rule.id,
					text: rule.text,
					sourceLabel: rule.sourceLabel,
				})),
			}),
	};

	const decideRule: WebMcpToolDef = {
		name: "card_review_decide_rule",
		annotations: { readOnlyHint: false, untrustedContentHint: false },
		description:
			"Accept or reject one suggested rule change, like its Accept and Reject buttons: the rule's status cell becomes accepted or rejected.",
		inputSchema: {
			type: "object",
			properties: {
				ruleKey: {
					type: "string",
					description: "The ruleKey from card_review_pending_rules.",
				},
				decision: { type: "string", enum: ["accept", "reject"] },
			},
			required: ["ruleKey", "decision"],
			additionalProperties: false,
		},
		execute: async (args) => {
			const state = current();
			if (args.decision !== "accept" && args.decision !== "reject")
				return webMcpError('decision must be "accept" or "reject".');
			const rule = state.pendingRules.find((r) => r.key === args.ruleKey);
			if (!rule)
				return webMcpError(
					"That rule is not pending. Call card_review_pending_rules again.",
				);
			const status = args.decision === "accept" ? "accepted" : "rejected";
			const outcome = await state.decideRule(rule.key, status);
			if (!outcome.ok) return webMcpError(outcome.error);
			return webMcpResult({ ruleKey: rule.key, id: rule.id, status });
		},
	};

	return [
		nextCard,
		setVerdict,
		doIt,
		snooze,
		skip,
		undo,
		filter,
		listRules,
		decideRule,
	];
}
