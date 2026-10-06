import { describe, expect, it } from "vite-plus/test";
import {
	ListTediRuntimeMetaBySlugsInputSchema,
	ListTediRuntimeMetaBySlugsResponseSchema,
	TediRuntimeMetaSchema,
} from "./tedi";

describe("TediRuntimeMetaSchema (MCP aggregate runtime-meta projection)", () => {
	const validRow = {
		slug: "cto",
		id: "id-cto",
		organizationId: "org-1",
		runtimeKind: "agent",
		runtimeState: "active",
		status: "active" as string | null,
	};

	it("accepts the canonical projection", () => {
		expect(TediRuntimeMetaSchema.parse(validRow)).toEqual(validRow);
	});

	// Regression guard: these enum-ish fields MUST stay tolerant `string`s, not
	// strict enums. `tedis.*` are drizzle enum hints over plain SQLite text with
	// no CHECK constraint, so a drifted/legacy row is physically possible. If this
	// schema is re-tightened to enums, one drifted row would fail whole-response
	// output validation → 500 → the MCP consumer's fail-safe re-advertises retired
	// tedis. Keep it tolerant; the consumer does its own equality/includes checks.
	it("tolerates an enum-drifted runtimeKind (does not reject non-'agent')", () => {
		expect(
			TediRuntimeMetaSchema.parse({ ...validRow, runtimeKind: "isolate" })
				.runtimeKind,
		).toBe("isolate");
	});

	it("tolerates a drifted runtimeState / status and a null status", () => {
		expect(
			TediRuntimeMetaSchema.parse({ ...validRow, runtimeState: "hibernating" })
				.runtimeState,
		).toBe("hibernating");
		expect(
			TediRuntimeMetaSchema.parse({ ...validRow, status: "quarantined" })
				.status,
		).toBe("quarantined");
		expect(
			TediRuntimeMetaSchema.parse({ ...validRow, status: null }).status,
		).toBeNull();
	});
});

describe("ListTediRuntimeMetaBySlugs input/response schemas", () => {
	it("requires at least one slug and caps the batch at 200", () => {
		expect(
			ListTediRuntimeMetaBySlugsInputSchema.safeParse({ slugs: [] }).success,
		).toBe(false);
		expect(
			ListTediRuntimeMetaBySlugsInputSchema.safeParse({
				slugs: Array.from({ length: 200 }, (_, i) => `t${i}`),
			}).success,
		).toBe(true);
		expect(
			ListTediRuntimeMetaBySlugsInputSchema.safeParse({
				slugs: Array.from({ length: 201 }, (_, i) => `t${i}`),
			}).success,
		).toBe(false);
	});

	it("rejects empty-string slugs", () => {
		expect(
			ListTediRuntimeMetaBySlugsInputSchema.safeParse({ slugs: [""] }).success,
		).toBe(false);
	});

	it("wraps rows under `data`", () => {
		const parsed = ListTediRuntimeMetaBySlugsResponseSchema.parse({
			data: [
				{
					slug: "cto",
					id: "id-cto",
					organizationId: "org-1",
					runtimeKind: "agent",
					runtimeState: "active",
					status: null,
				},
			],
		});
		expect(parsed.data).toHaveLength(1);
	});
});

it("session preservation verbs are strict, positive epoch and purpose-separated", async () => {
	const { TediRuntimeCutoverOperationQuerySchema } = await import("./tedi");
	const base = {
		routeTediId: "00000000-0000-4000-8000-000000000001",
		custodyTediId: "00000000-0000-4000-8000-000000000001",
		objectId: "a".repeat(64),
		operationId: "original",
		expectedGeneration: 1,
	};
	for (const command of [
		"inspect_session_preservation",
		"capture_session_preservation",
		"audit_session_preservation",
		"inspect_session_rehydration",
	] as const) {
		const q = {
			...base,
			command,
			...(command === "inspect_session_preservation"
				? {}
				: { archiveId: "00000000-0000-4000-8000-000000000002" }),
			...(command === "capture_session_preservation"
				? { proof: "opaque" }
				: {}),
		};
		expect(TediRuntimeCutoverOperationQuerySchema.parse(q).command).toBe(
			command,
		);
		for (const extra of [
			{ expectedGeneration: 0 },
			{ sourceHash: "b".repeat(64) },
			{ expectedHash: "c".repeat(64) },
			{ candidateObjectNames: ["other"] },
			{ proof: "x".repeat(131073) },
		])
			expect(() =>
				TediRuntimeCutoverOperationQuerySchema.parse({ ...q, ...extra }),
			).toThrow();
	}
});

