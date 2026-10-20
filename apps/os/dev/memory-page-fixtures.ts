import type { Fact } from "@tedix/api-contract/schemas/memory-graph";
import type { MemoryBrowseInputSchema } from "@tedix/api-contract/schemas/memory-browser";
import type * as z from "zod";

const texts = [
	"Always discover the namespace first before calling a connected tool.",
	"Keep customer-facing drafts short and include the source of each claim.",
	"Confirm the current organization before making changes.",
	"Check the latest evidence before closing a work item.",
	"Use the staging workspace to validate changes before release.",
];
const facts: Fact[] = Array.from({ length: 47 }, (_, i) => ({
	id: `fixture-memory-${i + 1}`,
	organizationId: "fixture-orchard",
	content: `${texts[i % texts.length]}${i >= texts.length ? ` Reference ${i + 1}.` : ""}`,
	summary: `${texts[i % texts.length]}${i >= texts.length ? ` Reference ${i + 1}.` : ""}`,
	factType: "technical",
	confidence: 0.55 + (i % 5) * 0.1,
	source: "conversation://fixture-planning",
	domainId: i % 2 === 0 ? "fixture-engineering" : "fixture-operations",
	visibility: "org",
	accessCount: 2,
	usageCount: 1,
	createdAt: "2026-01-01T10:00:00.000Z",
	updatedAt: new Date(Date.UTC(2026, 9, 20, 10, 0, -i)).toISOString(),
	lastAccessedAt: "2026-01-01T10:00:00.000Z",
	metadata: {
		evidence: {
			source: "conversation://fixture-planning",
			quote: texts[i % texts.length]!,
		},
		history: [
			{
				reason: "Verified against the workspace guide",
				at: "2026-10-20T10:00:00.000Z",
			},
		],
	},
}));

export function memoryBrowseFixture(
	input: z.input<typeof MemoryBrowseInputSchema>,
) {
	let rows =
		input.view === "gaps"
			? facts.slice(0, 9).map((fact) => ({
					...fact,
					factType: "gap" as const,
					summary: null,
					content: `What evidence supports this memory? ${fact.content}`,
				}))
			: input.view === "contradictions"
				? facts.slice(0, 2)
				: input.view === "stale"
					? facts.slice(0, 14)
					: facts;
	rows = rows.filter(
		(fact) =>
			(!input.search ||
				fact.content.toLowerCase().includes(input.search.toLowerCase())) &&
			(!input.domainId || fact.domainId === input.domainId) &&
			(input.minConfidence === undefined ||
				fact.confidence >= input.minConfidence),
	);
	rows.sort(
		(a, b) =>
			(input.orderBy === "confidence" ? b.confidence - a.confidence : 0) ||
			b.updatedAt!.localeCompare(a.updatedAt!),
	);
	const offset = input.offset ?? 0;
	const limit = input.limit ?? 20;
	return {
		facts: rows.slice(offset, offset + limit),
		nextOffset: offset + limit < rows.length ? offset + limit : null,
	};
}
export const memoryDomainFixture = {
	domains: [
		{
			id: "fixture-engineering",
			name: "Engineering",
			organizationId: "fixture-orchard",
			description: null,
			parentDomainId: null,
			factCount: 24,
			createdAt: null,
		},
		{
			id: "fixture-operations",
			name: "Operations",
			organizationId: "fixture-orchard",
			description: null,
			parentDomainId: null,
			factCount: 23,
			createdAt: null,
		},
	],
};
