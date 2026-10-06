/**
 * Compiler — HTTP/LLM runtime side.
 *
 * Pure clustering, promotion gate, fallback compilation, serialization,
 * staleness pruning, and invalidation live in
 * `@tedix/context-core/compiler`. This module wires:
 *   - `platform.getRationaleChain` to load completed records
 *   - `platform.getContrastiveDecisions` to enrich PREFER patterns
 *   - `LlmClient.chat` to compile patterns into directives
 *
 * Returns compiled directives; the caller owns persistence.
 */

import {
	type CompiledDirective,
	type RationalePattern,
	MAX_CONTRASTIVE_ENRICHMENTS,
	PROMOTION_THRESHOLD,
	applyPromotionGate,
	classifyDirective,
	clusterByPattern,
	computeProvenanceHash,
	fallbackCompile,
	filterCompleted,
} from "@tedix/context-core/compiler";
import type { LlmClient } from "./llm-client.js";
import type { PlatformClient } from "./platform-client.js";

interface Logger {
	log(msg: string): void;
	error?(msg: string, err?: unknown): void;
}

const defaultLogger: Logger = {
	log: (msg) => console.log(msg),
	error: (msg, err) => console.error(msg, err),
};

export interface CompileDirectivesOptions {
	platform: PlatformClient;
	llm?: LlmClient;
	/** Deployment / model name for the LLM compile call. */
	model?: string;
	logger?: Logger;
}

/**
 * Compile rationale records into directives. Returns the compiled set —
 * the Agent runtime caller saves them through DoDirectiveStore in DO SQLite.
 */
export async function compileDirectives(
	options: CompileDirectivesOptions,
): Promise<CompiledDirective[]> {
	const { platform, llm, model, logger = defaultLogger } = options;

	let records: Array<{
		id?: string;
		action: string;
		rationale?: string;
		category: string;
		outcome?: string;
		outcomeStatus: string;
	}>;

	try {
		const result = await platform.getRationaleChain(50);
		records = (result.data || []).map((r) => ({
			id: r.id,
			action: r.action,
			rationale: r.rationale,
			category: r.category,
			outcome: r.outcome ?? undefined,
			outcomeStatus: r.outcomeStatus,
		}));
	} catch (err) {
		logger.log(
			`[brain-bridge] Compiler: rationale fetch skipped (${err instanceof Error ? err.message : String(err)})`,
		);
		return [];
	}

	const completed = filterCompleted(records);
	// Necessary-condition early exit, NOT the promotion decision: with fewer
	// than PROMOTION_THRESHOLD completed records no cluster of ANY strength
	// can promote. The per-cluster gate (applyPromotionGate below) still
	// applies the stricter NEVER_PROMOTION_THRESHOLD to all-failure clusters;
	// raising this pre-gate to that bar would wrongly skip legitimate
	// 3-record "always"/"prefer" clusters.
	if (completed.length < PROMOTION_THRESHOLD) {
		logger.log(
			`[brain-bridge] Compiler: only ${completed.length} completed records, need ${PROMOTION_THRESHOLD} — skipping`,
		);
		return [];
	}

	const patterns = clusterByPattern(completed);
	const promoted = applyPromotionGate(patterns);
	if (promoted.length === 0) {
		logger.log("[brain-bridge] Compiler: no patterns meet promotion threshold");
		return [];
	}

	// Enrich PREFER patterns with contrastive examples
	const preferPatterns = promoted.filter(
		(p) => p.successCount > 0 && p.failureCount > 0,
	);
	const enrichTargets = preferPatterns.slice(0, MAX_CONTRASTIVE_ENRICHMENTS);
	await Promise.all(
		enrichTargets.map(async (pattern) => {
			try {
				pattern.contrastive = await platform.getContrastiveDecisions(
					pattern.category,
					5,
				);
			} catch (err) {
				logger.log(
					`[brain-bridge] Compiler: contrastive fetch failed for "${pattern.category}" (${err instanceof Error ? err.message : String(err)})`,
				);
			}
		}),
	);

	// Compile via LLM (or fallback)
	const directives =
		llm && model
			? await llmCompile(promoted, llm, model, logger)
			: await fallbackCompile(promoted);

	logger.log(
		`[brain-bridge] Compiler: compiled ${directives.length} directives from ${promoted.length} patterns`,
	);
	return directives;
}

