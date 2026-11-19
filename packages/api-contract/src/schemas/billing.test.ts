import { describe, expect, test } from "vite-plus/test";
import {
	BillingCreditsSchema,
	BillingTopUpPackSchema,
	RecordVoiceProviderUsageInputSchema,
	SetAccountCreditsInputSchema,
	SetCreditCapsInputSchema,
	SetPayAsYouGoInputSchema,
	WorkstationCostCoverageSchema,
} from "./billing";

const base = {
	organizationId: "org-1",
	providerUsageId: "voice:call-1",
	provider: "workers-ai",
	model: "@cf/deepgram/flux",
	usageKind: "voice_stt" as const,
	unit: "seconds" as const,
	quantity: 30,
	occurredAt: "2026-07-31T12:00:00.000Z",
};

describe("RecordVoiceProviderUsageInputSchema", () => {
	test("accepts directly observed STT seconds", () => {
		expect(RecordVoiceProviderUsageInputSchema.parse(base)).toEqual(base);
	});

	test("rejects mismatched voice units", () => {
		expect(() =>
			RecordVoiceProviderUsageInputSchema.parse({
				...base,
				usageKind: "voice_tts",
			}),
		).toThrow(/voice_stt uses seconds and voice_tts uses characters/);
	});
});

import {
	HistoricalExposureInputSchema,
	HistoricalExposureSchema,
	HistoricalFreshDecisionInputSchema,
} from "./billing";
describe("Tedix credit schemas", () => {
	const credits = {
		periodStart: "2026-11-01T00:00:00.000Z",
		periodEnd: "2026-12-01T00:00:00.000Z",
		includedCredits: 15_000,
		usedCredits: 12_000,
		remainingIncludedCredits: 3_000,
		topUpCredits: 1_000,
		breakdown: { ai: 11_000, codeRuns: 500, services: 500 },
		notices: [{ threshold: 80, reachedAt: "2026-11-20T00:00:00.000Z" }],
		payAsYouGo: { enabled: false, monthlyCapMicros: null, spentMicros: 0 },
		tedis: [
			{
				tediId: "tedi-1",
				name: "Research",
				usedCredits: 9_000,
				monthlyCapCredits: 10_000,
			},
		],
		members: [
			{
				userId: "user-1",
				name: "Admin",
				usedCredits: 3_000,
				monthlyCapCredits: null,
			},
		],
	};

	test("accepts the credits section and rejects negative or token figures", () => {
		expect(BillingCreditsSchema.parse(credits)).toEqual(credits);
		expect(() =>
			BillingCreditsSchema.parse({ ...credits, includedCredits: -1 }),
		).toThrow();
		expect(() =>
			BillingCreditsSchema.parse({
				...credits,
				notices: [{ threshold: 90, reachedAt: credits.periodStart }],
			}),
		).toThrow();
	});

	test("sells only 12-month EUR top-up packs", () => {
		expect(
			BillingTopUpPackSchema.parse({
				packKey: "credits-1000",
				credits: 1_000,
				priceMicros: 10_000_000,
				currency: "eur",
				validMonths: 12,
			}),
		).toMatchObject({ credits: 1_000 });
		expect(() =>
			BillingTopUpPackSchema.parse({
				packKey: "credits-1000",
				credits: 1_000,
				priceMicros: 10_000_000,
				currency: "eur",
				validMonths: 1,
			}),
		).toThrow();
	});

	test("requires a monthly cap to turn on pay-as-you-go", () => {
		expect(() =>
			SetPayAsYouGoInputSchema.parse({ enabled: true, monthlyCapMicros: null }),
		).toThrow();
		expect(
			SetPayAsYouGoInputSchema.parse({
				enabled: false,
				monthlyCapMicros: null,
			}),
		).toEqual({ enabled: false, monthlyCapMicros: null });
	});

	test("caps are non-negative or null and overrides need a reason", () => {
		expect(() =>
			SetCreditCapsInputSchema.parse({
				tediCaps: [{ tediId: "tedi-1", monthlyCapCredits: -1 }],
			}),
		).toThrow();
		expect(
			SetCreditCapsInputSchema.parse({
				memberCaps: [{ userId: "user-1", monthlyCapCredits: null }],
			}),
		).toMatchObject({ memberCaps: [{ monthlyCapCredits: null }] });
		expect(() =>
			SetAccountCreditsInputSchema.parse({
				organizationId: "org-1",
				includedCreditsOverride: 1_000_000,
				reason: "",
			}),
		).toThrow();
	});
});

