import type { MemoryFact } from "@tedix/db/schema/memory-graph";

/**
 * Format platform facts as markdown with domain headers.
 * Returns null if no facts are available.
 */
export function formatPlatformFactsAsMarkdown(
	facts: Array<{ fact: MemoryFact; domainName: string | null }>,
): string | null {
	if (facts.length === 0) return null;

	// Group facts by domain
	const byDomain = new Map<string, Array<{ fact: MemoryFact }>>();
	for (const row of facts) {
		const domain = row.domainName ?? "general";
		if (!byDomain.has(domain)) byDomain.set(domain, []);
		byDomain.get(domain)!.push({ fact: row.fact });
	}

	const lines: string[] = [
		"# Platform Knowledge",
		"",
		`> ${facts.length} facts from the Tedix brain layer. Core facts are marked with a star.`,
		"",
	];

	for (const [domain, entries] of byDomain) {
		lines.push(`## ${domain}`);
		lines.push("");
		for (const { fact } of entries) {
			const marker = fact.priority === "core" ? " *" : "";
			const conf =
				fact.confidence != null
					? ` (${Math.round(fact.confidence * 100)}%)`
					: "";
			lines.push(`- ${fact.content}${conf}${marker}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
