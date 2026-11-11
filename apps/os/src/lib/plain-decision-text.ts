import { agentAddressedIssue } from "@tedix/api-contract/utils/agent-addressed-text";
import { formatCardTextDates } from "@/lib/format";

/**
 * Decision text as a person reads it. Agents write cards for each other: they
 * cite Work and trace IDs, hashes, actor IDs, machine names, error codes and
 * internal operation names. The full source stays in "Details for agents";
 * the card itself shows none of it.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A hex token with at least one digit and one letter: a short ID, SHA or hash. */
const HEX = "(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}";
const ID = `(?:${UUID}|${HEX})(?:[0-9a-f-]*…?)?`;

/** "Work cbf08453" reads as "the linked task"; trace and run IDs drop out. */
const NAMED_ID: [RegExp, string][] = [
	[
		new RegExp(
			`\\b(?:the\\s+)?(?:Work|task|work item)\\s+(?:id\\s+)?${ID}`,
			"gi",
		),
		"the linked task",
	],
	[
		new RegExp(
			`\\b(?:the\\s+)?(?:card|request|interaction|ask)\\s+${ID}`,
			"gi",
		),
		"the linked card",
	],
	[new RegExp(`\\b(?:the\\s+)?share\\s+${ID}`, "gi"), "the share"],
	[new RegExp(`\\b(?:the\\s+)?project\\s+${ID}`, "gi"), "the project"],
	[
		new RegExp(`\\b(?:commit|sha|revision)\\s+\`?${ID}\`?`, "gi"),
		"the referenced version",
	],
	[
		new RegExp(
			`\\b(?:trace|attempt|session|run|evidence|fence|lease)\\s*(?:id\\s*)?[:#]?\\s*${ID}`,
			"gi",
		),
		"",
	],
];

const PATTERNS: [RegExp, string][] = [
	// Actor references such as external_agent:7e22… or tedi:0000….
	[new RegExp(`\\b[a-z]+(?:_[a-z]+)*:${UUID}`, "gi"), ""],
	// Digests: sha256:… and bare 32–64 hex.
	[/\bsha(?:1|256|512)[:-][0-9a-f]{16,}\b/gi, ""],
	// Machine names: user@host.local, host.local, *.lan.
	[/\b[\w.-]+@[\w-]+(?:\.[\w-]+)*\.(?:local|lan|home|internal)\b/gi, ""],
	[/\b[\w-]+(?:\.[\w-]+)*\.(?:local|lan|internal)\b/gi, ""],
	// Bare error codes such as E151103.
	[/\b[A-Z]\d{5,}\b/g, ""],
	[new RegExp(`\\b${UUID}\\b`, "gi"), ""],
	[new RegExp(`\\b${HEX}\\b`, "gi"), ""],
];

/** Tidy what removed identifiers leave behind: "( , )", " ,", doubled spaces. */
function tidy(text: string): string {
	return (
		text
			.replace(/``/g, "")
			.replace(/\(\s*[,;·]?\s*\)/g, "")
			.replace(/\(\s*[,;·]\s*/g, "(")
			.replace(/\s*[,;·]\s*\)/g, ")")
			.replace(/\(\s*\)/g, "")
			.replace(/[ \t]+([,.;:!?)])/g, "$1")
			// "Captured by <machine>." loses its machine: drop the dangling word.
			.replace(/[ \t]+(?:by|for|on|from|at|to|of|with)(?=[.,;])/gi, "")
			.replace(/([,;:])(?=[,;:.])/g, "")
			.replace(/[ \t]{2,}/g, " ")
			.replace(/^[ \t]+|[ \t]+$/gm, "")
	);
}

function replaceAll(text: string, rules: readonly [RegExp, string][]) {
	return rules.reduce(
		(value, [pattern, next]) => value.replace(pattern, next),
		text,
	);
}

/** Internal operation names (`shares.update`, `create_work_item`) are agent detail. */
const OPERATION =
	/^(?:[a-z][a-zA-Z0-9]*\.)+[a-z][a-zA-Z0-9]*$|^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/**
 * One line or paragraph of human-facing text. Markdown stays markdown: code
 * spans keep their monospace unless they only name an internal operation.
 */
export function plainDecisionText(text: string): string {
	const withoutOperations = text.replace(/`([^`\n]+)`/g, (span, code: string) =>
		OPERATION.test(code.trim()) ? "the requested change" : span,
	);
	const plain = tidy(
		formatCardTextDates(
			replaceAll(replaceAll(withoutOperations, NAMED_ID), PATTERNS),
		),
	).trim();
	return /^\p{Lu}/u.test(text.trim())
		? plain.charAt(0).toUpperCase() + plain.slice(1)
		: plain;
}

/**
 * Notes agents leave for each other ("Then dispatch this Work to a lane…"),
 * sentences built on variable names (guestSkillReadSlots, actor_scope), and
 * instructions a person cannot follow ("click Reply on this Needs-you card").
 */
const AGENT_NOTE =
	/\b(?:dispatch(?:ed|es)?|lanes?|admitted|admission|heartbeats?|worktrees?|attempts?|lease|fence|settle|executor|harness)\b|\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b|(?<![/@\w])[a-z][a-z0-9]*_[a-z0-9_]+\b/;
const withoutCode = (text: string) => text.replace(/`[^`\n]*`/g, "");

/**
 * The original request as context for a person: identifiers and agent-only
 * sentences removed, links and code kept for the markdown renderer.
 */
export function plainDecisionSource(text: string): string {
	return text
		.split(/\n{2,}/)
		.map((paragraph) =>
			/^\s*(?:```|~~~|[-*] |\d+\. |\|)/.test(paragraph)
				? paragraph
				: (paragraph.match(/[^\n]+?(?:[.!?]+(?=\s|$)|$)\s*/g) ?? [paragraph])
						.filter(
							(sentence) =>
								!AGENT_NOTE.test(withoutCode(sentence)) &&
								!agentAddressedIssue(sentence),
						)
						.join(""),
		)
		.map(plainDecisionText)
		.filter((paragraph) => /\p{L}/u.test(paragraph))
		.join("\n\n");
}

/** "Codex session" → "Codex": who asked, without the transport around it. */
export function plainAskerName(name: string): string {
	const plain = plainDecisionText(name)
		.replace(/\s*\([^)]*\)\s*$/, "")
		.replace(/\s+(?:session|agent session|chat)$/i, "")
		.trim();
	return plain || name;
}