it("SDK preservation verbs are strict, positive epoch and purpose-separated", async () => {
	const { TediRuntimeCutoverOperationQuerySchema } = await import("./tedi");
	const base = {
		routeTediId: "00000000-0000-4000-8000-000000000001",
		custodyTediId: "00000000-0000-4000-8000-000000000001",
		objectId: "a".repeat(64),
		operationId: "original",
		expectedGeneration: 1,
	};
	for (const command of [
		"inspect_sdk_preservation",
		"capture_sdk_preservation",
		"audit_sdk_preservation",
	] as const) {
		const q = {
			...base,
			command,
			...(command === "inspect_sdk_preservation"
				? {}
				: { archiveId: "00000000-0000-4000-8000-000000000002" }),
			...(command === "capture_sdk_preservation" ? { proof: "opaque" } : {}),
		};
		expect(TediRuntimeCutoverOperationQuerySchema.parse(q).command).toBe(
			command,
		);
		for (const extra of [
			{ expectedGeneration: 0 },
			{ sourceHash: "b".repeat(64) },
			{ expectedHash: "c".repeat(64) },
			{ candidateObjectNames: ["other"] },
			{ proof: "x".repeat(131073) },
		])
			expect(() =>
				TediRuntimeCutoverOperationQuerySchema.parse({ ...q, ...extra }),
			).toThrow();
	}
});

it("qualifier v2 requires complete rows and truthful independent overflow witnesses", async () => {
	const {
		TediRuntimeSessionRehydrationResponseSchema,
		SessionPreservationTableNames,
	} = await import("./tedi");
	const absent = {
		status: "absent",
		reason: null,
		sessions: 0,
		messages: 0,
		branches: 0,
		compactions: 0,
		attachments: 0,
	};
	const unavailable = {
		...absent,
		status: "unavailable",
		reason: "unsupported_schema",
	};
	const budget = {
		policy: "session-semantic-stream-v2",
		sourceBytes: 300,
		selectedRows: 1,
		processedRows: 1,
		workUnits: 100,
		scanBytes: 600,
		retainedBytes: 100,
		exhausted: null,
		attemptedCharge: null,
		clockExpired: false,
		retainedAtFailure: null,
	};
	const archive = {
		format: "session-state-archive-v1",
		archiveId: "00000000-0000-4000-8000-000000000005",
		selectorVersion: "a".repeat(64),
		metadata: {
			tables: SessionPreservationTableNames.map((table, i) => ({
				table,
				present: i === 0,
				rows: i === 0 ? 1 : 0,
				schema: i === 0 ? "unknown" : "absent",
			})),
			sourceBytes: 300,
			recordCount: 30,
			localOwnerUnknown: true,
		},
		metadataDigest: "b".repeat(64),
		projectionDigest: null,
		priorArchives: { historical: "absent", native: "absent" },
	};
	const qualification = {
		schemaVersion: 2,
		budget,
		scope: "archived_selected_session8",
		archiveAuthenticated: true,
		parentLocal: unavailable,
		sdk7: absent,
		canonicalLedgerCorrespondence: "not_queried",
		adoptionReady: false,
		executionEligible: false,
	};
	const response = {
		ok: true,
		id: "c".repeat(64),
		targetObjectId: "c".repeat(64),
		operationId: "qualify",
		generation: 1,
		state: "quarantined",
		receiver: "raw-cutover-v1",
		command: "inspect_session_rehydration",
		archive,
		qualification,
	};
	expect(
		TediRuntimeSessionRehydrationResponseSchema.safeParse(response).success,
	).toBe(true);
	for (const mutation of [
		{ schemaVersion: 1 },
		{ budget: { ...budget, processedRows: 0 } },
		{ budget: { ...budget, workUnits: 0 } },
		{ budget: { ...budget, scanBytes: 299 } },
		{ budget: { ...budget, selectedRows: 0 } },
		{ budget: { ...budget, privateHash: "PRIVATE" } },
	])
		expect(
			TediRuntimeSessionRehydrationResponseSchema.safeParse({
				...response,
				qualification: { ...qualification, ...mutation },
			}).success,
		).toBe(false);
	const exhausted = { ...unavailable, reason: "budget_unavailable" };
	const overflow = {
		...qualification,
		parentLocal: exhausted,
		sdk7: exhausted,
		budget: {
			...budget,
			workUnits: 199999,
			exhausted: "semantic_work",
			attemptedCharge: 2,
		},
	};
	expect(
		TediRuntimeSessionRehydrationResponseSchema.safeParse({
			...response,
			qualification: overflow,
		}).success,
	).toBe(true);
	for (const mutation of [
		{ attemptedCharge: 1 },
		{ attemptedCharge: null },
		{ clockExpired: true },
		{ retainedAtFailure: 1 },
	])
		expect(
			TediRuntimeSessionRehydrationResponseSchema.safeParse({
				...response,
				qualification: {
					...overflow,
					budget: { ...overflow.budget, ...mutation },
				},
			}).success,
		).toBe(false);
});

