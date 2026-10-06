import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ organization: vi.fn(), judge: vi.fn() }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.organization,
}));
vi.mock("../../../services/jev-judgment", () => ({
	executeJevJudgment: mocks.judge,
	JevUsagePersistenceError: class extends Error {},
}));
import {
	interpretDiscoveryJudgment,
	rankDiscoveryCandidates,
} from "./jev-discovery";

const candidates = [
	{
		id: "gmail.search",
		kind: "tool" as const,
		description: "Search Gmail messages",
	},
	{
		id: "calendar.events",
		kind: "tool" as const,
		description: "List calendar events",
	},
];
const input = { query: "Find an email about the meeting", candidates };
function context(organizationId = "org") {
	return {
		headers: new Headers({ "X-Tedix-Org-Id": organizationId }),
		db: {},
		env: {},
	} as never;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.organization.mockResolvedValue({ id: "org", metadata: {} });
});

it("does not dispatch without a canonical tenant organization", async () => {
	await expect(
		rankDiscoveryCandidates(context("system"), input),
	).rejects.toThrow();
	mocks.organization.mockResolvedValue(null);
	await expect(rankDiscoveryCandidates(context(), input)).rejects.toThrow();
	expect(mocks.judge).not.toHaveBeenCalled();
});

it("respects an explicit tenant-wide Jev denial", async () => {
	mocks.organization.mockResolvedValue({
		id: "org",
		metadata: { jev: { enabled: false } },
	});
	const result = await rankDiscoveryCandidates(context(), input);
	expect(result.rankedIds).toBeNull();
	expect(result.usagePersistence).toBe("not_dispatched");
	expect(mocks.judge).not.toHaveBeenCalled();
});

it("promotes only strongly applicable members of the submitted set", () => {
	expect(
		interpretDiscoveryJudgment(["gmail.search", "calendar.events"], {
			which: {
				type: "choice",
				choice: "c0",
				confidence: 0.95,
				probabilities: { c0: 0.9, c1: 0.1 },
			},
			fits0: { type: "noul", noul: 0.95 },
			fits1: { type: "noul", noul: 0.15 },
		}),
	).toEqual(["gmail.search", "calendar.events"]);
	expect(
		interpretDiscoveryJudgment(["gmail.search", "calendar.events"], {
			which: {
				type: "choice",
				choice: "c1",
				confidence: 0.6,
				probabilities: { c0: 0.2, c1: 0.8 },
			},
			fits0: { type: "noul", noul: 0.9 },
			fits1: { type: "noul", noul: 0.9 },
		}),
	).toBeNull();
});

it("uses governed Jev judgment and returns a bounded permutation", async () => {
	mocks.judge.mockResolvedValue({
		answers: {
			which: {
				type: "choice",
				choice: "c0",
				confidence: 0.95,
				probabilities: { c0: 0.9, c1: 0.1 },
			},
			fits0: { type: "noul", noul: 0.95 },
			fits1: { type: "noul", noul: 0.15 },
		},
	});
	const result = await rankDiscoveryCandidates(context(), input);
	expect(result.rankedIds).toEqual(["gmail.search", "calendar.events"]);
	expect(mocks.judge).toHaveBeenCalledWith(
		expect.objectContaining({
			source: "mcp:discovery-ranking",
			context: expect.objectContaining({ organizationId: "org" }),
			state: expect.objectContaining({ candidates: expect.any(Object) }),
		}),
	);
});
