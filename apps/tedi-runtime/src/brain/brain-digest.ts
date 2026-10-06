/**
 * Brain digest — stable top-K memory summary, runtime-neutral compilation.
 *
 * Periodically distills the tedi's top brain facts into a stable, cache-friendly
 * knowledge digest. In "stable retrieval mode" (Mastra OM pattern) this digest
 * replaces per-turn brain retrieval — the tedi gets one cached knowledge prefix
 * injected every turn instead of hitting the memory API on each request.
 *
 * Pure of the runtime: it only needs `platform.getDomains` + `platform.memorySearch`
 * (no workspace dir, no filesystem) and an injected `LlmClient` from the Agent
 * runtime. The Agent runtime persists it to DO SQLite.
 *
 * Mirrors the corpus-audit / reflector extraction shape (P21): pure compute +
 * injected LlmClient, no hardcoded Azure URL.
 */

import type { LlmClient } from "./llm-client.js";
import type { PlatformClient } from "./platform-client.js";

export interface BrainDigest {
	summary: string;
	factCount: number;
	compiledAt: string;
	domains: string[];
	domainNames: string[];
	/** Stable hash of the exact fact/domain input used for this digest (absent on legacy rows). */
	sourceFingerprint?: string;
	/**
	 * IDs (or first-64-char content prefix) of facts that were budget-dropped
	 * rather than silently omitted. Populated only when facts exceed the token
	 * cap after the LLM pass — callers can surface this to operators so the
	 * channel is honest, never silent.
	 */
	droppedFactIds?: string[];
}

const MAX_FACTS = 30;
const MAX_DIGEST_TOKENS = 3000;
const MAX_PARALLEL_MEMORY_SEARCHES = 2;

