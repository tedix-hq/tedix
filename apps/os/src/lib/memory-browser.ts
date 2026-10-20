import * as z from "zod";

// The Run detail route reads `skill_runs`, whose production creation path uses
// `crypto.randomUUID()`. Rationale `runId` is intentionally broader and also
// carries Agent/Home compound runtime references. Sending those identifiers to
// the workflow-only route produces a false "Run not found" destination.
const WORKFLOW_RUN_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function workflowRunLinkId(runId: string | null): string | null {
	return runId && WORKFLOW_RUN_ID_PATTERN.test(runId) ? runId : null;
}

export const MEMORY_TABS = [
	{ id: "observations", label: "What we know" },
	{ id: "rules", label: "Rules" },
	{ id: "knowledge", label: "Knowledge" },
	{ id: "decisions", label: "Decisions" },
	{ id: "contradictions", label: "Contradictions" },
	{ id: "gaps", label: "Gaps" },
	{ id: "stale", label: "Stale" },
	{ id: "curiosity", label: "Curiosity queue" },
	{ id: "health", label: "Health" },
] as const;
export const MEMORY_PAGE_SIZE = 20;
export const MEMORY_RECENT_LIMIT = 100;

export const memorySearchSchema = z.object({
	tab: z
		.enum([
			"observations",
			"rules",
			"knowledge",
			"decisions",
			"contradictions",
			"gaps",
			"stale",
			"curiosity",
			"health",
		])
		.catch("observations"),
	q: z.string().max(500).catch(""),
	detail: z.string().catch(""),
	domain: z.string().catch(""),
	confidence: z.enum(["all", "80", "50"]).catch("all"),
	source: z.string().catch(""),
	sort: z.enum(["updated", "confidence"]).catch("updated"),
	page: z.coerce.number().int().min(0).max(5000).catch(0),
});
export type MemorySearch = z.infer<typeof memorySearchSchema>;

/** Compare the full strings before truncating either one. */
export function memoryText(title: string | null | undefined, body: string) {
	const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
	const distinctTitle =
		title?.trim() && normalize(title) !== normalize(body) ? title.trim() : null;
	return { title: distinctTitle, body, line: distinctTitle ?? body };
}

export interface MemoryTableRow {
	id: string;
	title?: string | null;
	body: string;
	source: string;
	updated: string | null;
	confidence: number | null;
	domain?: string | null;
}

export function filterMemoryRows<T extends MemoryTableRow>(
	rows: T[],
	search: MemorySearch,
) {
	return rows
		.filter(
			(row) =>
				(!search.q ||
					`${row.title ?? ""} ${row.body}`
						.toLowerCase()
						.includes(search.q.toLowerCase())) &&
				(!search.domain || row.domain === search.domain) &&
				(!search.source || row.source === search.source) &&
				(search.confidence === "all" ||
					(row.confidence !== null &&
						row.confidence >= Number(search.confidence) / 100)),
		)
		.sort(
			(a, b) =>
				(search.sort === "confidence"
					? (b.confidence ?? -1) - (a.confidence ?? -1)
					: 0) ||
				(b.updated ?? "").localeCompare(a.updated ?? "") ||
				a.id.localeCompare(b.id),
		);
}

export function memoryPage<T>(rows: T[], page: number) {
	return rows.slice(page * MEMORY_PAGE_SIZE, (page + 1) * MEMORY_PAGE_SIZE);
}
