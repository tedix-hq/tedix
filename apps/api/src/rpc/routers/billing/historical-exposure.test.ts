import {
	CutoverQualificationTables,
	CutoverQualificationFamilies,
} from "@tedix/api-contract/schemas/tedi";
import { beforeEach, describe, it, expect, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	tedi: vi.fn(),
	audit: vi.fn(),
	write: vi.fn(),
	funding: vi.fn(),
	set: vi.fn(),
	decision: vi.fn(),
	prior: vi.fn(),
	finiteWrite: vi.fn(),
	finiteRead: vi.fn(),
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
		recordHistoricalExposure: mocks.write,
		recordHistoricalDecision: mocks.decision,
		getHistoricalDecisionOperation: mocks.prior,
		recordFiniteExecutionAuthorization: mocks.finiteWrite,
		readFiniteExecutionAuthorizationForHuman: mocks.finiteRead,
		recordFiniteExecutionRevocation: mocks.finiteRevoke,
		getFiniteExecutionAuthorization: mocks.finiteGet,
	}),
);
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("../tedis/crud", () => ({ agentAdminFetch: mocks.audit }));
import {
	authorizeHistoricalFreshExecutionHandler,
	revokeHistoricalFreshExecutionHandler,
	recordHistoricalExposureHandler,
	listHistoricalExposuresHandler,
	recordHistoricalFreshDecisionHandler,
	requireHistoricalHuman,
} from "./historical-exposure";
const org = "00000000-0000-4000-8000-000000000001",
	tedi = "00000000-0000-4000-8000-000000000002",
	user = "00000000-0000-4000-8000-000000000003";
