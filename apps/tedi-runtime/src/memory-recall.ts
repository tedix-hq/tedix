/**
 * Bounded per-turn long-term memory recall for the brain-digest addendum.
 *
 * The API uses bounded hybrid recall. This outer budget includes transport;
 * a delayed request must not hold the first model call. Trivial acknowledgements
 * carry no query worth searching and skip recall entirely.
 */

import type { MemorySearchResult } from "./brain/platform-client";
import { logTediSourceFailure } from "./context-failure-log";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";

export const MEMORY_RECALL_BUDGET_MS = 800;
const MEMORY_RECALL_LIMIT = 6;

export type MemoryRecallOutcome =
	| "skipped_trivial"
	| "unavailable"
	| "timed_out"
	| "failed"
	| "completed";

export interface MemoryRecallReport {
	outcome: MemoryRecallOutcome;
	durationMs: number;
	factCount: number;
}

/**
 * Whole-message acknowledgements and continuations. Exact matches only, after
 * normalization: anything longer or different still recalls.
 */
const TRIVIAL_RECALL_MESSAGES = new Set([
	"ok",
	"okay",
	"k",
	"kk",
	"yes",
	"y",
	"yep",
	"yeah",
	"yup",
	"sure",
	"no",
	"nope",
	"thanks",
	"thank you",
	"thx",
	"ty",
	"continue",
	"go",
	"go ahead",
	"go on",
	"proceed",
	"next",
	"do it",
	"make it happen",
	"sounds good",
	"got it",
	"great",
	"cool",
	"lgtm",
]);

/**
 * True when `userText` is too trivial to search memory with: empty or
 * punctuation-only, digits only (a menu choice), or an exact acknowledgement /
 * continuation such as "ok", "continue" or "go ahead" (case, surrounding
 * punctuation and a leading/trailing "please" ignored). Conservative: when in
 * doubt, recall.
 */
export function isTrivialRecallQuery(userText: string): boolean {
	const normalized = userText
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return true;
	if (/^[\d ]+$/.test(normalized)) return true;
	const core = normalized.replace(/^please /, "").replace(/ please$/, "");
	return TRIVIAL_RECALL_MESSAGES.has(core);
}

function formatRecallBlock(result: MemorySearchResult): {
	block: string;
	factCount: number;
} {
	const facts = result.results.flatMap(({ fact, provenance }) => {
		const text = fact?.content || fact?.summary;
		if (!text) return [];
		const why = provenance?.arms.length
			? ` [recalled: ${provenance.arms.map((arm) => arm.arm).join(", ")}]`
			: "";
		const replaced = provenance?.replacesFactIds?.length
			? ` [replaces: ${provenance.replacesFactIds.join(", ")}]`
			: "";
		return [
			`${fact.metadata?.verifyBeforeUse ? "[Historical; verify current state before use] " : ""}${text}${why}${replaced}`,
		];
	});
	if (facts.length === 0) return { block: "", factCount: 0 };
	return {
		block: [
			"# Relevant Long-Term Memory",
			"Relevant facts retrieved by the platform and validated against canonical D1 memory.",
			wrapUntrustedInput(facts.map((fact) => `- ${fact}`).join("\n"), "memory"),
		].join("\n\n"),
		factCount: facts.length,
	};
}

/**
 * Recall the "Relevant Long-Term Memory" block for one turn, waiting at most
 * `budgetMs`. `search` returns `null` when no platform client is available.
 * Never rejects: a skip, timeout or failure yields an empty block. A search
 * still running at the budget keeps running and settles on its own; only this
 * turn stops waiting for it.
 */
export async function recallLongTermMemoryBlock(input: {
	userText: string;
	search: (query: string, limit: number) => Promise<MemorySearchResult | null>;
	budgetMs?: number;
}): Promise<MemoryRecallReport & { block: string }> {
	const started = performance.now();
	const done = (
		outcome: MemoryRecallOutcome,
		block = "",
		factCount = 0,
	): MemoryRecallReport & { block: string } => ({
		outcome,
		block,
		factCount,
		durationMs: Math.round(performance.now() - started),
	});
	if (isTrivialRecallQuery(input.userText)) return done("skipped_trivial");

	type Settled =
		| { kind: "result"; result: MemorySearchResult | null }
		| { kind: "failed" }
		| { kind: "timed_out" };
	const search: Promise<Settled> = Promise.resolve()
		.then(() => input.search(input.userText, MEMORY_RECALL_LIMIT))
		.then(
			(result): Settled => ({ kind: "result", result }),
			(error): Settled => {
				logTediSourceFailure("memory_recall", "query", error, "error");
				return { kind: "failed" };
			},
		);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Settled>((resolve) => {
		timer = setTimeout(
			() => resolve({ kind: "timed_out" }),
			input.budgetMs ?? MEMORY_RECALL_BUDGET_MS,
		);
	});
	try {
		const settled = await Promise.race([search, timeout]);
		if (settled.kind === "timed_out") return done("timed_out");
		if (settled.kind === "failed") return done("failed");
		if (!settled.result) return done("unavailable");
		const { block, factCount } = formatRecallBlock(settled.result);
		return done("completed", block, factCount);
	} catch (error) {
		logTediSourceFailure("memory_recall", "query", error, "error");
		return done("failed");
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
