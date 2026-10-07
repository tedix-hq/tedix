import { beforeEach, describe, it, expect, vi } from "vite-plus/test";
import {
	FiniteExecutionAuthorizationSchema,
	HistoricalExposureSchema,
	HistoricalFreshDecisionInputSchema,
} from "@tedix/api-contract/schemas/billing";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	tedi: vi.fn(),
	funding: vi.fn(),
	set: vi.fn(),
	decision: vi.fn(),
	prior: vi.fn(),
	finiteRevoke: vi.fn(),
	finiteGet: vi.fn(),
}));
vi.mock(
	"@tedix/db/queries/billing/historical-exposure",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/billing/historical-exposure")
		>()),
		getHistoricalBillingMember: mocks.member,
		getHistoricalFunding: mocks.funding,
		historicalExposureSet: mocks.set,
		recordHistoricalDecision: mocks.decision,
		getHistoricalDecisionOperation: mocks.prior,
		recordFiniteExecutionRevocation: mocks.finiteRevoke,
		getFiniteExecutionAuthorization: mocks.finiteGet,
	}),
);
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
import {
	revokeHistoricalFreshExecutionHandler,
	listHistoricalExposuresHandler,
	recordHistoricalFreshDecisionHandler,
	requireHistoricalHuman,
} from "./historical-exposure";
const org = "00000000-0000-4000-8000-000000000001",
	tedi = "00000000-0000-4000-8000-000000000002",
	user = "00000000-0000-4000-8000-000000000003";
