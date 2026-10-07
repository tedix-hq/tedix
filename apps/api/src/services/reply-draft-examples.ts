/**
 * Few-shot examples for reply drafting: how this user actually answered
 * similar agent turns.
 *
 * Candidates are the user's recent answered decision-capture questions
 * ({@link listReplyExamples}); this module picks the most relevant ones for
 * the question being drafted, in process and without any index: same
 * repository first, then TF-IDF cosine similarity of the agent message tails,
 * with a bonus for answers that replaced or edited a tedi draft (the user's
 * correction is the strongest signal), then recency. Texts are stored redacted
 * at capture; rendering only flattens, truncates, and quotes them as data.
 * The block's wording is the versioned asset `reply-draft-examples.json`.
 */

import type { DbQueryClient } from "@tedix/db/query-client";
import {
	listReplyExamples,
	REPLY_EXAMPLE_AGENT_TAIL_CHARS,
	REPLY_EXAMPLE_CANDIDATE_LIMIT,
	type ReplyExampleResult,
} from "@tedix/db/queries/work-items/reply-examples";
import * as z from "zod";
import asset from "./reply-draft-examples.json";

const AssetSchema = z.object({
	assetVersion: z.number().int().min(1),
	header: z.array(z.string()).min(1),
	item: z.string().min(1),
	outcomeLabels: z.record(z.string(), z.string()),
});
const ASSET = AssetSchema.parse(asset);
export const REPLY_DRAFT_EXAMPLES_ASSET_VERSION = ASSET.assetVersion;

/** Upper bound on the whole rendered block. */
export const REPLY_EXAMPLES_BLOCK_LIMIT = 2_500;
/** Characters of the agent message tail shown per example. */
const AGENT_CHARS = 160;
/** Characters of the user's reply shown per example. */
const REPLY_CHARS = 180;
/** Ranking bonus by draft outcome: a correction teaches the most. */
const OUTCOME_BONUS: Record<string, number> = { replaced: 0.15, edited: 0.1 };

const STOPWORDS = new Set(
	"the and for are but not you all any can had has have her was one our out its his him how man new now old see two way who did get let put say she too use this that with from they will would there their what which when your about been into than them then these some could also just more only over such like here very done next were should".split(
		" ",
	),
);

/** Lowercase word tokens of at least three characters, minus stopwords. */
export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter(
		(token) => !STOPWORDS.has(token),
	);
}

function termCounts(tokens: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

function weighted(
	counts: Map<string, number>,
	idf: Map<string, number>,
): Map<string, number> {
	const vector = new Map<string, number>();
	for (const [term, count] of counts)
		vector.set(term, (1 + Math.log(count)) * (idf.get(term) ?? 0));
	return vector;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (const [term, weight] of a) {
		normA += weight * weight;
		const other = b.get(term);
		if (other) dot += weight * other;
	}
	for (const weight of b.values()) normB += weight * weight;
	return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}

export interface ReplyExampleQuery {
	/** The question's agent message (any length; only its tail is compared). */
	prompt: string;
	repository: string | null;
}

/**
 * The `count` most relevant candidates: same repository first, then TF-IDF
 * cosine similarity of the agent tails plus the draft-outcome bonus, then
 * newest first.
 */
export function rankReplyExamples(
	query: ReplyExampleQuery,
	candidates: readonly ReplyExampleResult[],
	count: number,
): ReplyExampleResult[] {
	if (count <= 0 || candidates.length === 0) return [];
	const queryCounts = termCounts(
		tokenize(query.prompt.slice(-REPLY_EXAMPLE_AGENT_TAIL_CHARS)),
	);
	const docCounts = candidates.map((candidate) =>
		termCounts(tokenize(candidate.agentTail)),
	);
	const documentFrequency = new Map<string, number>();
	for (const counts of [queryCounts, ...docCounts])
		for (const term of counts.keys())
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
	const total = docCounts.length + 1;
	const idf = new Map<string, number>();
	for (const [term, frequency] of documentFrequency)
		idf.set(term, Math.log((1 + total) / (1 + frequency)) + 1);
	const queryVector = weighted(queryCounts, idf);
	return candidates
		.map((candidate, index) => ({
			candidate,
			sameRepository:
				query.repository !== null && candidate.repository === query.repository,
			score:
				cosine(queryVector, weighted(docCounts[index]!, idf)) +
				(OUTCOME_BONUS[candidate.draftOutcome ?? ""] ?? 0),
		}))
		.sort(
			(a, b) =>
				Number(b.sameRepository) - Number(a.sameRepository) ||
				b.score - a.score ||
				b.candidate.createdAt.localeCompare(a.candidate.createdAt),
		)
		.slice(0, count)
		.map((entry) => entry.candidate);
}

function flat(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function head(value: string, limit: number): string {
	const text = flat(value);
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function tail(value: string, limit: number): string {
	const text = flat(value);
	return text.length > limit ? `…${text.slice(-(limit - 1))}` : text;
}

function renderItem(example: ReplyExampleResult, index: number): string {
	const meta = [
		example.repository,
		example.draftOutcome ? ASSET.outcomeLabels[example.draftOutcome] : null,
		example.replyClass,
	]
		.filter((part): part is string => !!part)
		.map((part) => head(part, 40))
		.join(" · ");
	const values: Record<string, string> = {
		index: String(index + 1),
		meta: meta || "reply",
		// JSON quoting keeps each text one inert string literal.
		agent: JSON.stringify(tail(example.agentTail, AGENT_CHARS)),
		reply: JSON.stringify(head(example.replyBody, REPLY_CHARS)),
	};
	return ASSET.item.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
		key in values ? (values[key] as string) : match,
	);
}

/**
 * The examples block, or `""` when there is nothing to show. Never longer
 * than {@link REPLY_EXAMPLES_BLOCK_LIMIT}: the least relevant examples are
 * dropped first.
 */
export function renderReplyExamplesBlock(
	examples: readonly ReplyExampleResult[],
): string {
	const items = examples.map(renderItem);
	while (items.length > 0) {
		const block = [...ASSET.header, ...items].join("\n");
		if (block.length <= REPLY_EXAMPLES_BLOCK_LIMIT) return block;
		items.pop();
	}
	return "";
}

export interface BuildReplyDraftExamplesParams {
	orgId: string;
	targetUserId: string;
	request: {
		id: string;
		prompt: string;
		metadata: unknown;
	};
	count: number;
}

/** Read, rank and render the target user's most relevant past replies. */
export async function buildReplyDraftExamplesBlock(
	db: DbQueryClient,
	p: BuildReplyDraftExamplesParams,
): Promise<string> {
	const metadata = p.request.metadata as Record<string, unknown> | null;
	const repository =
		typeof metadata?.repository === "string" ? metadata.repository : null;
	const candidates = await listReplyExamples(db, {
		orgId: p.orgId,
		targetUserId: p.targetUserId,
		repository,
		excludeInteractionId: p.request.id,
		limit: REPLY_EXAMPLE_CANDIDATE_LIMIT,
	});
	return renderReplyExamplesBlock(
		rankReplyExamples(
			{ prompt: p.request.prompt, repository },
			candidates,
			p.count,
		),
	);
}