export interface CompileBrainDigestOptions {
	/** LLM client used to distill the grouped facts into a reference digest. */
	llm: LlmClient;
	/** Deployment / model name for the digest compile call. */
	model: string;
	/** Abort signal forwarded to the LLM transport (callers timeout-guard). */
	signal?: AbortSignal;
	/** Last persisted digest. Reused without inference when its source is unchanged. */
	previousDigest?: BrainDigest | null;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	let nextIndex = 0;
	const workerCount = Math.min(Math.max(concurrency, 1), items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await fn(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Compile top brain facts into a stable digest.
 *
 * Reads the tedi's domains + per-domain memory facts via the platform, groups
 * them by domain, and distills them into a reference digest via the injected
 * `LlmClient`. Returns `null` when there are too few facts (<3) so young tedis
 * are unaffected, or falls back to a deterministic non-LLM digest if the LLM
 * call yields nothing. No side effects — callers persist/cache as needed.
 */
export async function compileBrainDigest(
	platform: Pick<PlatformClient, "getDomains" | "memorySearch">,
	options: CompileBrainDigestOptions,
): Promise<BrainDigest | null> {
	let facts: Array<{
		summary: string;
		content?: string;
		domain?: string;
		confidence?: number;
	}>;
	let allDomainNames: string[] = [];

	try {
		const domainMap = await platform
			.getDomains()
			.catch(() => new Map<string, string>());
		const domainNames = [...domainMap.values()].filter(Boolean);
		allDomainNames = domainNames;

		// Query per domain for broad coverage; fall back to generic query if no domains.
		const queries =
			domainNames.length > 0
				? domainNames.slice(0, 6).map((d) => `${d} key facts expertise`)
				: ["key facts expertise knowledge"];
		const perQuery = Math.max(5, Math.floor(MAX_FACTS / queries.length));

		const searchResults = await mapWithConcurrency(
			queries,
			MAX_PARALLEL_MEMORY_SEARCHES,
			(q) => platform.memorySearch(q, perQuery).catch(() => ({ results: [] })),
		);

		const seen = new Set<string>();
		facts = [];
		for (const searchResult of searchResults) {
			for (const r of searchResult.results || []) {
				if (!r.fact) continue;
				if (seen.has(r.factId)) continue;
				seen.add(r.factId);
				const fact = r.fact;
				// Domain resolution: try UUID→name map first; fall back to treating the
				// raw value as the name (API-seeded facts often carry the name directly,
				// not a UUID key, so silent fall-through to "general" must be avoided).
				const domainName = fact.domain
					? (domainMap.get(fact.domain) ?? fact.domain)
					: undefined;
				const summary = fact.summary || fact.content || "";
				if (summary.length > 0) {
					facts.push({
						summary,
						content: fact.content,
						domain: domainName || fact.domain,
						confidence: fact.confidence,
					});
				}
			}
		}

		facts.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
		facts = facts.slice(0, MAX_FACTS);
	} catch (err) {
		console.log(
			`[brain-bridge] Brain digest: fetch skipped (${err instanceof Error ? err.message : String(err)})`,
		);
		return null;
	}

	if (facts.length < 3) {
		console.log(
			`[brain-bridge] Brain digest: only ${facts.length} facts, need 3+ — skipping`,
		);
		return null;
	}

	const domains = [
		...new Set(facts.map((f) => f.domain).filter(Boolean)),
	] as string[];

	const grouped = new Map<string, typeof facts>();
	for (const fact of facts) {
		const domain = fact.domain || "general";
		const group = grouped.get(domain) || [];
		group.push(fact);
		grouped.set(domain, group);
	}

	const factSections = Array.from(grouped.entries())
		.map(([domain, domainFacts]) => {
			const lines = domainFacts
				.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
				// Feed the distiller the full fact CONTENT, not just the short
				// `summary` — a summary is often truncated (e.g. seeded as
				// content.slice(0, 90)) and drops the actionable conclusion of an
				// operating rule, so the distilled digest keeps the topic but loses
				// the "…therefore do X" the tedi needs. The distiller still caps the
				// OUTPUT at MAX_DIGEST_TOKENS, so richer input ≠ bigger digest.
				.map(
					(f) =>
						`- ${f.content?.trim() || f.summary}${f.confidence ? ` (${Math.round(f.confidence * 100)}%)` : ""}`,
				);
			return `### ${domain}\n${lines.join("\n")}`;
		})
		.join("\n\n");
	const sourceFingerprint = await digestSourceFingerprint(
		JSON.stringify({
			factSections,
			domainNames: [...allDomainNames].sort(),
		}),
	);
	if (options.previousDigest?.sourceFingerprint === sourceFingerprint) {
		console.log(
			`[brain-bridge] Brain digest: source unchanged (${facts.length} facts) — reusing cached digest`,
		);
		return options.previousDigest;
	}

	const digest = await llmDigest(factSections, facts.length, options);

	if (!digest) {
		return fallbackDigest(
			grouped,
			facts.length,
			domains,
			allDomainNames,
			sourceFingerprint,
		);
	}

	// ── Coverage guarantee ────────────────────────────────────────────────────
	// The LLM may silently omit high-confidence facts under token pressure. For
	// each input fact we derive a stable 40-char token from its summary (lower-
	// cased, whitespace-normalised) and check whether it appears in the digest.
	// Missing facts are appended verbatim. If the overall append would exceed the
	// budget cap, we drop the LOWEST-confidence facts first and record their ids
	// (or content prefixes) in droppedFactIds so the channel is never silent.
	const MAX_APPENDED_FACTS = 20; // guard against runaway appends
	const digestLower = digest.toLowerCase();
	const missing: typeof facts = [];
	for (const fact of facts) {
		const token = coverageToken(fact.summary);
		if (token.length >= 8 && !digestLower.includes(token)) {
			missing.push(fact);
		}
	}

	let droppedFactIds: string[] | undefined;
	let appendSection = "";

	if (missing.length > 0) {
		// Sort missing by confidence desc so we append the most valuable ones.
		missing.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

		const toAppend = missing.slice(0, MAX_APPENDED_FACTS);
		const toDrop = missing.slice(MAX_APPENDED_FACTS);

		if (toDrop.length > 0) {
			droppedFactIds = toDrop.map((f) => f.summary.slice(0, 64));
			console.log(
				`[brain-bridge] Brain digest: ${toDrop.length} facts budget-dropped, ${toAppend.length} appended`,
			);
		} else {
			console.log(
				`[brain-bridge] Brain digest: ${toAppend.length} facts missing from LLM output — appending`,
			);
		}

		const appendLines = toAppend.map(
			(f) =>
				`- ${f.summary}${f.confidence ? ` (${Math.round(f.confidence * 100)}%)` : ""}`,
		);
		appendSection = `\n\n### additional facts\n${appendLines.join("\n")}`;
	}

	const result: BrainDigest = {
		summary: digest + appendSection,
		factCount: facts.length,
		compiledAt: new Date().toISOString(),
		domains,
		domainNames: allDomainNames,
		sourceFingerprint,
		...(droppedFactIds ? { droppedFactIds } : {}),
	};

	console.log(
		`[brain-bridge] Brain digest: compiled ${facts.length} facts across ${domains.length} domains`,
	);
	return result;
}

async function digestSourceFingerprint(source: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(source),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Derive a stable coverage token from a fact summary: lowercase, normalised
 * whitespace, first 40 chars. Used to check whether a fact appears in the LLM
 * output without requiring an exact quote.
 */
function coverageToken(summary: string): string {
	return summary.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);
}

const DIGEST_SYSTEM_PROMPT = `You compile a digital worker's knowledge base into a concise reference digest.

## Output Format
Return a structured markdown summary organized by domain. Use bullet points. Be specific — include names, versions, thresholds, URLs, config values.

## Rules
1. Preserve ALL specific facts — names, numbers, URLs, tool names, config values
2. Group by domain, with the most important/confident facts first
3. Merge redundant facts — if two facts say the same thing, keep the more specific one
4. Keep total length under ${MAX_DIGEST_TOKENS} tokens (~2500 words)
5. Use "## Knowledge Digest" as the top-level heading
6. Each domain gets a "### {domain}" sub-heading
7. Do NOT add opinions, inferences, or facts not present in the input
8. Do NOT use emojis

Return ONLY the markdown.`;

async function llmDigest(
	factSections: string,
	factCount: number,
	options: CompileBrainDigestOptions,
): Promise<string | null> {
	try {
		const response = await options.llm.chat({
			model: options.model,
			messages: [
				{ role: "system", content: DIGEST_SYSTEM_PROMPT },
				{
					role: "user",
					content: `Compile this knowledge base (${factCount} facts) into a reference digest:\n\n${factSections}`,
				},
			],
			temperature: 0.1,
			maxCompletionTokens: 4000,
			signal: options.signal,
		});
		const content = response.content;
		if (!content || content.length < 50) return null;
		return content;
	} catch (err) {
		console.error("[brain-bridge] Brain digest LLM error:", err);
		return null;
	}
}

function fallbackDigest(
	grouped: Map<string, Array<{ summary: string; confidence?: number }>>,
	factCount: number,
	domains: string[],
	domainNames: string[],
	sourceFingerprint: string,
): BrainDigest {
	const lines = ["## Knowledge Digest\n"];

	for (const [domain, facts] of grouped.entries()) {
		lines.push(`### ${domain}`);
		const sorted = facts.sort(
			(a, b) => (b.confidence ?? 0) - (a.confidence ?? 0),
		);
		for (const f of sorted.slice(0, 10)) {
			lines.push(`- ${f.summary}`);
		}
		lines.push("");
	}

	return {
		summary: lines.join("\n"),
		factCount,
		compiledAt: new Date().toISOString(),
		domains,
		domainNames,
		sourceFingerprint,
	};
}

/**
 * Serialize a brain digest for context injection. Appends the indexed-domain
 * footer so the tedi knows what it has coverage on even when a domain produced
 * no top facts.
 */
export function serializeBrainDigest(digest: BrainDigest): string {
	if (!digest.domainNames?.length) return digest.summary;
	return `${digest.summary}\n\n**Indexed domains:** ${digest.domainNames.join(", ")}`;
}
