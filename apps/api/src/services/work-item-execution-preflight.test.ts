/**
 * Control-plane resolution in the Work Item execution preflight.
 *
 * Nullable runtime-profile and policy-pack FKs resolve to published system
 * defaults, matching `apps/tedi/src/resolve.ts`. Preflight must distinguish a
 * missing system default from a dangling per-tedi pin.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	getRuntimeProfileById: vi.fn(),
	getPolicyPackById: vi.fn(),
	getSystemDefaultRuntimeProfile: vi.fn(),
	getSystemDefaultPolicyPack: vi.fn(),
	getTediById: vi.fn(),
	getTediCapabilityCards: vi.fn(),
	deriveRequiresApproval: vi.fn(),
}));

vi.mock(
	"@tedix/db/queries/control-plane/definitions",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/control-plane/definitions")
		>()),
		getRuntimeProfileById: mocks.getRuntimeProfileById,
		getPolicyPackById: mocks.getPolicyPackById,
		getSystemDefaultRuntimeProfile: mocks.getSystemDefaultRuntimeProfile,
		getSystemDefaultPolicyPack: mocks.getSystemDefaultPolicyPack,
	}),
);
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: mocks.getTediById,
}));
vi.mock("../rpc/routers/kernel/tedi-capabilities", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../rpc/routers/kernel/tedi-capabilities")
	>()),
	getTediCapabilityCards: mocks.getTediCapabilityCards,
	deriveRequiresApproval: mocks.deriveRequiresApproval,
}));

const { resolveWorkItemExecutionPreflight } =
	await import("./work-item-execution-preflight");

const TEDI_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const WORK_ITEM_ID = "33333333-3333-4333-8333-333333333333";

/** A tedi row with the FK shape under test. */
function tediRow(overrides: Record<string, unknown> = {}) {
	return {
		id: TEDI_ID,
		slug: "cto",
		organizationId: ORG_ID,
		status: "active",
		runtimeState: "idle",
		governanceOverride: null,
		// Null FKs select the published system defaults.
		runtimeProfileId: null,
		policyPackId: null,
		...overrides,
	};
}

/**
 * A capability bundle with no tools, so the preflight reaches the control-plane
 * decisions without needing app/connection fixtures.
 *
 * `WorkItemCapabilityBundleSchema` is `.strict()` and has no `skills` field —
 * an earlier draft of this fixture invented one and the whole suite failed at
 * "capability bundle metadata is invalid", never reaching the code under test.
 */
function workItem(overrides: Record<string, unknown> = {}) {
	return {
		id: WORK_ITEM_ID,
		orgId: ORG_ID,
		assigneeTediId: TEDI_ID,
		claimedByTediId: null,
		metadata: {
			capabilityBundle: {
				version: 1 as const,
				targetTediId: TEDI_ID,
				tools: [],
				connections: [],
			},
		},
		...overrides,
	};
}

function activeProfile(slug: string) {
	return { id: "rp", slug, scope: "system", status: "active", config: {} };
}
function activePack(slug: string) {
	return { id: "pp", slug, scope: "system", status: "active", definition: {} };
}

async function resolve() {
	return await resolveWorkItemExecutionPreflight({
		db: {} as never,
		env: {} as never,
		workItem: workItem() as never,
		now: "2026-08-18T00:00:00.000Z",
	});
}

function decisionFor(
	result: Awaited<ReturnType<typeof resolve>>,
	kind: string,
) {
	return result.decisions.find((d) => d.kind === kind);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getTediById.mockResolvedValue(tediRow());
	mocks.getTediCapabilityCards.mockResolvedValue([{ tediId: TEDI_ID }]);
	mocks.deriveRequiresApproval.mockReturnValue(false);
	mocks.getRuntimeProfileById.mockResolvedValue(
		activeProfile("system-default"),
	);
	mocks.getPolicyPackById.mockResolvedValue(activePack("system-default"));
	mocks.getSystemDefaultRuntimeProfile.mockResolvedValue(
		activeProfile("system-default"),
	);
	mocks.getSystemDefaultPolicyPack.mockResolvedValue(
		activePack("system-default"),
	);
});