const rootObjectId = "a".repeat(64);
function context(patch: Partial<BaseContext> = {}): BaseContext {
	return {
		authType: "user",
		organizationId: org,
		userId: user,
		userRole: "owner",
		user: { sub: "human", permissions: ["billing:manage"], roles: [] },
		db: {},
		env: { TEDIX_BILLING_SETTLEMENT_MODE: "managed" },
		...patch,
	} as BaseContext;
}
const hop = {
	className: "Researcher",
	name: "original-name",
	identityVersion: "path-v2" as const,
	identityName: "original-identity",
	objectId: "d".repeat(64),
	registryHash: "e".repeat(64),
	parentGeneration: 2,
};
/** An already recorded exposure row; recording new rows is retired. */
function exposure(leaf = false) {
	return HistoricalExposureSchema.parse({
		id: crypto.randomUUID(),
		organizationId: org,
		tediId: tedi,
		rootObjectName: "canonical",
		rootObjectId,
		targetPath: leaf ? [hop] : [],
		objectName: leaf ? hop.identityName : "canonical",
		objectId: leaf ? hop.objectId : rootObjectId,
		className: leaf ? hop.className : "AgentTediDO",
		generation: 2,
		snapshotId: "b".repeat(64),
		sourceHash: "c".repeat(64),
		manifestHash: null,
		originalRunId: null,
		originalWorkId: null,
		originalPeriod: null,
		usage: null,
		costMicros: null,
		effects: "UNKNOWN",
		exposure: "UNKNOWN",
		workflowCount: 8,
		fiberCount: 4,
		identityCount: 9,
		observedBy: "human",
		observedUserId: user,
		observedAt: "2020-01-01T00:00:00.000Z",
		requestHash: "f".repeat(64),
	});
}
const funding = {
	accountId: org,
	entitlementVersion: 1,
	settlementMode: "managed",
	billingMode: "internal",
	status: "active",
	planVersionId: user,
	planVersion: 1,
	periodStart: "2020-01-01T00:00:00.000Z",
	periodEnd: "2020-02-01T00:00:00.000Z",
	stripeEnvironment: null,
};
function decisionInput(operationId: string, exposureSetHash: string) {
	return HistoricalFreshDecisionInputSchema.parse({
		tediId: tedi,
		operationId,
		objectId: rootObjectId,
		expectedRevision: 0,
		exposureSetHash,
		permittedGeneration: 3,
		permittedClasses: ["AgentTediDO"],
		funding,
		expiresAt: "2020-01-02T00:00:00.000Z",
		acknowledgeUnboundedUnknownExposure: true,
	});
}
beforeEach(() => {
	Object.values(mocks).forEach((m) => m.mockReset());
	mocks.member.mockResolvedValue({
		organizationId: org,
		descopeUserId: "human",
		userId: user,
		role: "owner",
		status: "active",
	});
	mocks.tedi.mockResolvedValue({
		id: tedi,
		organizationId: org,
		isolateAgentId: "canonical",
		slug: "test",
	});
	mocks.prior.mockResolvedValue(null);
});
describe("human historical billing records", () => {
	for (const patch of [
		{ authType: "tedi" },
		{ authType: "apikey" },
		{ authType: "m2m" },
		{ authType: "service-binding" },
		{ tediId: tedi },
		{ externalAgentPrincipalId: "external" },
		{ userId: undefined },
		{
			user: {
				sub: "human",
				entityType: "tedi",
				permissions: ["platform:admin"],
			},
		},
	]) {
		it(`denies nonhuman or contradictory principal ${JSON.stringify(patch)}`, async () => {
			await expect(
				listHistoricalExposuresHandler(context(patch as Partial<BaseContext>), {
					tediId: tedi,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.set).not.toHaveBeenCalled();
		});
	}
	it("rejects inactive, viewer, cross-canonical member identity without relying on JWT owner", async () => {
		for (const m of [
			null,
			{ role: "viewer", userId: user },
			{ role: "owner", userId: "foreign" },
		]) {
			mocks.member.mockResolvedValue(m);
			await expect(requireHistoricalHuman(context())).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
	});
	it("lists the already recorded exposure set under canonical custody", async () => {
		const leaf = exposure(true);
		mocks.set.mockResolvedValue({
			rows: [{ payload: leaf }],
			revision: 1,
			hash: "c".repeat(64),
		});
		expect(
			await listHistoricalExposuresHandler(context(), { tediId: tedi }),
		).toMatchObject({ scope: "recorded_objects_only", exposures: [leaf] });
	});
	it("exact expired/revoked retry returns original event before new funding and never renews", async () => {
		const { historicalRequestHash } =
			await import("@tedix/db/queries/billing/historical-exposure");
		const i = decisionInput("old", "d".repeat(64));
		const event = {
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			revision: 1,
			kind: "decision",
			decisionId: null,
			recordedBy: "human",
			recordedUserId: user,
			recordedAt: "2020-01-01T00:00:00.000Z",
			requestHash: await historicalRequestHash([org, "human", user, i]),
			input: i,
			authority: "records_only",
		};
		mocks.set.mockResolvedValue({
			rows: [
				{
					objectName: "canonical",
					objectId: rootObjectId,
					payload: exposure(),
				},
			],
			hash: i.exposureSetHash,
		});
		mocks.prior.mockResolvedValue({
			requestHash: event.requestHash,
			payload: event,
		});
		expect(await recordHistoricalFreshDecisionHandler(context(), i)).toEqual(
			event,
		);
		expect(mocks.funding).not.toHaveBeenCalled();
		expect(mocks.decision).not.toHaveBeenCalled();
		await expect(
			recordHistoricalFreshDecisionHandler(context(), {
				...i,
				permittedGeneration: 4,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("a leaf-only set may be listed but cannot supply a root epoch for a fresh record", async () => {
		mocks.set.mockResolvedValue({
			rows: [
				{
					objectName: "canonical",
					objectId: hop.objectId,
					payload: exposure(true),
				},
			],
			hash: "c".repeat(64),
		});
		await expect(
			recordHistoricalFreshDecisionHandler(
				context(),
				decisionInput("leaf-only", "c".repeat(64)),
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.funding).not.toHaveBeenCalled();
		expect(mocks.decision).not.toHaveBeenCalled();
	});
});

describe("revoking an already recorded finite execution permit", () => {
	function grant() {
		const recorded = exposure();
		return FiniteExecutionAuthorizationSchema.parse({
			id: crypto.randomUUID(),
			organizationId: org,
			tediId: tedi,
			revision: 1,
			kind: "decision",
			decisionId: null,
			recordedBy: "human",
			recordedUserId: user,
			recordedAt: "2020-01-01T00:00:00.000Z",
			requestHash: "9".repeat(64),
			authority: "finite_execution_permit",
			input: {
				kind: "authorize_fresh_execution",
				tediId: tedi,
				operationId: "permit",
				expectedRevision: 0,
				exposureSetHash: "c".repeat(64),
				freshRootName: "fresh",
				freshRootId: "f".repeat(64),
				preparedGeneration: 3,
				executionGeneration: 4,
				leafScopes: [{ className: "ConversationFacet", generations: [1] }],
				funding,
				maxSendDurationSeconds: 30,
				expiresAt: "2020-01-01T01:00:00.000Z",
				acknowledgeUnboundedUnknownExposure: true,
				acknowledgeOutstandingSendWindowAfterRevocation: true,
			},
			preparation: {
				state: "held",
				generation: 3,
				inspectionHash: "d".repeat(64),
				receiver: "raw-cutover-v1",
			},
			exposures: [recorded],
			exposureOperations: [{ id: recorded.id, operationId: "audit-op" }],
		});
	}
	it("binds the original finite grant; bookkeeping events cannot substitute", async () => {
		mocks.tedi.mockResolvedValue({
			id: tedi,
			organizationId: org,
			isolateAgentId: "fresh",
		});
		const original = grant();
		mocks.finiteGet.mockResolvedValue({ payload: original });
		mocks.finiteRevoke.mockImplementation(async (_db, p) => ({ payload: p }));
		const revoke = {
			kind: "revoke_fresh_execution" as const,
			tediId: tedi,
			operationId: "revoke",
			expectedRevision: 1,
			authorizationId: original.id,
		};
		expect(
			await revokeHistoricalFreshExecutionHandler(context(), revoke),
		).toMatchObject({
			authority: "finite_execution_permit",
			kind: "revocation",
			decisionId: original.id,
			freshRootName: "fresh",
		});
		mocks.finiteGet.mockResolvedValue({
			payload: { ...original, authority: "records_only" },
		});
		await expect(
			revokeHistoricalFreshExecutionHandler(context(), revoke),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
