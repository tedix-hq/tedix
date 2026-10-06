import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getSkillRun: vi.fn(),
	getWorkItemById: vi.fn(),
	getOrganizationById: vi.fn(),
	verifiedActiveUserMembership: vi.fn(),
	record: vi.fn(),
	list: vi.fn(),
	assess: vi.fn(),
}));
vi.mock("@tedix/db/queries/skill-runs", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/skill-runs")>()),
	getSkillRun: mocks.getSkillRun,
}));
vi.mock("@tedix/db/queries/work-items/crud", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/work-items/crud")>()),
	getWorkItemById: mocks.getWorkItemById,
}));
vi.mock("@tedix/db/queries/organizations", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
}));
vi.mock("./work-items-principal", async (load) => ({
	...(await load<typeof import("./work-items-principal")>()),
	verifiedActiveUserMembership: mocks.verifiedActiveUserMembership,
}));
vi.mock("@tedix/db/queries/skill-run-effects", () => ({
	recordSkillRunEffectObservation: mocks.record,
	listSkillRunEffectObservations: mocks.list,
}));
vi.mock("../../services/jev-skill-utility", () => ({
	assessSkillUtility: mocks.assess,
}));

import { skillsContractRouter } from "./cognitive";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const WORK = "44444444-4444-4444-8444-444444444444";
const OBS = "55555555-5555-4555-8555-555555555555";
const TEDI = "66666666-6666-4666-8666-666666666666";

function context(
	authType: BaseContext["authType"] = "user",
	orgId = ORG,
): BaseContext {
	return {
		authType,
		organizationId: orgId,
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "production" } as CloudflareEnv,
		headers: new Headers(),
		url: new URL("https://api.tedix.test/rpc/skills"),
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		user:
			authType === "user"
				? {
						aud: "test",
						exp: 2,
						iat: 1,
						iss: "https://auth.tedix.test",
						sub: "user-1",
						dct: "tenant-1",
						permissions: ["tedis:read", "tedis:update"],
						roles: [],
					}
				: undefined,
		tediId: authType === "tedi" ? TEDI : undefined,
		tediScopes: authType === "tedi" ? ["tedis:read", "tedis:write"] : undefined,
	} as BaseContext;
}
const client = (authType?: BaseContext["authType"], orgId?: string) =>
	createRouterClient(skillsContractRouter, {
		context: context(authType, orgId),
	});
const write = {
	runId: RUN,
	observedState: "confirmed" as const,
	evidenceRef: "review://receipt/1",
	effectNote: "The report appeared in the recipient inbox.",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSkillRun.mockResolvedValue({
		id: RUN,
		organizationId: ORG,
		tediId: TEDI,
		workItemId: WORK,
		status: "completed",
	});
	mocks.getWorkItemById.mockResolvedValue({
		id: WORK,
		orgId: ORG,
		acceptedAt: "2026-09-24T00:00:00.000Z",
		acceptanceContract: { doneLooksLike: "Recipient receives the report" },
	});
	mocks.getOrganizationById.mockResolvedValue({
		metadata: { jev: { enabled: true } },
	});
	mocks.verifiedActiveUserMembership.mockResolvedValue({
		userId: "user-1",
		status: "active",
	});
	mocks.record.mockResolvedValue({
		id: OBS,
		observedState: "confirmed",
		observedAt: "2026-09-24T12:00:00.000Z",
	});
	mocks.list.mockResolvedValue({
		truncated: false,
		rows: [
			{
				id: OBS,
				source: "human_attestation",
				workItemId: WORK,
				observedState: "confirmed",
				effectNote: write.effectNote,
				evidenceRef: write.evidenceRef,
			},
		],
	});
	mocks.assess.mockResolvedValue("supports");
});

describe("run-linked effect observation", () => {
	it("admits only an active user and derives tenant, Work Item, and observer", async () => {
		expect(await client().recordRunEffectObservation(write)).toMatchObject({
			id: OBS,
			source: "human_attestation",
			workItemId: WORK,
		});
		expect(mocks.record).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG,
				skillRunId: RUN,
				workItemId: WORK,
				observerUserId: "user-1",
				source: "human_attestation",
			}),
		);
		for (const authType of ["tedi", "apikey", "service-binding"] as const) {
			await expect(
				client(authType).recordRunEffectObservation(write),
			).rejects.toThrow();
		}
		expect(mocks.record).toHaveBeenCalledTimes(1);
	});

	it("rejects foreign, nonterminal, or unaccepted runs before mutation", async () => {
		await expect(
			client("user", OTHER).recordRunEffectObservation(write),
		).rejects.toThrow();
		mocks.getSkillRun.mockResolvedValueOnce(undefined);
		await expect(client().recordRunEffectObservation(write)).rejects.toThrow();
		mocks.getSkillRun.mockResolvedValueOnce({
			id: RUN,
			organizationId: ORG,
			workItemId: WORK,
			status: "running",
		});
		await expect(client().recordRunEffectObservation(write)).rejects.toThrow();
		mocks.getWorkItemById.mockResolvedValueOnce({
			id: WORK,
			orgId: ORG,
			acceptedAt: null,
			acceptanceContract: null,
		});
		await expect(client().recordRunEffectObservation(write)).rejects.toThrow();
		expect(mocks.record).not.toHaveBeenCalled();
	});

	it("assesses bounded human evidence without changing lifecycle", async () => {
		expect(await client().getRunUsefulness({ runId: RUN })).toMatchObject({
			alignment: "supports",
			reason: "assessment",
			evidenceSource: "human_attestation",
			observationIds: [OBS],
		});
		expect(mocks.assess).toHaveBeenCalledTimes(1);
		mocks.list.mockResolvedValueOnce({ rows: [], truncated: false });
		expect(await client().getRunUsefulness({ runId: RUN })).toMatchObject({
			alignment: "unknown",
			reason: "no_observation",
		});
		mocks.list.mockResolvedValueOnce({ rows: [], truncated: true });
		expect(await client().getRunUsefulness({ runId: RUN })).toMatchObject({
			alignment: "unknown",
			reason: "evidence_overflow",
		});
		expect(mocks.assess).toHaveBeenCalledTimes(1);
	});
});