const input = {
	tediId: tedi,
	operationId: "audit-op",
	rootObjectId: "a".repeat(64),
	targetPath: [],
	objectId: "a".repeat(64),
	expectedGeneration: 2,
	snapshotId: "b".repeat(64),
	sourceHash: "c".repeat(64),
};
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
const summary = {
	ok: true,
	id: input.objectId,
	command: "audit_historical_custody",
	operationId: input.operationId,
	generation: 2,
	state: "quarantined",
	receiver: "raw-cutover-v1",
	snapshotId: input.snapshotId,
	sourceHash: input.sourceHash,
	workflowCount: 8,
	fiberCount: 4,
	identityCount: 9,
};
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
	mocks.audit.mockResolvedValue({ ok: true, status: 200, json: summary });
	mocks.write.mockImplementation(async (_db, i) => ({ payload: i.payload }));
	mocks.prior.mockResolvedValue(null);
});
describe("human historical audit provenance", () => {
	it("uses only private audit-only transport and persists actual summary with null unknowns", async () => {
		const result = await recordHistoricalExposureHandler(context(), input);
		const call = mocks.audit.mock.calls[0]!;
		expect(call[2]).toBe("/__admin/pi-state-cutover");
		expect(call[3]).toMatchObject({
			method: "POST",
			requireServiceBinding: true,
			body: {
				command: "audit_historical_custody",
				expectedSourceHash: input.sourceHash,
				custody: { tediId: tedi, orgId: org, objectName: "canonical" },
			},
		});
		expect(result).toMatchObject({
			organizationId: org,
			exposure: "UNKNOWN",
			effects: "UNKNOWN",
			manifestHash: null,
			originalRunId: null,
			originalWorkId: null,
			originalPeriod: null,
			usage: null,
			costMicros: null,
			workflowCount: 8,
			observedUserId: user,
		});
		expect(mocks.tedi).toHaveBeenCalledTimes(2);
	});
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
				recordHistoricalExposureHandler(
					context(patch as Partial<BaseContext>),
					input,
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.audit).not.toHaveBeenCalled();
			expect(mocks.write).not.toHaveBeenCalled();
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
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	for (const changed of [
		{ id: "f".repeat(64) },
		{ sourceHash: "f".repeat(64) },
		{ snapshotId: "f".repeat(64) },
		{ generation: 3 },
		{ command: "capture_historical_custody" },
		{ receiver: "warm-agent" },
		{ state: "active" },
		{ providerRows: ["secret"] },
	]) {
		it(`rejects forged audit ${Object.keys(changed)}`, async () => {
			mocks.audit.mockResolvedValue({
				ok: true,
				status: 200,
				json: { ...summary, ...changed },
			});
			await expect(
				recordHistoricalExposureHandler(context(), input),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				message: "Verified historical custody unavailable",
			});
			expect(mocks.write).not.toHaveBeenCalled();
		});
	}
	it("hides private transport errors and denies final canonical D1 rename", async () => {
		mocks.audit.mockResolvedValue({ error: "private-secret-provider-payload" });
		await expect(
			recordHistoricalExposureHandler(context(), input),
		).rejects.toMatchObject({
			message: "Verified historical custody unavailable",
		});
		expect(mocks.write).not.toHaveBeenCalled();
		mocks.audit.mockResolvedValue({ ok: true, status: 200, json: summary });
		mocks.tedi
			.mockResolvedValueOnce({
				id: tedi,
				organizationId: org,
				isolateAgentId: "canonical",
			})
			.mockResolvedValueOnce({
				id: tedi,
				organizationId: org,
				isolateAgentId: "changed",
			});
		await expect(
			recordHistoricalExposureHandler(context(), input),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("exact expired/revoked retry returns original event before new funding and never renews", async () => {
		const { HistoricalFreshDecisionInputSchema } =
				await import("@tedix/api-contract/schemas/billing"),
			{ historicalRequestHash } =
				await import("@tedix/db/queries/billing/historical-exposure");
		const i = HistoricalFreshDecisionInputSchema.parse({
			tediId: tedi,
			operationId: "old",
			objectId: input.objectId,
			expectedRevision: 0,
			exposureSetHash: "d".repeat(64),
			permittedGeneration: 3,
			permittedClasses: ["AgentTediDO"],
			funding: {
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
			},
			expiresAt: "2020-01-02T00:00:00.000Z",
			acknowledgeUnboundedUnknownExposure: true,
		});
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
					objectId: input.objectId,
					payload: await recordHistoricalExposureHandler(context(), input),
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
	it("records the exact original nested leaf beneath separately verified canonical root custody", async () => {
		const first = {
				...hop,
				className: "ConversationFacet",
				objectId: "f".repeat(64),
			},
			selected = { ...input, objectId: hop.objectId, targetPath: [first, hop] };
		mocks.audit.mockResolvedValue({
			ok: true,
			status: 200,
			json: { ...summary, targetObjectId: hop.objectId },
		});
		const result = await recordHistoricalExposureHandler(context(), selected);
		expect(mocks.audit.mock.calls[0]![3].body).toMatchObject({
			objectId: input.rootObjectId,
			targetPath: selected.targetPath,
		});
		expect(result).toMatchObject({
			rootObjectId: input.rootObjectId,
			rootObjectName: "canonical",
			objectId: hop.objectId,
			objectName: hop.identityName,
			className: hop.className,
			targetPath: selected.targetPath,
			usage: null,
			costMicros: null,
			effects: "UNKNOWN",
		});
		mocks.set.mockResolvedValue({
			rows: [{ payload: result }],
			revision: 1,
			hash: input.sourceHash,
		});
		expect(
			await listHistoricalExposuresHandler(context(), { tediId: tedi }),
		).toMatchObject({ scope: "recorded_objects_only", exposures: [result] });
	});
	for (const changed of [
		{ targetObjectId: undefined },
		{ targetObjectId: "f".repeat(64) },
		{ id: hop.objectId },
	])
		it(`denies leaf audit identity contradiction ${Object.keys(changed)}`, async () => {
			mocks.audit.mockResolvedValue({
				ok: true,
				status: 200,
				json: { ...summary, targetObjectId: hop.objectId, ...changed },
			});
			await expect(
				recordHistoricalExposureHandler(context(), {
					...input,
					objectId: hop.objectId,
					targetPath: [hop],
				}),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				message: "Verified historical custody unavailable",
			});
			expect(mocks.write).not.toHaveBeenCalled();
		});
	it("root audit cannot silently return a descendant and malformed paths never dispatch", async () => {
		mocks.audit.mockResolvedValue({
			ok: true,
			status: 200,
			json: { ...summary, targetObjectId: hop.objectId },
		});
		await expect(
			recordHistoricalExposureHandler(context(), input),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		expect(mocks.write).not.toHaveBeenCalled();
		mocks.audit.mockClear();
		await expect(
			recordHistoricalExposureHandler(context(), {
				...input,
				objectId: hop.objectId,
				targetPath: [],
			}),
		).rejects.toThrow();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	it("a leaf-only set may be listed but cannot supply a root epoch for a fresh record", async () => {
		mocks.audit.mockResolvedValue({
			ok: true,
			status: 200,
			json: { ...summary, targetObjectId: hop.objectId },
		});
		const leaf = await recordHistoricalExposureHandler(context(), {
			...input,
			objectId: hop.objectId,
			targetPath: [hop],
		});
		mocks.set.mockResolvedValue({
			rows: [
				{ objectName: "canonical", objectId: hop.objectId, payload: leaf },
			],
			hash: input.sourceHash,
		});
		const { HistoricalFreshDecisionInputSchema } =
			await import("@tedix/api-contract/schemas/billing");
		const decision = HistoricalFreshDecisionInputSchema.parse({
			tediId: tedi,
			operationId: "leaf-only",
			objectId: input.rootObjectId,
			expectedRevision: 0,
			exposureSetHash: input.sourceHash,
			permittedGeneration: 3,
			permittedClasses: ["AgentTediDO"],
			funding: {
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
			},
			expiresAt: "2020-01-02T00:00:00.000Z",
			acknowledgeUnboundedUnknownExposure: true,
		});
		await expect(
			recordHistoricalFreshDecisionHandler(context(), decision),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.funding).not.toHaveBeenCalled();
		expect(mocks.decision).not.toHaveBeenCalled();
	});
});

const emptyQualification = {
	nativeSchemaState: "absent",
	nativeSchemaVersion: null,
	tables: CutoverQualificationTables.map((table) => ({
		table,
		present: false,
		schemaState: "absent",
		rowCount: null,
		projectionHash: null,
		statusCounts: {},
	})),
	journalFamilies: CutoverQualificationFamilies.map((family) => ({
		family,
		count: 0,
		states: {},
		malformedCount: 0,
		unsupportedCount: 0,
	})),
	journalCount: 0,
	offset: 0,
	rows: [],
};
const preparedInspection = {
	version: "pi-cutover-inspection-v2",
	qualification: emptyQualification,
	ok: true,
	id: "f".repeat(64),
	sampledAt: "2026-10-05T00:00:00.000Z",
	sdkWork: [
		"cf_agents_fibers",
		"cf_agents_runs",
		"cf_agents_task_runs",
		"cf_agents_workflows",
		"cf_agents_facet_runs",
	].map((table) => ({ table, present: false, counts: {} })),
	sdkWorkflows: { present: false, count: 0, offset: 0, rows: [] },
	maintenanceJournal: { count: 0, offset: 0, records: [] },
	admission: { state: "held", generation: 3 },
	hash: "e".repeat(64),
	inspectionHash: "d".repeat(64),
	receiver: "raw-cutover-v1",
	targetsKnown: true,
	inspectionTargets: [],
	offset: 0,
	limit: 1,
	counts: {
		tables: 0,
		receipts: 0,
		privateImages: 0,
		children: 0,
		maintenance: 0,
	},
	nextOffset: null,
	inventory: {
		storedOwner: {
			tediId: tedi,
			orgId: org,
			slug: "test",
			sessionKey: null,
			unknown: false,
		},
		tables: [],
		receipts: [],
		privateImages: [],
		children: [],
		maintenance: [],
		imported: false,
		activeConversationId: null,
		blocked: false,
	},
};
async function finiteSetup() {
	const { FiniteExecutionAuthorizationInputSchema } =
		await import("@tedix/api-contract/schemas/billing");
	const old = await recordHistoricalExposureHandler(context(), input);
	mocks.audit.mockClear();
	mocks.tedi.mockResolvedValue({
		id: tedi,
		organizationId: org,
		isolateAgentId: "fresh",
		slug: "test",
	});
	const start = new Date(Date.now() - 60000).toISOString(),
		end = new Date(Date.now() + 3600000).toISOString();
	const funding = {
		accountId: org,
		entitlementVersion: 1,
		settlementMode: "managed",
		billingMode: "internal",
		status: "active",
		planVersionId: user,
		planVersion: 1,
		periodStart: start,
		periodEnd: end,
		stripeEnvironment: null,
	};
	mocks.funding.mockResolvedValue({
		account: {
			organizationId: org,
			entitlementVersion: 1,
			billingMode: "internal",
			status: "active",
			planVersionId: user,
			periodStart: start,
			periodEnd: end,
			stripeEnvironment: null,
		},
		plan: { id: user, version: 1 },
	});
	mocks.set.mockResolvedValue({
		hash: input.sourceHash,
		revision: 1,
		rows: [
			{
				...old,
				operationId: input.operationId,
				objectName: "canonical",
				payload: old,
			},
		],
	});
	mocks.audit.mockResolvedValue({
		ok: true,
		status: 200,
		json: preparedInspection,
	});
	mocks.finiteWrite.mockImplementation(async (_db, event) => ({
		payload: event,
	}));
	const request = FiniteExecutionAuthorizationInputSchema.parse({
		kind: "authorize_fresh_execution",
		tediId: tedi,
		operationId: "permit",
		expectedRevision: 0,
		exposureSetHash: input.sourceHash,
		freshRootName: "fresh",
		freshRootId: preparedInspection.id,
		preparedGeneration: 3,
		executionGeneration: 4,
		leafScopes: [{ className: "ConversationFacet", generations: [1] }],
		funding,
		maxSendDurationSeconds: 30,
		expiresAt: new Date(Date.now() + 600000).toISOString(),
		acknowledgeUnboundedUnknownExposure: true,
		acknowledgeOutstandingSendWindowAfterRevocation: true,
	});
	return { request, old };
}
describe("explicit human finite execution permission", () => {
	it("uses guarded passive preparation and records original facts without release or dispatch", async () => {
		const { request, old } = await finiteSetup();
		const result = await authorizeHistoricalFreshExecutionHandler(
			context(),
			request,
		);
		expect(result.authority).toBe("finite_execution_permit");
		expect(result.exposures).toEqual([old]);
		expect(result.input.executionGeneration).toBe(4);
		expect(result.preparation.generation).toBe(3);
		expect(result.input.leafScopes).toEqual([
			{ className: "ConversationFacet", generations: [1] },
		]);
		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit.mock.calls[0]![3]).toMatchObject({
			method: "GET",
			requireServiceBinding: true,
			query: {
				objectId: request.freshRootId,
				custodyTediId: tedi,
				expectedGeneration: "3",
				offset: "0",
				limit: "1",
			},
		});
		expect(mocks.write).toHaveBeenCalledTimes(1);
	});
	for (const mode of [
		"absent",
		"oldInspection",
		"missingQualification",
		"active",
		"retired",
		"wrongOwner",
		"wrongOrg",
		"unknownOwner",
		"wrongPhysical",
		"wrongGeneration",
		"warm",
		"unknownRegistry",
		"malformed",
		"privateFailure",
	])
		it(`denies ${mode} preparation without appending permission`, async () => {
			const { request } = await finiteSetup();
			const observed = structuredClone(preparedInspection);
			if (mode === "absent") Object.assign(observed, { admission: null });
			if (mode === "oldInspection")
				Object.assign(observed, { version: undefined });
			if (mode === "missingQualification")
				Object.assign(observed, { qualification: undefined });
			if (mode === "active" || mode === "retired")
				observed.admission.state = mode;
			if (mode === "wrongOwner") observed.inventory.storedOwner.tediId = user;
			if (mode === "wrongOrg") observed.inventory.storedOwner.orgId = user;
			if (mode === "unknownOwner")
				observed.inventory.storedOwner.unknown = true;
			if (mode === "wrongPhysical") observed.id = "a".repeat(64);
			if (mode === "wrongGeneration") observed.admission.generation = 4;
			if (mode === "warm") Object.assign(observed, { receiver: undefined });
			if (mode === "unknownRegistry") observed.targetsKnown = false;
			mocks.audit.mockResolvedValue(
				mode === "privateFailure"
					? { ok: false, status: 503, json: { private_secret: "never echo" } }
					: {
							ok: true,
							status: 200,
							json:
								mode === "malformed"
									? { private_secret: "never echo" }
									: observed,
						},
			);
			await expect(
				authorizeHistoricalFreshExecutionHandler(context(), request),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				message: "Verified nonactive fresh root preparation unavailable",
			});
			expect(mocks.finiteWrite).not.toHaveBeenCalled();
		});
	it("final canonical reread catches a name swap after inspection and funding awaits", async () => {
		const { request } = await finiteSetup();
		mocks.funding.mockImplementationOnce(async () => {
			mocks.tedi.mockResolvedValue({
				id: tedi,
				organizationId: org,
				isolateAgentId: "changed",
			});
			return {
				account: {
					organizationId: org,
					entitlementVersion: 1,
					billingMode: "internal",
					status: "active",
					planVersionId: user,
					periodStart: request.funding.periodStart,
					periodEnd: request.funding.periodEnd,
					stripeEnvironment: null,
				},
				plan: { id: user, version: 1 },
			};
		});
		await expect(
			authorizeHistoricalFreshExecutionHandler(context(), request),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: "Fresh canonical custody changed",
		});
		expect(mocks.finiteWrite).not.toHaveBeenCalled();
	});
	it("funding identity and conditional-write conflicts cannot fabricate permission", async () => {
		const { request } = await finiteSetup();
		mocks.funding.mockResolvedValueOnce(null);
		await expect(
			authorizeHistoricalFreshExecutionHandler(context(), request),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.finiteWrite).not.toHaveBeenCalled();
		mocks.funding.mockResolvedValue({
			account: {
				organizationId: org,
				entitlementVersion: 1,
				billingMode: "internal",
				status: "active",
				planVersionId: user,
				periodStart: request.funding.periodStart,
				periodEnd: request.funding.periodEnd,
				stripeEnvironment: null,
			},
			plan: { id: user, version: 1 },
		});
		mocks.finiteWrite.mockResolvedValueOnce(null);
		await expect(
			authorizeHistoricalFreshExecutionHandler(context(), request),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("exact retry reads original evidence before inspection and cannot renew", async () => {
		const { request } = await finiteSetup();
		const grant = await authorizeHistoricalFreshExecutionHandler(
			context(),
			request,
		);
		mocks.prior.mockResolvedValue({
			payload: grant,
			requestHash: grant.requestHash,
		});
		mocks.finiteRead.mockResolvedValue({ payload: grant });
		mocks.audit.mockClear();
		mocks.finiteWrite.mockClear();
		expect(
			await authorizeHistoricalFreshExecutionHandler(context(), request),
		).toEqual(grant);
		expect(mocks.audit).not.toHaveBeenCalled();
		expect(mocks.finiteWrite).not.toHaveBeenCalled();
		await expect(
			authorizeHistoricalFreshExecutionHandler(context(), {
				...request,
				maxSendDurationSeconds: 31,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		mocks.finiteRead.mockResolvedValue(null);
		await expect(
			authorizeHistoricalFreshExecutionHandler(context(), request),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("explicit revocation binds original finite grant; bookkeeping events cannot substitute", async () => {
		const { request } = await finiteSetup();
		const grant = await authorizeHistoricalFreshExecutionHandler(
			context(),
			request,
		);
		mocks.finiteGet.mockResolvedValue({ payload: grant });
		mocks.finiteRevoke.mockImplementation(async (_db, p) => ({ payload: p }));
		const revoke = {
			kind: "revoke_fresh_execution" as const,
			tediId: tedi,
			operationId: "revoke",
			expectedRevision: 1,
			authorizationId: grant.id,
		};
		const event = await revokeHistoricalFreshExecutionHandler(
			context(),
			revoke,
		);
		expect(event).toMatchObject({
			authority: "finite_execution_permit",
			kind: "revocation",
			decisionId: grant.id,
			freshRootName: "fresh",
		});
		mocks.finiteGet.mockResolvedValue({
			payload: { ...grant, authority: "records_only" },
		});
		await expect(
			revokeHistoricalFreshExecutionHandler(context(), revoke),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("finite grant recorded facts are separate from fresh custody", () => {
	it("does not mistake the old recorded root for distinct fresh preparation", async () => {
		const { request } = await finiteSetup();
		mocks.tedi.mockResolvedValue({
			id: tedi,
			organizationId: org,
			isolateAgentId: "canonical",
		});
		mocks.audit.mockClear();
		await expect(
			authorizeHistoricalFreshExecutionHandler(context(), {
				...request,
				freshRootName: "canonical",
				freshRootId: input.rootObjectId,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.audit).not.toHaveBeenCalled();
		expect(mocks.finiteWrite).not.toHaveBeenCalled();
	});
	it("malformed/foreign old recorded facts do not become a financial scope", async () => {
		const { request, old } = await finiteSetup();
		mocks.set.mockResolvedValue({
			hash: request.exposureSetHash,
			rows: [
				{
					...old,
					operationId: "old",
					payload: { ...old, organizationId: user },
				},
			],
		});
		mocks.audit.mockClear();
		await expect(
			authorizeHistoricalFreshExecutionHandler(context(), request),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.audit).not.toHaveBeenCalled();
		expect(mocks.finiteWrite).not.toHaveBeenCalled();
	});
});