it("custody coverage is strict metadata-only with positive original custody", async () => {
	const {
		TediRuntimeCutoverOperationQuerySchema,
		TediRuntimeCustodyCoverageResponseSchema,
	} = await import("./tedi");
	const id = "a".repeat(64),
		h = "b".repeat(64),
		tedi = "00000000-0000-4000-8000-000000000001";
	const query = {
		routeTediId: tedi,
		custodyTediId: tedi,
		objectId: id,
		operationId: "fixture",
		expectedGeneration: 1,
		command: "inspect_custody_coverage",
	};
	expect(TediRuntimeCutoverOperationQuerySchema.safeParse(query).success).toBe(
		true,
	);
	for (const change of [
		{ expectedGeneration: 0 },
		{ continuation: "opaque" },
		{ coverageHash: h },
		{ archiveId: tedi },
		{ proof: "x" },
		{ command: "inspect_whole_custody" },
	])
		expect(
			TediRuntimeCutoverOperationQuerySchema.safeParse({ ...query, ...change })
				.success,
		).toBe(false);
	expect(
		TediRuntimeCutoverOperationQuerySchema.safeParse({
			...query,
			coverageHash: h,
			continuation: "opaque",
		}).success,
	).toBe(true);
	const valid = {
		ok: true,
		id,
		targetObjectId: id,
		operationId: "fixture",
		generation: 1,
		state: "quarantined",
		receiver: "raw-cutover-v1",
		command: "inspect_custody_coverage",
		version: "custody-coverage-metadata-v1",
		coverageHash: h,
		sqlMetadataHash: h,
		registryHash: h,
		issuedAt: 1,
		expiresAt: 300001,
		sqlObjects: 0,
		registeredTargets: 0,
		offset: 0,
		items: [],
		continuation: null,
		metadataEnumerationComplete: true,
		kv: {
			status: "unsupported_metadata_only_enumeration_unavailable",
			enumeration: "not_queried",
			complete: false,
			keyCount: null,
			keyIdentityHash: null,
			valueCoverage: "not_queried",
			payloadAuthenticity: "not_queried",
		},
		alarm: "UNKNOWN",
		remoteEffects: "not_queried",
		writerExclusionAck: "UNKNOWN",
		wholeContentPreserved: false,
		wholePreservationReady: false,
		adoptionReady: false,
		executionEligible: false,
		financialClearance: false,
	};
	expect(
		TediRuntimeCustodyCoverageResponseSchema.safeParse(valid).success,
	).toBe(true);
	const registry = {
		domain: "registry",
		className: "ConversationFacet",
		name: "fictional",
		identityVersion: "path-v2",
		identityName: "fictional-native",
		objectId: id,
		parentGeneration: 1,
		registryMetadataHash: h,
		routingCustody: "not_queried",
		disposition: "registered_not_visited",
		childGeneration: null,
		localOwner: "UNKNOWN",
	};
	const registryPage = { ...valid, registeredTargets: 1, items: [registry] };
	expect(
		TediRuntimeCustodyCoverageResponseSchema.safeParse(registryPage).success,
	).toBe(true);
	for (const change of [
		{ registryHash: h },
		{ registryMetadataHash: "c".repeat(64) },
		{ routingCustody: "observed" },
		{ localOwner: "observed" },
	])
		expect(
			TediRuntimeCustodyCoverageResponseSchema.safeParse({
				...registryPage,
				items: [{ ...registry, ...change }],
			}).success,
		).toBe(false);

	for (const field of [
		"wholeContentPreserved",
		"wholePreservationReady",
		"adoptionReady",
		"executionEligible",
		"financialClearance",
	])
		expect(
			TediRuntimeCustodyCoverageResponseSchema.safeParse({
				...valid,
				[field]: true,
			}).success,
		).toBe(false);
	for (const change of [
		{ writerExclusionAck: "observed" },
		{ kv: { ...valid.kv, keyCount: 0 } },
		{ sqlObjects: 1 },
		{ expiresAt: 300002 },
		{ state: "active" },
		{ metadataEnumerationComplete: false },
		{ DDL: "PRIVATE" },
	])
		expect(
			TediRuntimeCustodyCoverageResponseSchema.safeParse({
				...valid,
				...change,
			}).success,
		).toBe(false);
});
