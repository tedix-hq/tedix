import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DelegationProfile } from "@tedix/api-contract/contracts/earned-delegation";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const delegationApi = vi.hoisted(() => ({
	getProfile: vi.fn(),
	// Governing verbs live on the settings:manage / earned-delegation:govern
	// plane. Present on the fake so the read-only assertion tests the component,
	// not the shape of the mock.
	grantEntrustment: vi.fn(),
	restrictEntrustment: vi.fn(),
	revokeEntrustment: vi.fn(),
	recordPromotionDecision: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: { earnedDelegation: delegationApi },
}));

import {
	deriveObservedPromotionGaps,
	EarnedAuthorityPanel,
	EntrustmentRow,
	EntrustmentsEmpty,
	formatMinorUnits,
	PromotionGaps,
	sortEntrustments,
	standingVariant,
	TediAuthority,
	ValidatedExperienceMeter,
} from "./tedi-authority";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TEDI_ID = "11111111-1111-4111-8111-111111111111";
const T = "2026-08-12T08:30:00.000Z";

type Entrustment = DelegationProfile["entrustments"][number];

const activity = (name: string): Entrustment["activity"] => ({
	id: "aaaaaaaa-0000-4000-8000-000000000001",
	organizationId: "aaaaaaaa-0000-4000-8000-0000000000ff",
	key: "publish_revenue_summary",
	version: 2,
	supersedesId: null,
	roleTemplateId: null,
	name,
	description: null,
	status: "active",
	taskFamily: "reporting",
	riskLevel: "medium",
	maximumLevel: "execute_reviewed",
	actionPatterns: ["reports.publish"],
	toolIds: ["publish_report"],
	rubric: {},
	rubricHash: "rubric",
	evidencePolicy: {
		minimumVerifiedObservations: 3,
		minimumDistinctVerifierPrincipals: 2,
		maximumFailureRate: 0.2,
		maximumPolicyViolationSeverity: 0,
		maximumEvidenceAgeDays: 90,
		requireNonTrivialWork: true,
		minimumReliabilityLowerBound: 0.5,
		minimumMeanComplexity: 0.25,
		minimumTaskFamilies: 1,
		minimumCalibrationScore: 0.7,
		minimumEscalationQuality: 0.7,
		requireLearningTransfer: false,
	},
	evidencePolicyHash: "evidence",
	createdAt: T,
	updatedAt: T,
});

const entrustment = (
	id: string,
	effectiveStatus: Entrustment["effectiveStatus"],
	name = "Publish the weekly revenue summary",
): Entrustment => ({
	id,
	organizationId: "aaaaaaaa-0000-4000-8000-0000000000ff",
	tediId: TEDI_ID,
	roleAssignmentId: null,
	activityId: "aaaaaaaa-0000-4000-8000-000000000001",
	level: "execute_reviewed",
	status: effectiveStatus === "revoked" ? "revoked" : "active",
	scope: {
		actions: ["reports.publish", "orders.read"],
		toolIds: ["publish_report"],
		environments: ["production"],
		spendPermission: "none",
		budgetPolicyId: null,
		constraints: {},
	},
	revision: 1,
	lastCertifiedAt: T,
	expiresAt: null,
	nextReviewAt: "2026-09-12T08:30:00.000Z",
	restrictedAt: null,
	reason: null,
	lastDecisionId: "aaaaaaaa-0000-4000-8000-000000000009",
	activityVersion: 2,
	rubricHash: "rubric",
	evidencePolicyHash: "evidence",
	evidenceSnapshotHash: "snapshot",
	grantedByType: "user",
	grantedById: "owner@tedix.dev",
	createdAt: T,
	updatedAt: T,
	effectiveStatus,
	activity: activity(name),
});

const role = (): NonNullable<DelegationProfile["activeRole"]> => ({
	id: "aaaaaaaa-0000-4000-8000-000000000005",
	organizationId: "aaaaaaaa-0000-4000-8000-0000000000ff",
	tediId: TEDI_ID,
	roleTemplateId: null,
	roleKey: "revenue_analyst",
	roleName: "Revenue analyst",
	status: "active",
	careerStage: "operator",
	assignedAt: T,
	stageChangedAt: T,
	endedAt: null,
	revision: 1,
	lastDecisionId: "aaaaaaaa-0000-4000-8000-000000000009",
	evidenceSnapshotHash: "snapshot",
	metadata: null,
	createdAt: T,
	updatedAt: T,
});