async function llmCompile(
	patterns: RationalePattern[],
	llm: LlmClient,
	model: string,
	logger: Logger,
): Promise<CompiledDirective[]> {
	const now = new Date().toISOString();

	// Per-call pattern ids the model must echo back on each directive.
	// Rule 7 lets the model SKIP patterns, so positional (array-index) mapping
	// would shift every subsequent directive onto the wrong pattern and attribute
	// provenance (rationaleIds, evidence counts, success rates) incorrectly.
	const patternId = (i: number) => `P${i + 1}`;
	const patternsById = new Map<string, RationalePattern>(
		patterns.map((p, i) => [patternId(i), p]),
	);

	const patternSummaries = patterns
		.map((p, i) => {
			const total = p.successCount + p.failureCount;
			const strength =
				classifyDirective(p.successCount, p.failureCount) === "always"
					? "ALWAYS"
					: classifyDirective(p.successCount, p.failureCount) === "never"
						? "NEVER"
						: "PREFER";

			const examples = p.records
				.slice(0, 3)
				.map(
					(r) =>
						`  - Action: ${r.action}\n    Outcome: ${r.outcomeStatus}${r.outcome ? ` — ${r.outcome}` : ""}`,
				)
				.join("\n");

			let contrastiveBlock = "";
			if (
				p.contrastive &&
				(p.contrastive.successes.length > 0 ||
					p.contrastive.failures.length > 0)
			) {
				const successLines = p.contrastive.successes
					.slice(0, 3)
					.map(
						(s) =>
							`    ✓ ${s.action} — ${s.rationale}${s.outcome ? ` → ${s.outcome}` : ""}`,
					);
				const failureLines = p.contrastive.failures
					.slice(0, 3)
					.map(
						(f) =>
							`    ✗ ${f.action} — ${f.rationale}${f.outcome ? ` → ${f.outcome}` : ""}`,
					);
				contrastiveBlock = `\n  Contrastive examples:\n${[...successLines, ...failureLines].join("\n")}`;
			}

			return `Pattern ${patternId(i)} [${strength}] (${p.successCount}/${total} success, category: ${p.category}):\n${examples}${contrastiveBlock}`;
		})
		.join("\n\n");

	const systemPrompt = `You compile action patterns from a digital worker's decision history into concise operational directives.

## Output Format
Return a JSON object: { "directives": [...] }

Each directive has:
- "patternId": string (echo the exact id of the input pattern this directive compiles, e.g. "P2" for Pattern P2 — one directive per pattern id, never reuse or invent ids)
- "strength": "always" | "never" | "prefer"
- "directive": string (one imperative sentence, specific and actionable — include tool names, config values, thresholds)
- "category": string (from the input pattern category)

## Rules
1. ALWAYS directives: only for patterns with 100% success rate and 3+ examples
2. NEVER directives: only for patterns with 100% failure rate and 3+ examples
3. PREFER directives: for mixed-outcome patterns — include the success rate. Use contrastive examples (✓/✗) when present to identify what distinguishes success from failure
4. Be SPECIFIC — "Always use memory_search before stating facts about the organization" not "Always check memory"
5. Preserve tool names, file paths, config values, threshold numbers
6. One directive per pattern — don't split or merge
7. If a pattern is too vague to distill, skip it (return fewer directives)

Return ONLY the JSON object.`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);

	try {
		const response = await llm.chat({
			model,
			messages: [
				{ role: "system", content: systemPrompt },
				{
					role: "user",
					content: `Compile these ${patterns.length} action patterns into operational directives:\n\n${patternSummaries}`,
				},
			],
			temperature: 0.2,
			maxCompletionTokens: 2000,
			responseFormatJson: true,
			signal: controller.signal,
		});
		clearTimeout(timeout);

		const content = response.content;
		if (!content) return fallbackCompile(patterns, now);

		const parsed = JSON.parse(content);
		const llmDirectives = Array.isArray(parsed.directives)
			? parsed.directives
			: [];

		const out: CompiledDirective[] = [];
		const consumed = new Set<string>();
		for (const raw of llmDirectives) {
			const d = raw as {
				patternId?: string;
				directive?: string;
				strength?: CompiledDirective["strength"];
				category?: string;
			};
			if (!d.directive || !d.strength) continue;
			// Identifier-based provenance mapping: the model may skip patterns
			// (rule 7), so directives attach to patterns via the echoed patternId,
			// never by array position.
			const pattern = d.patternId ? patternsById.get(d.patternId) : undefined;
			if (!pattern) {
				logger.log(
					`[brain-bridge] Compiler: directive echoed ${d.patternId ? `unknown pattern id "${d.patternId}"` : "no pattern id"} — dropped ("${d.directive.slice(0, 80)}")`,
				);
				continue;
			}
			if (consumed.has(d.patternId!)) {
				logger.log(
					`[brain-bridge] Compiler: duplicate directive for pattern id "${d.patternId}" — dropped ("${d.directive.slice(0, 80)}")`,
				);
				continue;
			}
			consumed.add(d.patternId!);
			const ids = pattern.recordIds;
			out.push({
				strength: d.strength,
				directive: d.directive,
				category: d.category || pattern.category,
				evidenceCount: pattern.records.length,
				successRate:
					pattern.successCount / (pattern.successCount + pattern.failureCount),
				compiledAt: now,
				rationaleIds: ids,
				provenanceHash: await computeProvenanceHash(ids),
				lastMatchedAt: null,
			});
		}
		// The model returned directives but none carried a usable pattern id —
		// provenance cannot be attributed, so fall back rather than return nothing.
		if (out.length === 0 && llmDirectives.length > 0) {
			logger.log(
				"[brain-bridge] Compiler: no LLM directive mapped to an input pattern — using fallback compilation",
			);
			return fallbackCompile(patterns, now);
		}
		return out;
	} catch (err) {
		clearTimeout(timeout);
		logger.error?.("[brain-bridge] Compiler LLM error:", err);
		return fallbackCompile(patterns, now);
	}
}