describe("historical record strict inputs", () => {
	const input = {
		tediId: "00000000-0000-4000-8000-000000000001",
		operationId: "audit",
		rootObjectId: "a".repeat(64),
		targetPath: [],
		objectId: "a".repeat(64),
		expectedGeneration: 1,
		snapshotId: "b".repeat(64),
		sourceHash: "c".repeat(64),
	};
	test("rejects caller-supplied human attribution, costs, unknown hashes and provider facts", () => {
		expect(HistoricalExposureInputSchema.safeParse(input).success).toBe(true);
		for (const extra of [
			{ approverId: "human" },
			{ costMicros: 0 },
			{ manifestHash: "d".repeat(64) },
			{ usage: 0 },
			{ providerRows: [] },
		])
			expect(
				HistoricalExposureInputSchema.safeParse({ ...input, ...extra }).success,
			).toBe(false);
		expect(
			HistoricalExposureInputSchema.safeParse({
				...input,
				sourceHash: "unknown",
			}).success,
		).toBe(false);
	});

	test("requires explicit acknowledgement and rejects supplied attribution on otherwise valid decisions", () => {
		const valid = {
			tediId: input.tediId,
			operationId: "decision",
			objectId: input.objectId,
			expectedRevision: 0,
			exposureSetHash: input.sourceHash,
			permittedGeneration: 2,
			permittedClasses: ["AgentTediDO"],
			funding: {
				accountId: input.tediId,
				entitlementVersion: 1,
				settlementMode: "managed",
				billingMode: "internal",
				status: "active",
				planVersionId: input.tediId,
				planVersion: 1,
				periodStart: "2026-10-01T00:00:00.000Z",
				periodEnd: "2026-11-01T00:00:00.000Z",
				stripeEnvironment: null,
			},
			expiresAt: "2026-10-20T00:00:00.000Z",
			acknowledgeUnboundedUnknownExposure: true,
		};
		expect(HistoricalFreshDecisionInputSchema.safeParse(valid).success).toBe(
			true,
		);
		const withoutAck: Partial<typeof valid> = { ...valid };
		delete withoutAck.acknowledgeUnboundedUnknownExposure;
		for (const value of [
			withoutAck,
			{ ...valid, acknowledgeUnboundedUnknownExposure: false },
			{ ...valid, approverId: "human" },
			{ ...valid, recordedUserId: input.tediId },
			{ ...valid, permittedClasses: ["AgentTediDO", "AgentTediDO"] },
		])
			expect(HistoricalFreshDecisionInputSchema.safeParse(value).success).toBe(
				false,
			);
	});
	test("requires explicit root and original registered path, with no root-only compatibility", () => {
		const hop = {
			className: "Researcher",
			name: "original-name",
			identityVersion: "path-v2",
			identityName: "original-identity",
			objectId: "d".repeat(64),
			registryHash: "e".repeat(64),
			parentGeneration: 2,
		};
		const selected = { ...input, objectId: hop.objectId, targetPath: [hop] };
		expect(HistoricalExposureInputSchema.parse(selected).targetPath).toEqual([
			hop,
		]);
		const { rootObjectId: _root, targetPath: _path, ...old } = input;
		for (const value of [
			old,
			{ ...selected, targetPath: [] },
			{ ...input, targetPath: [hop] },
			{ ...selected, targetPath: [hop, hop] },
			{ ...selected, rootObjectId: hop.objectId },
			{ ...selected, targetPath: [{ ...hop, identityName: null }] },
		])
			expect(HistoricalExposureInputSchema.safeParse(value).success).toBe(
				false,
			);
	});
	test("preserves historical labels but refuses retired fresh classes", () => {
		const hop = {
			className: "ThinkMessengerStateAgent",
			name: "telegram",
			identityVersion: null,
			identityName: null,
			objectId: "d".repeat(64),
			registryHash: "e".repeat(64),
			parentGeneration: 2,
		};
		const historical = {
			id: crypto.randomUUID(),
			organizationId: input.tediId,
			tediId: input.tediId,
			rootObjectId: input.rootObjectId,
			rootObjectName: "canonical",
			objectId: hop.objectId,
			objectName: hop.name,
			className: hop.className,
			targetPath: [hop],
			generation: 2,
			snapshotId: input.snapshotId,
			sourceHash: input.sourceHash,
			manifestHash: null,
			originalRunId: null,
			originalWorkId: null,
			originalPeriod: null,
			usage: null,
			costMicros: null,
			effects: "UNKNOWN",
			exposure: "UNKNOWN",
			workflowCount: 1,
			fiberCount: 1,
			identityCount: 1,
			observedBy: "human",
			observedUserId: input.tediId,
			observedAt: "2026-10-05T00:00:00.000Z",
			requestHash: input.sourceHash,
		};
		expect(HistoricalExposureSchema.parse(historical).className).toBe(
			hop.className,
		);
		for (const patch of [
			{ className: "ConversationFacet" },
			{ objectName: "renamed" },
			{ rootObjectId: hop.objectId },
		])
			expect(
				HistoricalExposureSchema.safeParse({ ...historical, ...patch }).success,
			).toBe(false);
		for (const className of ["Researcher", "ThinkMessengerStateAgent"])
			expect(
				HistoricalFreshDecisionInputSchema.shape.permittedClasses.safeParse([
					className,
				]).success,
			).toBe(false);
	});
});

