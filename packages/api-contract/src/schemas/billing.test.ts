import { describe, expect, test } from "vite-plus/test";
import {
	BillingOverviewSchema,
	WorkstationCostCoverageSchema,
	CreateInferenceCapacityCheckoutInputSchema,
	InferenceCapacityPackSchema,
	RecordVoiceProviderUsageInputSchema,
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

describe("daily inference capacity schemas", () => {
	test("accepts a catalog pack with token and spend capacity", () => {
		expect(
			InferenceCapacityPackSchema.parse({
				packKey: "daily-boost-small",
				name: "Daily boost",
				tokens: 1_000_000,
				spendCapacityMicros: 5_000_000,
				priceMicros: 6_000_000,
				currency: "usd",
			}),
		).toMatchObject({ tokens: 1_000_000, spendCapacityMicros: 5_000_000 });
	});

	test("rejects zero-capacity packs and invalid checkout URLs", () => {
		expect(() =>
			InferenceCapacityPackSchema.parse({
				packKey: "empty",
				name: "Empty",
				tokens: 0,
				spendCapacityMicros: 0,
				priceMicros: 1,
				currency: "usd",
			}),
		).toThrow();
		expect(() =>
			CreateInferenceCapacityCheckoutInputSchema.parse({
				packKey: "daily-boost-small",
				successUrl: "/admin/billing",
			}),
		).toThrow();
	});

	test("preserves signed sponsor debits while keeping usage and remaining capacity nonnegative", () => {
		const schema = BillingOverviewSchema.shape.inferenceCapacity;
		const capacity = {
			available: true,
			monthlyMetered: false,
			blockingReason: null,
			unblockAction: "none",
			budgetDay: "2026-09-05",
			baseDailyTokenLimit: 5_000_000,
			baseDailySpendLimitMicros: 25_000_000,
			allocatedTokens: -4_000_000,
			allocatedSpendCapacityMicros: -20_000_000,
			sponsoredTokens: -3_000_000,
			sponsoredSpendCapacityMicros: -15_000_000,
			usedTokens: 14_081,
			usedSpendMicros: 22_090,
			remainingTokens: 985_919,
			remainingSpendMicros: 4_977_910,
			expiresAt: "2026-09-06T00:00:00.000Z",
			allocations: [],
			tediOverflow: [],
			packs: [],
		};
		expect(schema.parse(capacity)).toEqual(capacity);
		const { monthlyMetered: _omittedMetering, ...withoutMetering } = capacity;
		expect(schema.safeParse(withoutMetering).success).toBe(false);
		for (const key of [
			"usedTokens",
			"usedSpendMicros",
			"remainingTokens",
			"remainingSpendMicros",
		]) {
			expect(schema.safeParse({ ...capacity, [key]: -1 }).success).toBe(false);
		}
		expect(
			schema.safeParse({ ...capacity, allocatedTokens: -0.5 }).success,
		).toBe(false);
		// The sponsored pair is the part of the allocation transferred to embedded
		// customers: signed like the total, and integral like every other counter.
		for (const key of ["sponsoredTokens", "sponsoredSpendCapacityMicros"]) {
			expect(schema.safeParse({ ...capacity, [key]: -0.5 }).success).toBe(
				false,
			);
			expect(schema.safeParse({ ...capacity, [key]: 0 }).success).toBe(true);
			const { [key]: _omitted, ...withoutSponsorField } = capacity;
			expect(schema.safeParse(withoutSponsorField).success).toBe(false);
		}
	});

	test("projects one UTC budget day without conflating per-tedi policy", () => {
		const result = BillingOverviewSchema.safeParse({
			stripeEnvironment: "test",
			workstationCostCoverage: {
				periodStart: "2026-08-01T00:00:00.000Z",
				periodEnd: "2026-09-01T00:00:00.000Z",
				observedAt: "2026-09-20T00:00:00.000Z",
				unit: "compute_seconds",
				basis: "recorded_lease_end_wall_clock",
				status: "partial",
				knownAttributedCostMicros: 2000000,
				total: { rowCount: 3, leaseSeconds: 300 },
				reconciled: { rowCount: 1, leaseSeconds: 100 },
				pending: { rowCount: 1, leaseSeconds: 100 },
				unproven: { rowCount: 1, leaseSeconds: 100 },
			},
			snapshot: {
				status: "active",
				billingMode: "stripe",
				planKey: "growth",
				planVersion: 1,
				periodStart: "2026-08-01T00:00:00.000Z",
				periodEnd: "2026-09-01T00:00:00.000Z",
				includedTokens: 1,
				usedTokens: 0,
				reservedTokens: 0,
				remainingIncludedTokens: 1,
				creditBalanceMicros: 0,
				reservedChargeMicros: 0,
				availableCreditMicros: 0,
				customerChargeMicros: 0,
				hardSpendLimitMicros: null,
				allowOverage: true,
				stripeCustomerId: null,
			},
			plan: {
				name: "Growth",
				currency: "usd",
				monthlyPriceMicros: 1,
				annualPriceMicros: 1,
				includedMonthlyCreditMicros: 0,
				overageUnitTokens: 1,
				overageUnitPriceMicros: 1,
				maxTedis: 1,
				maxCronJobsPerTedi: 1,
				maxIterationsPerTask: 1,
				defaultDailyTokenLimit: 1,
				defaultDailyMessageLimit: 1,
			},
			period: null,
			inferenceCapacity: {
				available: true,
				monthlyMetered: false,
				blockingReason: null,
				unblockAction: "none",
				budgetDay: "2026-08-22",
				baseDailyTokenLimit: 10_000_000,
				baseDailySpendLimitMicros: 80_000_000,
				allocatedTokens: 1_000_000,
				allocatedSpendCapacityMicros: 5_000_000,
				sponsoredTokens: 0,
				sponsoredSpendCapacityMicros: 0,
				usedTokens: 10_500_000,
				usedSpendMicros: 82_000_000,
				remainingTokens: 500_000,
				remainingSpendMicros: 3_000_000,
				expiresAt: "2026-08-23T00:00:00.000Z",
				allocations: [],
				tediOverflow: [],
				packs: [],
			},
			serviceCredits: { seo: null },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			const { workstationCostCoverage: _coverage, ...withoutCoverage } =
				result.data;
			expect(BillingOverviewSchema.safeParse(withoutCoverage).success).toBe(
				false,
			);
			expect(
				BillingOverviewSchema.safeParse({
					...result.data,
					workstationCostCoverage: {
						...result.data.workstationCostCoverage,
						periodStart: "2026-07-01T00:00:00.000Z",
					},
				}).success,
			).toBe(false);
		}
	});
});

import {
	HistoricalExposureInputSchema,
	HistoricalExposureSchema,
	HistoricalFreshDecisionInputSchema,
} from "./billing";
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
