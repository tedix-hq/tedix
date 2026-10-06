/**
 * `memoryGraph.opine` hydration eligibility.
 *
 * Opine hydrates its retrieved fact ids through `getFactById`, which applies
 * no eligibility rules — so a retrieval hit (vector index, legacy index rows,
 * or a permissive fallback) is not an authorization decision. These tests pin
 * the hydration gate: a fact that `isMemorySearchFactEligible` rejects for the
 * caller's effective tedi identity is silently excluded from the opinion — it
 * never reaches the reasoning inputs, the supporting/contradicting sets, or
 * the stored opinion metadata. The search layer is deliberately mocked to
 * return MORE than the caller may see, proving the gate holds on its own.
 */

import { createRouterClient } from "@orpc/server";
import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../orpc";

const CALLER_ORG = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

const mocks = vi.hoisted(() => ({
	createFact: vi.fn(),
	getFactById: vi.fn(),
	searchFactsWithVisibility: vi.fn(),
}));

vi.mock(
	"@tedix/db/queries/memory-graph/fact-search",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/memory-graph/fact-search")
		>()),
		searchFactsWithVisibility: mocks.searchFactsWithVisibility,
	}),
);
vi.mock("@tedix/db/queries/memory-graph/facts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/memory-graph/facts")
	>()),
	createFact: mocks.createFact,
	getFactById: mocks.getFactById,
}));

function fact(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		organizationId: CALLER_ORG,
		tediId: null,
		domainId: null,
		content: `fact content ${id}`,
		summary: null,
		factType: "observation",
		confidence: 0.9,
		validFrom: "2026-08-01T00:00:00.000Z",
		validTo: null,
		status: "active",
		source: null,
		memoryScope: "tedi",
		usePolicy: "can_use_as_evidence",
		reviewStatus: "confirmed",
		priority: "active",
		visibility: "org",
		metadata: null,
		lastAccessedAt: null,
		accessCount: 0,
		usageCount: 0,
		archivedAt: null,
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:00:00.000Z",
		...overrides,
	};
}

const FACTS = [
	fact("org-fact"),
	fact("own-private", { visibility: "private", tediId: "tedi-1" }),
	fact("other-private", { visibility: "private", tediId: "tedi-2" }),
];

function makeContext(tediId?: string): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: CALLER_ORG,
		...(tediId ? { tediId } : {}),
		url: new URL("https://api.tedix.test/rpc/memory-graph"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["tedis:update"],
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

async function callOpine(context: BaseContext) {
	const { memoryGraphContractRouter } = await import("./memory-graph");
	const client = createRouterClient(memoryGraphContractRouter, { context });
	return client.opine({ question: "Is the platform stable?" });
}

// Warm the expensive router fixture ONCE outside any assertion body — same
// treatment as memory-graph-expertise-scope.test.ts.
beforeAll(async () => {
	await import("./memory-graph");
}, 120_000);

beforeEach(() => {
	vi.clearAllMocks();
	// The mocked D1 search deliberately over-returns every fixture fact;
	// hydration eligibility remains the authorization boundary.
	mocks.searchFactsWithVisibility.mockResolvedValue(FACTS);
	mocks.getFactById.mockImplementation(async (_db: unknown, id: string) =>
		FACTS.find((f) => f.id === id),
	);
	mocks.createFact.mockImplementation(
		async (_db: unknown, params: Record<string, unknown>) => ({
			...fact(params.id as string),
			...params,
		}),
	);
});

describe("memoryGraph.opine hydration eligibility", () => {
	it("a caller with no tedi identity never receives any tedi's private facts", async () => {
		const result = await callOpine(makeContext());

		expect(result.supportingCount + result.contradictingCount).toBe(1);
		const metadata = result.opinion.metadata as {
			supportingFactIds: string[];
			contradictingFactIds: string[];
		};
		const seen = [
			...metadata.supportingFactIds,
			...metadata.contradictingFactIds,
		];
		expect(seen).toEqual(["org-fact"]);
	});

	it("derives the visibility scope from the authenticated tedi context and still excludes other tedis' private facts", async () => {
		const result = await callOpine(makeContext("tedi-1"));

		const metadata = result.opinion.metadata as {
			supportingFactIds: string[];
			contradictingFactIds: string[];
		};
		const seen = [
			...metadata.supportingFactIds,
			...metadata.contradictingFactIds,
		].sort();
		expect(seen).toEqual(["org-fact", "own-private"]);
		expect(seen).not.toContain("other-private");
	});
});
