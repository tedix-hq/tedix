import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
const m = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
	edges: vi.fn(),
	judge: vi.fn(),
	org: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: m.org,
}));
vi.mock("@tedix/db/queries/memory-graph/auto-linking", () => ({
	listAutoLinkFacts: m.list,
	createAutoLinkEdge: m.create,
}));
vi.mock("@tedix/db/queries/memory-graph/edges", () => ({
	getEdgesForFacts: m.edges,
}));
vi.mock("./jev-judgment", () => ({ executeJevJudgment: m.judge }));
import {
	autoLinkFactsWithJev,
	graphCandidatePairs,
} from "./jev-graph-auto-linking";
import type { AutoLinkFact } from "@tedix/db/queries/memory-graph/auto-linking";
const fact = (id: string): AutoLinkFact => ({
	id,
	organizationId: "org",
	tediId: null,
	domainId: "d",
	content: `Shared billing policy ${id}`,
	source: null,
	visibility: "org",
});
const args = {
	db: {} as never,
	env: {} as never,
	context: { runId: "run" },
	scope: { organizationId: "org" },
};
const answer = (choice: string) => ({
	model: "jev-1.13.0",
	usage: { input_tokens: 10, output_tokens: 4 },
	answers: {
		relation: { type: "choice", choice, confidence: 0.1 },
		sourceSupport: { type: "noul", noul: 0.9 },
	},
});
beforeEach(() => {
	vi.clearAllMocks();
	m.list.mockResolvedValue([fact("a"), fact("b")]);
	m.edges.mockResolvedValue([]);
	m.create.mockResolvedValue(true);
	m.judge.mockResolvedValue(answer("related"));
	m.org.mockResolvedValue({
		metadata: { jev: { purposes: { graphLinking: { mode: "enforce" } } } },
	});
});
describe("bounded API-owned automatic graph judgments", () => {
	it("writes exact resolved direction and retains run attribution", async () => {
		m.judge.mockResolvedValue(answer("supersedes_b_a"));
		const result = await autoLinkFactsWithJev(args);
		expect(result.edgesCreated).toBe(1);
		expect(m.create).toHaveBeenCalledWith(
			args.db,
			args.scope,
			expect.objectContaining({
				source: expect.objectContaining({ id: "b" }),
				target: expect.objectContaining({ id: "a" }),
				relationType: "supersedes",
			}),
		);
		expect(m.judge).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "memory:graph-link",
				context: expect.objectContaining({
					runId: "run",
					organizationId: "org",
				}),
			}),
		);
	});
	it("bounds paid judgments even when nothing is selected", async () => {
		m.list.mockResolvedValue(
			Array.from({ length: 40 }, (_, i) => fact(`f${i}`)),
		);
		m.judge.mockResolvedValue(answer("NONE"));
		expect((await autoLinkFactsWithJev(args)).judgments).toBe(12);
		expect(m.create).not.toHaveBeenCalled();
	});
	it("never spends past remaining edge budget", async () => {
		m.list.mockResolvedValue([fact("a"), fact("b"), fact("c")]);
		expect(
			(await autoLinkFactsWithJev({ ...args, maxEdges: 1 })).judgments,
		).toBe(1);
		expect(
			(await autoLinkFactsWithJev({ ...args, maxEdges: 0 })).judgments,
		).toBe(0);
	});
	it("stops on unavailable inference without lexical fallback", async () => {
		m.list.mockResolvedValue([fact("a"), fact("b"), fact("c")]);
		m.judge.mockResolvedValue(null);
		expect((await autoLinkFactsWithJev(args)).judgments).toBe(1);
		expect(m.create).not.toHaveBeenCalled();
	});
	it("does not resend existing pairs or saturated endpoints", async () => {
		m.edges.mockResolvedValue([{ sourceFactId: "a", targetFactId: "b" }]);
		expect((await autoLinkFactsWithJev(args)).judgments).toBe(0);
	});
	it("dry run reports proposals but performs no canonical writes", async () => {
		expect(await autoLinkFactsWithJev({ ...args, dryRun: true })).toMatchObject(
			{ edgesCreated: 0, judgments: 1 },
		);
		expect(m.create).not.toHaveBeenCalled();
	});
	it("shadow mode is the default: judges on Clef, records proposals, writes nothing", async () => {
		m.org.mockResolvedValue({ metadata: {} });
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const result = await autoLinkFactsWithJev(args);
		expect(result).toMatchObject({
			mode: "shadow",
			edgesCreated: 0,
			judgments: 1,
			proposals: [expect.objectContaining({ relationType: "related_to" })],
		});
		expect(m.create).not.toHaveBeenCalled();
		expect(m.judge).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "@cf/cloudflare/clef-flash",
				transport: "cloudflare",
			}),
		);
		expect(log).toHaveBeenCalledWith(
			"[jev-graph-link] shadow proposals not applied",
			expect.objectContaining({ judgments: 1 }),
		);
		log.mockRestore();
	});
	it("does not dispatch against an explicit tenant denial", async () => {
		m.org.mockResolvedValue({ metadata: { jev: { enabled: false } } });
		expect((await autoLinkFactsWithJev(args)).judgments).toBe(0);
		expect(m.judge).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
	});
	it("cannot propose cross-domain, cross-tenant or public/private pairs", () => {
		expect(
			graphCandidatePairs([
				fact("a"),
				{ ...fact("b"), organizationId: "other" },
				{ ...fact("c"), domainId: "other" },
				{ ...fact("private"), visibility: "private", tediId: "t1" },
			]),
		).toEqual([]);
	});
});