describe("null control-plane FKs fall back to the system defaults", () => {
	it("resolves the seeded system defaults instead of blocking", async () => {
		const result = await resolve();

		// The same head-of-slug resolvers the runtime path uses, so both agree.
		// Asserting the RESOLVER rather than an id is the point: a compiled-in
		// id is exactly what drifted from the published head before this.
		expect(mocks.getSystemDefaultRuntimeProfile).toHaveBeenCalled();
		expect(mocks.getSystemDefaultPolicyPack).toHaveBeenCalled();
		expect(mocks.getRuntimeProfileById).not.toHaveBeenCalled();
		expect(mocks.getPolicyPackById).not.toHaveBeenCalled();
		expect(decisionFor(result, "runtime_profile")?.verdict).toBe("allowed");
		expect(decisionFor(result, "policy")?.verdict).toBe("allowed");
		expect(result.blockingReasons).toEqual([]);
		expect(result.status).not.toBe("blocked");
	});

	it("still honours a pin when the tedi has one", async () => {
		mocks.getTediById.mockResolvedValue(
			tediRow({ runtimeProfileId: "pinned-rp", policyPackId: "pinned-pp" }),
		);
		mocks.getRuntimeProfileById.mockResolvedValue(activeProfile("custom"));
		mocks.getPolicyPackById.mockResolvedValue(activePack("custom"));

		await resolve();

		// A pin must win over the default — the fallback applies only to null.
		expect(mocks.getRuntimeProfileById).toHaveBeenCalledWith(
			expect.anything(),
			"pinned-rp",
		);
		expect(mocks.getPolicyPackById).toHaveBeenCalledWith(
			expect.anything(),
			"pinned-pp",
		);
	});
});

describe("capability bundle boundary", () => {
	it("fails closed on malformed capability metadata without capability reads", async () => {
		const result = await resolveWorkItemExecutionPreflight({
			db: {} as never,
			env: {} as never,
			workItem: workItem({
				metadata: { capabilityBundle: { version: 2 } },
			}) as never,
			now: "2026-08-20T00:00:00.000Z",
		});
		expect(result).toMatchObject({
			status: "blocked",
			dispatchAllowed: false,
			manifest: null,
			blockingReasons: ["capability bundle metadata is invalid"],
		});
		expect(mocks.getTediCapabilityCards).not.toHaveBeenCalled();
	});

	it("requires an accountable tedi before resolving a typed bundle", async () => {
		const result = await resolveWorkItemExecutionPreflight({
			db: {} as never,
			env: {} as never,
			workItem: workItem({
				accountableOwnerType: null,
				accountableOwnerId: null,
				metadata: {
					capabilityBundle: {
						version: 1,
						requiredCapabilities: ["browser_session", "live_verify"],
						tools: [],
						connections: [],
					},
				},
			}) as never,
			now: "2026-08-20T00:00:00.000Z",
		});
		expect(result).toMatchObject({
			status: "blocked",
			dispatchAllowed: false,
			executionRequirement: { surface: "workstation" },
		});
		expect(result.blockingReasons).toContain(
			"capability preflight requires a target or assigned tedi",
		);
		expect(mocks.getTediCapabilityCards).not.toHaveBeenCalled();
	});
});

describe("an unresolvable profile still blocks, and names the real cause", () => {
	it("reports a MISSING SYSTEM DEFAULT as a deployment fault, not a tedi one", async () => {
		// Null FK + absent default row: the platform is broken for every org, and
		// the old message blamed "the selected tedi".
		mocks.getSystemDefaultRuntimeProfile.mockResolvedValue(null);

		const result = await resolve();

		const decision = decisionFor(result, "runtime_profile");
		expect(decision?.verdict).toBe("missing");
		expect(decision?.reason).toContain("system-default runtime profile");
		expect(decision?.reason).toContain("this deployment");
		expect(decision?.reason).not.toContain("the selected tedi has no");
		expect(result.status).toBe("blocked");
	});

	it("reports a DANGLING PIN against the pinned id, not the default", async () => {
		mocks.getTediById.mockResolvedValue(
			tediRow({ policyPackId: "deleted-pack" }),
		);
		mocks.getPolicyPackById.mockResolvedValue(null);

		const result = await resolve();

		const decision = decisionFor(result, "policy");
		expect(decision?.verdict).toBe("missing");
		expect(decision?.reason).toContain("deleted-pack");
		expect(decision?.reason).toContain("no longer exists");
		expect(result.status).toBe("blocked");
	});

	it("still blocks an inactive profile — the fallback never overrides status", async () => {
		mocks.getSystemDefaultRuntimeProfile.mockResolvedValue({
			...activeProfile("system-default"),
			status: "archived",
		});

		const result = await resolve();

		expect(decisionFor(result, "runtime_profile")?.verdict).toBe("denied");
		expect(result.blockingReasons.join(" ")).toContain("archived");
		expect(result.status).toBe("blocked");
	});
});