const profile = (
	overrides: Partial<DelegationProfile> = {},
): DelegationProfile => ({
	tediId: TEDI_ID,
	activeRole: role(),
	roleHistory: [role()],
	validatedExperience: {
		formulaVersion: "validated-experience-v1",
		descriptiveOnly: true,
		authorityEffect: "none",
		provisional: true,
		limitations: [],
		points: 700,
		maxPoints: 3000,
		validatedUnits: 7,
		uncappedUnits: 8.5,
		creditedOpportunities: 21,
		negativeOpportunities: 1,
		maximumPolicyViolationSeverity: 0,
		standing: "clear",
		observationsEvaluated: 40,
		truncated: false,
		saturated: false,
		lastValidatedAt: T,
		taskFamilies: [],
	},
	delegationYield: {
		metric: "verified_value_per_owner_review_hour",
		authorityEffect: "none",
		measurementStatus: "partial",
		provisional: true,
		coverage: "observed_issued_work_items_only",
		observedOpportunities: 12,
		issuedOpportunities: 15,
		reviewedOpportunities: 10,
		valueCertifiedOpportunities: 6,
		ownerReviewMinutes: 120,
		valueByCurrency: [],
		costByCurrency: [],
		truncated: false,
		limitations: ["Coverage limited to observed issued Work Items"],
	},
	entrustments: [entrustment("e1", "active")],
	...overrides,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("deriveObservedPromotionGaps", () => {
	it("reports nothing for a profile with a role, credit, and active scope", () => {
		expect(deriveObservedPromotionGaps(profile())).toEqual([]);
	});

	it("names an unassigned role track", () => {
		expect(
			deriveObservedPromotionGaps(profile({ activeRole: null })).some((gap) =>
				gap.includes("role track"),
			),
		).toBe(true);
	});

	it("names zero credited held-out work", () => {
		const gaps = deriveObservedPromotionGaps(
			profile({
				validatedExperience: {
					...profile().validatedExperience,
					creditedOpportunities: 0,
				},
			}),
		);
		expect(gaps.some((gap) => gap.includes("held-out work"))).toBe(true);
	});

	it("distinguishes contested standing from blocked standing", () => {
		const contested = deriveObservedPromotionGaps(
			profile({
				validatedExperience: {
					...profile().validatedExperience,
					standing: "contested",
				},
			}),
		);
		const blocked = deriveObservedPromotionGaps(
			profile({
				validatedExperience: {
					...profile().validatedExperience,
					standing: "blocked",
				},
			}),
		);
		expect(contested.some((gap) => gap.includes("remediation"))).toBe(true);
		expect(blocked.some((gap) => gap.includes("policy violation"))).toBe(true);
	});

	it("flags a truncated evidence window", () => {
		expect(
			deriveObservedPromotionGaps(
				profile({
					validatedExperience: {
						...profile().validatedExperience,
						truncated: true,
					},
				}),
			).some((gap) => gap.includes("truncated")),
		).toBe(true);
	});

	// An expired or revoked grant authorizes nothing. Counting it as scope would
	// declare authority the tedi does not have.
	it("treats a non-active entrustment as no earned operating scope", () => {
		expect(
			deriveObservedPromotionGaps(
				profile({ entrustments: [entrustment("e1", "expired")] }),
			).some((gap) => gap.includes("entrustment")),
		).toBe(true);
	});
});

describe("sortEntrustments", () => {
	it("puts what currently authorizes work first, lapsed last", () => {
		const sorted = sortEntrustments([
			entrustment("d", "revoked"),
			entrustment("c", "expired"),
			entrustment("b", "restricted"),
			entrustment("a", "active"),
		]);
		expect(sorted.map((row) => row.effectiveStatus)).toEqual([
			"active",
			"restricted",
			"expired",
			"revoked",
		]);
	});

	it("breaks ties on activity name so the order is total", () => {
		const sorted = sortEntrustments([
			entrustment("b", "active", "Zulu"),
			entrustment("a", "active", "Alpha"),
		]);
		expect(sorted.map((row) => row.activity.name)).toEqual(["Alpha", "Zulu"]);
	});

	it("does not mutate its input", () => {
		const input = [entrustment("b", "revoked"), entrustment("a", "active")];
		sortEntrustments(input);
		expect(input[0]?.effectiveStatus).toBe("revoked");
	});
});

describe("standingVariant", () => {
	it("escalates contested and blocked, never celebrates them", () => {
		expect(standingVariant("clear")).toBe("success");
		expect(standingVariant("contested")).toBe("warning");
		expect(standingVariant("blocked")).toBe("error");
	});
});

describe("formatMinorUnits", () => {
	it("uses the currency's own minor-unit scale", () => {
		expect(formatMinorUnits(250_000, "USD")).toContain("2,500");
		// JPY has no minor unit — a blind /100 would understate it 100x.
		expect(formatMinorUnits(2500, "JPY")).toContain("2,500");
	});

	it("names the unit honestly for a code the runtime cannot format", () => {
		expect(formatMinorUnits(1234, "NOTACURRENCY")).toContain(
			"NOTACURRENCY minor units",
		);
	});
});

// ---------------------------------------------------------------------------
// Presentational subcomponents
// ---------------------------------------------------------------------------

describe("ValidatedExperienceMeter", () => {
	it("states that points grant nothing, next to the bar", () => {
		const html = renderToStaticMarkup(
			<ValidatedExperienceMeter experience={profile().validatedExperience} />,
		);
		expect(html).toContain("never grant authority");
		expect(html).toContain('data-filled="23"');
	});

	it("clamps a saturated profile to the canvas instead of overflowing it", () => {
		const html = renderToStaticMarkup(
			<ValidatedExperienceMeter
				experience={{
					...profile().validatedExperience,
					points: 9000,
					maxPoints: 3000,
				}}
			/>,
		);
		expect(html).toContain('data-filled="100"');
	});
});

describe("earned-authority surface tiers", () => {
	/**
	 * Stat tiles, the experience meter, the yield panel, and entrustment rows
	 * are all bounded regions *inside* the earned-authority section rather than
	 * peers of a `Card`, so every one of them stays on the well tier and keeps
	 * the 8px control radius.
	 */
	it("keeps every earned-authority box on the nested well tier", () => {
		const html = renderToStaticMarkup(
			<EntrustmentRow entrustment={entrustment("e1", "active")} />,
		);
		expect(html).toContain('data-slot="surface"');
		expect(html).toContain('data-tier="well"');
		expect(html).toContain("rounded-lg");
		expect(html).not.toContain("rounded-xl");
		expect(html).not.toContain("border-kumo-hairline");
		expect(html).toMatch(/^<li /);
	});
});

describe("EntrustmentRow", () => {
	it("shows the level, the scope, and the review dates", () => {
		const html = renderToStaticMarkup(
			<EntrustmentRow entrustment={entrustment("e1", "active")} />,
		);
		expect(html).toContain("Execute with review");
		expect(html).toContain("reporting");
		expect(html).toContain("2 scoped actions");
		expect(html).toContain("No expiry recorded");
		expect(html).toContain('data-status="active"');
	});

	// relativeTime is a past-tense dialect whose "just now" cutoff swallows every
	// negative delta — it rendered a review a month out as "just now", telling an
	// operator that a live grant was already due.
	it("renders future review and expiry instants absolutely, never relatively", () => {
		const html = renderToStaticMarkup(
			<EntrustmentRow
				entrustment={{
					...entrustment("e1", "active"),
					expiresAt: "2027-01-04T08:30:00.000Z",
					nextReviewAt: "2026-09-12T08:30:00.000Z",
				}}
			/>,
		);
		expect(html).not.toContain("just now");
		expect(html).toContain("Sep 12, 2026");
		expect(html).toContain("Jan 4, 2027");
	});

	it("says spend is none rather than leaving it unstated", () => {
		const html = renderToStaticMarkup(
			<EntrustmentRow entrustment={entrustment("e1", "active")} />,
		);
		expect(html).toContain("spend none");
	});
});

describe("PromotionGaps", () => {
	// The server owns readiness. An empty gap list must never read as "ready".
	it("refuses to declare readiness when no gap is visible", () => {
		const html = renderToStaticMarkup(<PromotionGaps gaps={[]} />);
		expect(html).toContain("Readiness not assessed");
		expect(html).toContain("never declares readiness");
	});

	it("lists the observed gaps and counts them", () => {
		const html = renderToStaticMarkup(
			<PromotionGaps
				gaps={["Assign a role track.", "No active entrustment."]}
			/>,
		);
		expect(html).toContain("2 observed evidence gaps");
		expect(html).toContain("Assign a role track.");
	});
});

describe("EntrustmentsEmpty", () => {
	it("says a title authorizes nothing by itself", () => {
		expect(renderToStaticMarkup(<EntrustmentsEmpty />)).toContain(
			"authorize nothing by themselves",
		);
	});
});

describe("EarnedAuthorityPanel", () => {
	it("renders stage, scope, experience, and gaps together", () => {
		const html = renderToStaticMarkup(
			<EarnedAuthorityPanel profile={profile()} />,
		);
		expect(html).toContain("Operator");
		expect(html).toContain("Revenue analyst");
		expect(html).toContain("Publish the weekly revenue summary");
		expect(html).toContain("Readiness not assessed");
		expect(html).toContain('aria-label="Earned authority summary"');
		expect(html).toContain('data-slot="metric-grid"');
		expect(html.match(/data-slot="metric-item"/g)).toHaveLength(4);
		expect(html).not.toContain("grid-cols-2 gap-2 sm:grid-cols-4");
	});

	it("says the yield is unmeasured rather than printing a zero rate", () => {
		const html = renderToStaticMarkup(
			<EarnedAuthorityPanel profile={profile()} />,
		);
		expect(html).toContain("Not measured yet");
	});
});

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderSection(): HTMLElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<TediAuthority tediId={TEDI_ID} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

beforeEach(() => {
	for (const mock of Object.values(delegationApi)) mock.mockReset();
	delegationApi.getProfile.mockResolvedValue(profile());
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("TediAuthority", () => {
	it("reads the canonical delegation profile by tedi id", async () => {
		renderSection();
		await flush();
		expect(delegationApi.getProfile).toHaveBeenCalledWith(
			{ tediId: TEDI_ID },
			// The contract-derived option forwards TanStack Query's AbortSignal.
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("never reaches a governing verb from this read surface", async () => {
		renderSection();
		await flush();
		expect(delegationApi.grantEntrustment).not.toHaveBeenCalled();
		expect(delegationApi.restrictEntrustment).not.toHaveBeenCalled();
		expect(delegationApi.revokeEntrustment).not.toHaveBeenCalled();
		expect(delegationApi.recordPromotionDecision).not.toHaveBeenCalled();
	});

	it("renders the earned-authority evidence", async () => {
		const container = renderSection();
		await flush();
		expect(
			container.querySelector('[data-slot="page-section"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-slot="section-header"]'),
		).not.toBeNull();
		expect(container.textContent).toContain(
			"Delegation evidence and the limits",
		);
		expect(container.textContent).toContain("Revenue analyst");
		expect(container.textContent).toContain("Task-specific authority");
	});

	// A refused read is an authorization state, not an outage — and it must
	// never render as "no authority", which is a different, false claim.
	it("distinguishes a refused read from a broken one", async () => {
		delegationApi.getProfile.mockRejectedValue(
			Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }),
		);
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain(
			"Earned-authority evidence is not readable with your access",
		);
		expect(container.textContent).not.toContain("No entrustments granted");
	});

	it("surfaces a genuine failure with its message", async () => {
		delegationApi.getProfile.mockRejectedValue(new Error("D1 unavailable"));
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain(
			"Earned-authority evidence is unavailable",
		);
		expect(container.textContent).toContain("D1 unavailable");
	});
});