describe("explicit finite authorization schemas", () => {
	const value = {
		kind: "authorize_fresh_execution",
		tediId: "00000000-0000-4000-8000-000000000002",
		operationId: "finite",
		expectedRevision: 0,
		exposureSetHash: "a".repeat(64),
		freshRootName: "fresh",
		freshRootId: "b".repeat(64),
		preparedGeneration: 1,
		executionGeneration: 2,
		leafScopes: [{ className: "ConversationFacet", generations: [1] }],
		funding: {
			accountId: "00000000-0000-4000-8000-000000000001",
			entitlementVersion: 1,
			settlementMode: "managed",
			billingMode: "internal",
			status: "active",
			planVersionId: "00000000-0000-4000-8000-000000000003",
			planVersion: 1,
			periodStart: "2026-10-01T00:00:00.000Z",
			periodEnd: "2026-11-01T00:00:00.000Z",
			stripeEnvironment: null,
		},
		maxSendDurationSeconds: 60,
		expiresAt: "2026-10-05T10:00:00.000Z",
		acknowledgeUnboundedUnknownExposure: true,
		acknowledgeOutstandingSendWindowAfterRevocation: true,
	};
	test("requires explicit finite semantics and next prepared epoch without preexisting leaf identities", async () => {
		const { FiniteExecutionAuthorizationInputSchema: S } =
			await import("./billing");
		expect(S.parse(value)).toEqual(value);
		expect(S.parse({ ...value, leafScopes: [] })).toMatchObject({
			leafScopes: [],
		});
		for (const patch of [
			{ kind: "decision" },
			{ executionGeneration: 1 },
			{ executionGeneration: 3 },
			{ preparedGeneration: 0 },
			{ freshRootId: "unknown" },
			{ maxSendDurationSeconds: 0 },
			{ maxSendDurationSeconds: 0.5 },
			{ maxSendDurationSeconds: Infinity },
			{ acknowledgeUnboundedUnknownExposure: false },
			{ acknowledgeOutstandingSendWindowAfterRevocation: false },
			{ expiresAt: "2026-11-02T00:00:00.000Z" },
			{ leafScopes: [{ className: "Researcher", generations: [1] }] },
			{ leafScopes: [{ className: "ConversationFacet", generations: [0] }] },
			{ leafScopes: [{ className: "ConversationFacet", generations: [1, 1] }] },
			{
				leafScopes: [
					{ className: "ConversationFacet", generations: [1] },
					{ className: "ConversationFacet", generations: [2] },
				],
			},
			{ authority: "human" },
			{ costMicros: 0 },
			{ alreadyApproved: true },
			{ source: "kernel" },
		])
			expect(S.safeParse({ ...value, ...patch }).success).toBe(false);
		const { kind: _kind, ...missing } = value;
		expect(S.safeParse(missing).success).toBe(false);
	});
	test("finite input cannot silently coerce a records-only decision, and revocation is separate", async () => {
		const {
			HistoricalFreshDecisionInputSchema: R,
			FiniteExecutionRevocationInputSchema: S,
		} = await import("./billing");
		expect(R.safeParse(value).success).toBe(false);
		const revoke = {
			kind: "revoke_fresh_execution",
			tediId: value.tediId,
			operationId: "revoke",
			expectedRevision: 1,
			authorizationId: value.funding.planVersionId,
		};
		expect(S.parse(revoke)).toEqual(revoke);
		expect(
			S.safeParse({ ...revoke, decisionId: revoke.authorizationId }).success,
		).toBe(false);
		expect(S.safeParse({ ...revoke, kind: "revocation" }).success).toBe(false);
	});
});

describe("recorded workstation cost coverage", () => {
	const valid = {
		periodStart: "2026-09-01T00:00:00.000Z",
		periodEnd: "2026-10-01T00:00:00.000Z",
		observedAt: "2026-09-20T00:00:00.000Z",
		unit: "compute_seconds",
		basis: "recorded_lease_end_wall_clock",
		status: "partial",
		knownAttributedCostMicros: 2000000,
		total: { rowCount: 3, leaseSeconds: 300 },
		reconciled: { rowCount: 1, leaseSeconds: 100 },
		pending: { rowCount: 1, leaseSeconds: 100 },
		unproven: { rowCount: 1, leaseSeconds: 100 },
	};
	test("keeps pending/unproven outside the known subtotal", () => {
		expect(WorkstationCostCoverageSchema.parse(valid)).toEqual(valid);
	});
	test("accepts evidenced zero, not pending zero", () => {
		expect(
			WorkstationCostCoverageSchema.safeParse({
				...valid,
				knownAttributedCostMicros: 0,
			}).success,
		).toBe(true);
		expect(
			WorkstationCostCoverageSchema.safeParse({
				...valid,
				knownAttributedCostMicros: null,
			}).success,
		).toBe(false);
	});
	for (const patch of [
		{ total: { rowCount: 4, leaseSeconds: 300 } },
		{ status: "recorded_rows_reconciled" },
		{ knownAttributedCostMicros: -1 },
		{ knownAttributedCostMicros: Number.MAX_SAFE_INTEGER + 1 },
		{ periodEnd: valid.periodStart },
		{ unit: "seconds" },
	])
		test(`refuses inconsistent coverage ${JSON.stringify(patch)}`, () => {
			expect(
				WorkstationCostCoverageSchema.safeParse({ ...valid, ...patch }).success,
			).toBe(false);
		});
});
