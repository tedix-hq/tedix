/**
 * Deterministic check for an explicit request to create a Tedix output
 * ("Create a 3-slide deck about X", "make a sheet of our vendors").
 *
 * The kernel routes explicit creates directly to the write planner through
 * the tenant's Code Mode gateway, where
 * `canonicalWriteToolName` resolves `os.create_os_output`. Approval policy is
 * unchanged: the write is a proposal like any other.
 *
 * Pure, synchronous, no imports from the planner runtime.
 */

import type { KernelRouteDecision } from "./route-schema";

export type OutputCreateKind = "document" | "sheet" | "presentation";

/** An optional polite or "can you" lead-in before the verb. */
const LEAD_IN_RE =
	/^(?:(?:hey|hi|ok|okay)\b[\s,]*)?(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?(?:to\s+)?|let'?s\s+)?/i;
const CREATE_VERB_RE =
	/^(?:create|make|build|draft|generate|write|prepare|put\s+together|start)\b\s*/i;
/** Words that may sit between the verb and the output noun. */
// "The" is left out on purpose: "make the deck shorter" edits an existing one.
// A lone "slide" is a slide inside a deck; "slide deck" still reads as a deck.
const MODIFIER_RE =
	/^(?:me|us|a|an|new|short|quick|simple|brief|basic|blank|clean|small|slide|[0-9]+(?:-?(?:slides?|pages?|tabs?|columns?|rows?|sections?))?|one|two|three|four|five|six|seven|eight|nine|ten)$/i;
/** "a new sheet in the budget": a part of an existing output. */
const INSIDE_RE = /^(?:in|inside|into|within)$/i;
const KIND_WORDS: ReadonlyArray<readonly [RegExp, OutputCreateKind]> = [
	[/^(?:deck|decks|presentations?|slideshow)$/i, "presentation"],
	[/^(?:sheet|sheets|spreadsheets?)$/i, "sheet"],
	[/^(?:doc|docs|document|documents)$/i, "document"],
];
/** The operator named another provider, so the Tedix output is not meant. */
const EXTERNAL_PROVIDER_RE =
	/\b(?:google|gdrive|notion|excel|microsoft|powerpoint|keynote|office ?365|onedrive|sharepoint|airtable|dropbox|canva|figma)\b/i;
/** A question about how to create one, not a request to create it. */
const HOW_TO_RE = /^(?:how|what|why|when|where|which|who)\b/i;
const MAX_MODIFIERS = 4;

/**
 * The output kind when the request opens with a create verb whose object is a
 * named Tedix output type. Null otherwise, including for questions and for
 * requests that name an external provider.
 */
export function explicitOutputCreateKind(
	content: string,
): OutputCreateKind | null {
	const firstLine = content.trim().split("\n", 1)[0]?.trim() ?? "";
	if (!firstLine || HOW_TO_RE.test(firstLine)) return null;
	if (EXTERNAL_PROVIDER_RE.test(firstLine)) return null;
	const afterLeadIn = firstLine.replace(LEAD_IN_RE, "");
	const verb = CREATE_VERB_RE.exec(afterLeadIn);
	if (!verb) return null;
	const words = afterLeadIn
		.slice(verb[0].length)
		.split(/\s+/)
		.map((word) => word.replace(/[^\p{L}\p{N}-]+$/u, ""));
	for (const [index, word] of words.entries()) {
		if (index > MAX_MODIFIERS) return null;
		const kind = KIND_WORDS.find(([pattern]) => pattern.test(word))?.[1];
		if (kind) return INSIDE_RE.test(words[index + 1] ?? "") ? null : kind;
		if (!MODIFIER_RE.test(word)) return null;
	}
	return null;
}

const CAPABILITY_BY_KIND: Record<OutputCreateKind, string> = {
	document: "documents.create",
	sheet: "sheets.create",
	presentation: "presentations.create",
};

const EDIT_CAPABILITY_BY_KIND: Record<OutputCreateKind, string> = {
	document: "documents.patch",
	sheet: "sheets.set_range",
	presentation: "presentations.patch",
};

/** A narrow edit with its typed target id; titles and implicit targets need planning. */
export function explicitOutputEditKind(
	content: string,
): OutputCreateKind | null {
	const line = content.trim().split("\n", 1)[0]?.replace(LEAD_IN_RE, "") ?? "";
	if (EXTERNAL_PROVIDER_RE.test(line)) return null;
	const id = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
	if (
		/^(?:append|add)\b[^.?!]*\bparagraph\b/i.test(line) &&
		new RegExp(`\\b(?:doc|document)\\s+${id}\\b`, "i").test(line)
	)
		return "document";
	if (
		/^(?:update|set|change)\s+(?:the\s+)?(?:cell|range)\b/i.test(line) &&
		new RegExp(`\\b(?:sheet|spreadsheet)\\s+${id}\\b`, "i").test(line)
	)
		return "sheet";
	if (
		/^(?:change|update|edit)\b[^.?!]*\bslide\b/i.test(line) &&
		new RegExp(`\\b(?:presentation|deck)\\s+${id}\\b`, "i").test(line)
	)
		return "presentation";
	return null;
}

const UUID_SOURCE = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
/** "mark it useful: great angle", "mark that card not useful", "useful: timely". */
const CARD_VERDICT_RE =
	/^(?:(?:mark|set|rate|record)\s+(?:it|this|that|the)(?:\s+(?:card|one|row))?\s+(?:as\s+)?)?(not\s+useful|useful|done|did\s+it)\b\s*(?:[:,–—-]\s*(.*))?$/i;

/** `**Sheet:** Social cards 2026-10-16 08:15`, `Sheet: "Inbox cards …"`. */
const SHEET_TITLE_RE =
	/^\W*sheet\W{0,4}?:\W*["“']?([^"”'\n*]{3,200}?)["”']?\s*$/gim;

export type CardVerdictFollowUp = {
	outputId: string | null;
	sheetTitle: string | null;
	card: string;
	verdict: string;
	reason: string;
};

/**
 * A short verdict on the card the previous answer showed. The card lives in a
 * Tedix sheet that answer cites by id or by a `Sheet:` title line, so the
 * follow-up is a range write to that sheet's row, never a fresh delegation
 * that has lost the reference. Null unless the previous answer names exactly
 * one card and exactly one sheet.
 */
export function cardVerdictFollowUp(
	content: string,
	previousAnswer: string | null | undefined,
): CardVerdictFollowUp | null {
	// OS workspace references precede the operator's request in workspace chat.
	const line =
		content
			.replace(/^(?:\s*\[\[tedix-context:[^\]\r\n]*\]\])+\s*/, "")
			.trim()
			.split("\n", 1)[0]
			?.replace(LEAD_IN_RE, "") ?? "";
	const match = CARD_VERDICT_RE.exec(line.trim());
	if (!match?.[1] || !previousAnswer) return null;
	const titles = [
		...new Set(
			[...previousAnswer.matchAll(SHEET_TITLE_RE)].map((hit) => hit[1]!.trim()),
		),
	];
	const ids = [
		...new Set(
			(
				previousAnswer.match(
					new RegExp(`\\boutput\\s+\`?(${UUID_SOURCE})`, "gi"),
				) ?? []
			).map((hit) => hit.match(new RegExp(UUID_SOURCE, "i"))![0].toLowerCase()),
		),
	];
	// The shown card is named at the top ("### Card #6 — Post idea"); later
	// mentions ("cards #1–5 have verdicts") are context, not the referent.
	const card = previousAnswer
		.split("\n")
		.filter((text) => text.trim())
		.slice(0, 3)
		.map((text) => text.match(/(?:card\s*#?|#)\s*(\d{1,3})\b/i)?.[1])
		.find(Boolean);
	const cards = card ? [card] : [];
	if (cards.length !== 1 || ids.length > 1 || titles.length > 1) return null;
	if (ids.length === 0 && titles.length === 0) return null;
	return {
		outputId: ids[0] ?? null,
		sheetTitle: titles[0] ?? null,
		card: cards[0]!,
		verdict: match[1].toLowerCase().replace(/\s+/g, " "),
		reason: (match[2] ?? "").trim(),
	};
}

/** The sheet range write for a card verdict follow-up. */
export function cardVerdictWriteDecision(
	followUp: CardVerdictFollowUp | null,
	appSlug: string | null,
): KernelRouteDecision | null {
	const decision = explicitOutputWriteDecision(
		followUp ? "sheet" : null,
		appSlug,
		"edit",
	);
	if (!decision || !followUp) return null;
	const reason = followUp.reason ? ` with reason "${followUp.reason}"` : "";
	const sheet = [
		followUp.outputId ? `output ${followUp.outputId}` : null,
		followUp.sheetTitle ? `titled "${followUp.sheetTitle}"` : null,
	]
		.filter(Boolean)
		.join(", ");
	return {
		...decision,
		rationale: `The previous answer showed card #${followUp.card} of the Tedix sheet ${sheet}. Record the verdict "${followUp.verdict}"${reason} in that card's row only: write yes or no into its Useful? column (done or did it means its done column = yes) and the reason into its Reason column, leaving other cells unchanged.`,
		evidenceExpectation: `Card #${followUp.card}'s verdict cells saved in a new sheet revision.`,
	};
}

/** Only selects a planner; arguments, schema validation and approval stay there. */
export function explicitOutputWriteDecision(
	kind: OutputCreateKind | null,
	appSlug: string | null,
	operation: "create" | "edit",
): KernelRouteDecision | null {
	if (!kind || !appSlug) return null;
	return {
		routeKind: "propose_tool_write",
		answer: null,
		rationale: `The operator asked to ${operation} a Tedix ${kind}.`,
		risk: "medium",
		confidence: 1,
		effortClass: "single_read",
		targetTediId: null,
		targetTediLabel: null,
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: {
			appSlug,
			capability: (operation === "create"
				? CAPABILITY_BY_KIND
				: EDIT_CAPABILITY_BY_KIND)[kind],
			connectionStatus: "connected",
		},
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: `A saved ${kind} revision after approval.`,
	};
}

/**
 * The app that carries Tedix OS writes: the tenant's Code Mode gateway. With
 * several, the one that also carries catalog installation is the control
 * plane gateway.
 */
export function outputWriteApp(
	apps: readonly {
		slug: string;
		codeMode?: boolean;
		capabilities?: string[];
	}[],
): string | null {
	const gateways = apps.filter((app) => app.codeMode);
	return (
		(
			gateways.find((app) => app.capabilities?.includes("catalog.install")) ??
			gateways[0]
		)?.slug ?? null
	);
}

/**
 * Route an explicit output-create request that the model answered in prose to
 * a write proposal through `appSlug`. Every other decision is unchanged.
 */
export function routeExplicitOutputCreate<T extends KernelRouteDecision>(
	route: T,
	kind: OutputCreateKind | null,
	appSlug: string | null,
): T {
	if (!kind || !appSlug || route.routeKind !== "answer_in_home") return route;
	return {
		...route,
		routeKind: "propose_tool_write",
		answer: null,
		rationale: `The operator asked to create a Tedix ${kind}; that is a write, not an answer.`,
		risk: route.risk === "high" ? "high" : "medium",
		effortClass: route.effortClass ?? "single_read",
		targetTediId: null,
		targetTediLabel: null,
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: {
			appSlug,
			capability: CAPABILITY_BY_KIND[kind],
			connectionStatus: "connected",
		},
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: `A new ${kind} in Tedix, created after approval.`,
	};
}
