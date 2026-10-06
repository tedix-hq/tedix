import assert from "node:assert/strict";
import { isAdminAuthorized } from "./admin-agent-diag";
import { secureEqual } from "@tedix/worker-kit/request-auth";
const testRuntime: string = "bun:test";
const { mock } = await import(testRuntime);
mock.module("agents/harness/pi", () => ({
	openPiSessionStore: () => {
		throw new Error("unexpected native construction");
	},
}));
const { cutoverInventoryPageQuery, cutoverRejectionCode } =
	await import("./pi-cutover-admin");
assert.deepEqual(cutoverInventoryPageQuery(new URLSearchParams()), {
	offset: 0,
	limit: 200,
});
const hash = "a".repeat(64);
assert.deepEqual(
	cutoverInventoryPageQuery(
		new URLSearchParams({
			offset: "200",
			limit: "2",
			expectedHash: hash,
			expectedInspectionHash: hash,
		}),
	),
	{ offset: 200, limit: 2, expectedHash: hash, expectedInspectionHash: hash },
);
for (const query of [
	"offset=1",
	"offset=1&expectedHash=" + hash,
	"expectedInspectionHash=PRIVATE",
	"limit=201",
	"limit=0",
	"offset=-1",
	"offset=01",
	"offset=9007199254740992",
	"limit=1&limit=2",
	"expectedHash=PRIVATE",
])
	assert.throws(
		() => cutoverInventoryPageQuery(new URLSearchParams(query)),
		/Invalid cutover page/,
	);
const token = "cutover-unit-token";
assert.equal(await secureEqual("wrong", token), false);
assert.equal(await secureEqual(token, undefined), false);
assert.equal(await secureEqual(token, token), true);
assert.equal(
	await isAdminAuthorized({
		request: new Request("https://fixture/__admin/pi-state-cutover"),
		masterKey: token,
	}),
	false,
);
assert.equal(
	await isAdminAuthorized({
		request: new Request("https://fixture/__admin/pi-state-cutover", {
			headers: { "X-Tedix-Admin-Token": token },
		}),
		masterKey: token,
	}),
	true,
);
console.log("Cutover explicit token and admin request authorization passed");
const { parseCutoverOperation, routeCutoverInventory, operateStoredCutover } =
	await import("./pi-cutover-admin");
const objectId = "b".repeat(64);
const quarantine = {
	command: "quarantine",
	objectId,
	operationId: "operator",
	expectedGeneration: 0,
	reasonCode: "unknown_owner",
	custody: null,
};
assert.equal((await parseCutoverOperation(quarantine)).custody, null);
for (const extra of [
	{ verified: true },
	{ custodyTediId: "00000000-0000-4000-8000-000000000002" },
	{ routeTediId: "00000000-0000-4000-8000-000000000002" },
])
	await assert.rejects(parseCutoverOperation({ ...quarantine, ...extra }));
await assert.rejects(
	parseCutoverOperation({
		...quarantine,
		command: "apply",
		sourceHash: hash,
		expectedGeneration: 1,
	}),
);
let gets = 0;
const namespace = {
	idFromString: () => {
		throw new Error("No lookup before authorization");
	},
	idFromName: () => {
		throw new Error("No lookup before authorization");
	},
	get: () => {
		gets++;
		throw new Error("unexpected get");
	},
} as unknown as DurableObjectNamespace;
assert.equal(
	(
		await routeCutoverInventory({
			request: new Request("https://fixture/__admin/pi-state-cutover", {
				method: "POST",
				body: JSON.stringify(quarantine),
			}),
			masterKey: token,
			knownIds: JSON.stringify([objectId]),
			namespace,
		})
	)?.status,
	403,
);
assert.equal(
	(
		await routeCutoverInventory({
			request: new Request("https://fixture/__admin/pi-state-cutover", {
				method: "POST",
				headers: { "X-Tedix-Admin-Token": token },
				body: JSON.stringify({ ...quarantine, objectId: "c".repeat(64) }),
			}),
			masterKey: token,
			knownIds: JSON.stringify([objectId]),
			namespace,
		})
	)?.status,
	404,
);
assert.equal(
	(
		await routeCutoverInventory({
			request: new Request("https://fixture/__admin/pi-state-cutover", {
				method: "POST",
				headers: { "X-Tedix-Admin-Token": token },
				body: JSON.stringify({ ...quarantine, verified: true }),
			}),
			masterKey: token,
			knownIds: JSON.stringify([objectId]),
			namespace,
		})
	)?.status,
	400,
);
assert.equal(gets, 0);
const untouched = {
	blockConcurrencyWhile: () => {
		throw new Error("unauthenticated gate");
	},
} as unknown as DurableObjectState;
assert.equal(
	(
		await operateStoredCutover({
			ctx: untouched,
			env: { SECRETS_MASTER_KEY: token } as Cloudflare.Env,
			request: new Request("https://fixture/__admin/pi-state-cutover", {
				method: "POST",
				body: "PRIVATE",
			}),
		})
	).status,
	403,
);
console.log(
	"Strict cutover operations reject spoofed custody and deny before object lookup",
);
const custody = {
	tediId: "00000000-0000-4000-8000-000000000002",
	orgId: "00000000-0000-4000-8000-000000000003",
	objectName: "canonical-fixture",
};
const canonicalNamespace = {
	idFromName: () => ({ toString: () => objectId }),
	idFromString: () => ({ toString: () => objectId }),
	get: () => {
		gets++;
		throw new Error("Canonical mismatch must not get");
	},
} as unknown as DurableObjectNamespace;
const wrongOwnerDb = {
	prepare: (sql: string) => ({
		bind: () => ({
			first: async () =>
				sql.includes("SELECT isolate_agent_id")
					? { isolateAgentId: custody.objectName }
					: { id: custody.tediId, orgId: "different-org" },
		}),
	}),
};
const deniedOwner = await routeCutoverInventory({
	request: new Request("https://fixture/__admin/pi-state-cutover", {
		method: "POST",
		headers: { "X-Tedix-Admin-Token": token },
		body: JSON.stringify({ ...quarantine, custody }),
	}),
	masterKey: token,
	knownIds: JSON.stringify([objectId]),
	namespace: canonicalNamespace,
	env: { DB: wrongOwnerDb } as unknown as Cloudflare.Env,
});
assert.equal(deniedOwner?.status, 409);
assert.equal(gets, 0);
assert.ok(!(await deniedOwner!.text()).includes(custody.objectName));

assert.equal(
	cutoverRejectionCode(
		new Error("Runtime admission storage: nonterminal or unknown SDK work"),
	),
	"nonterminal_sdk_work",
);
assert.equal(
	cutoverRejectionCode(new Error("secret-provider-data")),
	"verification_rejected",
);
assert.equal(cutoverRejectionCode(null), "verification_rejected");

assert.equal(
	cutoverRejectionCode(
		new Error("Transcript cutover: invalid compaction span"),
	),
	"invalid_compaction_span",
);
assert.equal(
	cutoverRejectionCode(
		new Error(
			"Transcript cutover: empty transcript is not a verified empty root",
		),
	),
	"empty_transcript_is_not_a_verified_empty_root",
);
assert.equal(
	cutoverRejectionCode(
		new Error(
			"Transcript cutover: unsupported private-role part secret-content",
		),
	),
	"transcript_validation",
);

const { inspectionQuery } = await import("./pi-cutover-admin");
assert.deepEqual(inspectionQuery(new URLSearchParams()), {
	path: [],
	custodyTediId: undefined,
	expectedGeneration: undefined,
});
for (const query of [
	"targetPath={}",
	"targetPath=[]&targetPath=[]",
	"expectedGeneration=-1",
	"expectedGeneration=01",
	"expectedGeneration=1&expectedGeneration=2",
	"custodyTediId=private",
])
	assert.throws(() => inspectionQuery(new URLSearchParams(query)));
assert.equal(
	cutoverRejectionCode(
		new Error("Transcript cutover: conflicting tool result"),
	),
	"conflicting_tool_result",
);

const { CutoverInspectionHopSchema } =
	await import("@tedix/api-contract/schemas/tedi");
const registeredHop = {
	className: "Researcher",
	name: "research",
	identityVersion: "path-v2",
	identityName: "registered",
	objectId,
	registryHash: hash,
	parentGeneration: 0,
};
assert.equal(
	CutoverInspectionHopSchema.safeParse({ ...registeredHop, identityName: null })
		.success,
	false,
);
assert.equal(
	CutoverInspectionHopSchema.safeParse({
		...registeredHop,
		identityVersion: null,
	}).success,
	false,
);
assert.equal(
	CutoverInspectionHopSchema.safeParse({
		...registeredHop,
		identityVersion: null,
		identityName: null,
	}).success,
	true,
);

const rootExclusion = {
	command: "exclude_writers",
	objectId,
	operationId: "exclude",
	expectedGeneration: 2,
	custody: {
		tediId: "11111111-1111-4111-8111-111111111111",
		orgId: "22222222-2222-4222-8222-222222222222",
		objectName: "canonical-root",
	},
};
assert.equal(
	(await parseCutoverOperation(rootExclusion)).query.command,
	"exclude_writers",
);
for (const extra of [
	{ expectedGeneration: 0 },
	{ custody: null },
	{ targetPath: [] },
	{ target: {} },
	{ sourceHash: hash },
	{ candidateObjectNames: [] },
])
	await assert.rejects(() =>
		parseCutoverOperation({ ...rootExclusion, ...extra }),
	);
console.log(
	"Root exclusion strict input denies unknown custody and nested targets",
);
const captureDiagnostic = {
	...rootExclusion,
	command: "inspect_capture_size",
	expectedGeneration: 0,
};
assert.equal(
	(await parseCutoverOperation(captureDiagnostic)).query.command,
	"inspect_capture_size",
);
for (const extra of [
	{ targetPath: [] },
	{ target: {} },
	{ sourceHash: hash },
	{ custody: null },
	{ expectedGeneration: -1 },
	{ unknown: "PRIVATE" },
])
	await assert.rejects(() =>
		parseCutoverOperation({ ...captureDiagnostic, ...extra }),
	);
const { TediRuntimeCutoverOperationResponseSchema } =
	await import("@tedix/api-contract/schemas/tedi");
const diagnosticResponse = {
	ok: true,
	id: objectId,
	command: "inspect_capture_size",
	operationId: "capture",
	generation: 1,
	state: "retired",
	selectorVersion: hash,
	observation: "read_window_not_atomic_snapshot",
	sampledAt: new Date().toISOString(),
	complete: true,
	sql: [],
	kv: { entries: 0, canonicalItemBytes: 0 },
};
assert.equal(
	TediRuntimeCutoverOperationResponseSchema.safeParse(diagnosticResponse)
		.success,
	true,
);
assert.equal(
	TediRuntimeCutoverOperationResponseSchema.safeParse({
		...diagnosticResponse,
		command: "plan",
	}).success,
	false,
);
assert.equal(
	TediRuntimeCutoverOperationResponseSchema.safeParse({
		...diagnosticResponse,
		sourceHash: hash,
	}).success,
	false,
);

for (const command of [
	"inspect_historical_custody",
	"capture_historical_custody",
	"audit_historical_custody",
] as const) {
	const query = {
		...rootExclusion,
		command,
		...(command === "inspect_historical_custody"
			? {}
			: { expectedSourceHash: hash }),
	};
	assert.equal((await parseCutoverOperation(query)).query.command, command);
	for (const extra of [
		{ expectedGeneration: 0 },
		{ custody: null },
		{ target: {} },
		{ targetPath: [] },
		{ candidateObjectNames: [] },
		{ sourceHash: hash },
		{ continuation: "private" },
		{ reasonCode: "operator_hold" },
		{ verificationAction: "hold" },
		{ unknown: "PRIVATE" },
	])
		await assert.rejects(() => parseCutoverOperation({ ...query, ...extra }));
	if (command !== "inspect_historical_custody")
		await assert.rejects(() =>
			parseCutoverOperation({ ...query, expectedSourceHash: undefined }),
		);
	else
		await assert.rejects(() =>
			parseCutoverOperation({ ...query, expectedSourceHash: hash }),
		);
	const response = {
		ok: true,
		id: objectId,
		command,
		operationId: "historical",
		generation: 1,
		state: "quarantined",
		receiver: "raw-cutover-v1",
		snapshotId: hash,
		sourceHash: hash,
		workflowCount: 1,
		fiberCount: 1,
		identityCount: 4,
	};
	assert(TediRuntimeCutoverOperationResponseSchema.safeParse(response).success);
	assert(
		TediRuntimeCutoverOperationResponseSchema.safeParse({
			...response,
			targetObjectId: objectId,
		}).success,
	);
	for (const extra of [
		{ receiver: undefined },
		{ state: "active" },
		{ generation: 0 },
		{ privateFacts: {} },
		{ targetObjectId: "invalid" },
	])
		assert(
			!TediRuntimeCutoverOperationResponseSchema.safeParse({
				...response,
				...extra,
			}).success,
		);
}
console.log(
	"Historical custody commands require strict inputs and scalar nonactive Raw outputs with valid physical leaf IDs",
);

// The observer sees actual SyncKvStorage semantics, including stored undefined.
const {
	captureCutoverQualification,
	QUALIFICATION_MAX_ROWS,
	QUALIFICATION_MAX_BYTES,
} = await import("./pi-cutover-admin");
function observerStorage(values: Map<string, unknown>) {
	let yielded = 0;
	const sorted = [...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const storage = {
		sql: {
			exec: (query: string) => ({
				toArray: () =>
					query.includes("COUNT(*)") ? [{ rows: 0, bytes: 0 }] : [],
			}),
		},
		kv: {
			get: (key: string) => values.get(key),
			list: function* (
				options: {
					prefix?: string;
					start?: string;
					end?: string;
					startAfter?: string;
					limit?: number;
				} = {},
			) {
				let count = 0;
				let low = 0,
					high = sorted.length;
				const from = options.startAfter ?? options.start ?? options.prefix;
				if (from !== undefined) {
					while (low < high) {
						const mid = Math.floor((low + high) / 2);
						if (
							sorted[mid]![0] < from ||
							(options.startAfter !== undefined && sorted[mid]![0] === from)
						)
							low = mid + 1;
						else high = mid;
					}
				}
				for (let index = low; index < sorted.length; index++) {
					const [key, value] = sorted[index]!;
					if (
						(options.prefix && !key.startsWith(options.prefix)) ||
						(options.start && key < options.start) ||
						(options.end && key >= options.end) ||
						(options.startAfter && key <= options.startAfter)
					)
						continue;
					if (count++ >= (options.limit ?? Infinity)) break;
					yielded++;
					yield [key, value] as [string, unknown];
				}
			},
		},
	} as unknown as DurableObjectStorage;
	return { storage, yielded: () => yielded };
}
const checkpoint = (phase: string) => ({
	version: 1,
	runId: "unit",
	fault: null,
	attempts: [
		{
			id: "attempt",
			estimatedTokens: 1,
			phase,
			acknowledged: phase === "completed",
			effectsStarted: false,
			usage:
				phase === "completed"
					? { inputTokens: null, outputTokens: null, totalTokens: null }
					: null,
		},
	],
});
for (const phase of ["prepared", "started", "completed", "unknown"]) {
	const { storage } = observerStorage(
		new Map([["pi-accounting:unit", checkpoint(phase)]]),
	);
	const q = captureCutoverQualification(storage).projection,
		row = q.rows[0]!;
	assert.equal(q.nativeSchemaState, "absent");
	assert.equal(row.structuralState, "known");
	assert.equal(row.phaseCounts[phase as keyof typeof row.phaseCounts], 1);
	assert.equal(
		row.completionValidation,
		phase === "completed" ? "passed" : "not_passed",
	);
	if (phase === "completed")
		assert.deepEqual(row.usageNullCounts, {
			inputTokens: 1,
			outputTokens: 1,
			totalTokens: 1,
		});
	assert.equal(JSON.stringify(q).includes('"unit"'), false);
}
const firstRaw = { status: "exhausted", payload: "PRIVATE_TEXT_A" },
	secondRaw = { status: "exhausted", payload: "PRIVATE_TEXT_B" };
const one = captureCutoverQualification(
	observerStorage(new Map([["cf:chat-recovery:incident:secret", firstRaw]]))
		.storage,
);
const two = captureCutoverQualification(
	observerStorage(new Map([["cf:chat-recovery:incident:secret", secondRaw]]))
		.storage,
);
assert.deepEqual(one.projection, two.projection);
assert.notEqual(one.privateSnapshot, two.privateSnapshot);
assert(!JSON.stringify(one.projection).includes("PRIVATE_TEXT"));
assert(!JSON.stringify(one.projection).includes("secret"));
for (const value of [
	Object.setPrototypeOf([], {}),
	new Date(),
	new Map(),
	new Set(),
	new Uint8Array([1]),
	NaN,
	{ toJSON: () => "PRIVATE" },
])
	assert.throws(
		() =>
			captureCutoverQualification(
				observerStorage(new Map([["pi-ui-entry:1", value]])).storage,
			),
		/Qualification capture unavailable/,
	);
const accessor = {};
let invoked = false;
Object.defineProperty(accessor, "payload", {
	enumerable: true,
	get() {
		invoked = true;
		return "PRIVATE";
	},
});
assert.throws(() =>
	captureCutoverQualification(
		observerStorage(new Map([["pi-ui-entry:1", accessor]])).storage,
	),
);
assert.equal(invoked, false);
const typed = [undefined, null, 0, -0, [], {}, { missing: undefined }].map(
	(v) =>
		captureCutoverQualification(
			observerStorage(new Map([["pi-ui-entry:1", v]])).storage,
		).privateSnapshot,
);
assert.equal(new Set(typed).size, typed.length);
const twins = new Map(
	Array.from(
		{ length: 201 },
		(_, i) =>
			[
				`pi-ui-entry:${String(i).padStart(6, "0")}`,
				{ unsupported: "PRIVATE" },
			] as [string, unknown],
	),
);
const twinObservation = captureCutoverQualification(
	observerStorage(twins).storage,
).projection;
assert.equal(twinObservation.journalCount, 201);
assert.deepEqual(
	twinObservation.rows.map((r) => r.ordinal),
	Array.from({ length: 201 }, (_, i) => i),
);
assert(
	twinObservation.rows.every(
		(r) => r.identityHash === null && r.projectionHash === null,
	),
);
const atLimit = new Map(
	Array.from(
		{
			length:
				QUALIFICATION_MAX_ROWS -
				captureCutoverQualification(observerStorage(new Map()).storage)
					.privateRows,
		},
		(_, i) => [`pi-ui-entry:${i}`, null] as [string, unknown],
	),
);
assert.equal(
	captureCutoverQualification(observerStorage(atLimit).storage).privateRows,
	QUALIFICATION_MAX_ROWS,
);
atLimit.set("pi-ui-entry:extra", null);
const over = observerStorage(atLimit);
assert.throws(
	() => captureCutoverQualification(over.storage),
	/Qualification capture unavailable/,
);
assert.equal(over.yielded(), atLimit.size);
assert.throws(
	() =>
		captureCutoverQualification(
			observerStorage(
				new Map([["pi-ui-entry:big", "x".repeat(QUALIFICATION_MAX_BYTES)]]),
			).storage,
		),
	/Qualification capture unavailable/,
);
let deep: unknown = null;
for (let i = 0; i < 65; i++) deep = { deep };
assert.throws(() =>
	captureCutoverQualification(
		observerStorage(new Map([["pi-ui-entry:deep", deep]])).storage,
	),
);
console.log(
	"Strict v2 projection privacy, incomplete accounting, typed capture and bounded unknown rows passed",
);

const custodyLimit = new Map(atLimit);
custodyLimit.delete("pi-ui-entry:extra");
custodyLimit.set("__ps_name", "physical");
assert.throws(
	() => captureCutoverQualification(observerStorage(custodyLimit).storage),
	/Qualification capture unavailable/,
);

// Exact encoded-byte boundary includes all metadata frames and SQL/KV overhead.
let boundaryLength = QUALIFICATION_MAX_BYTES - 4096;
let boundary = captureCutoverQualification(
	observerStorage(new Map([["pi-ui-entry:bytes", "x".repeat(boundaryLength)]]))
		.storage,
);
boundaryLength += QUALIFICATION_MAX_BYTES - boundary.privateBytes;
boundary = captureCutoverQualification(
	observerStorage(new Map([["pi-ui-entry:bytes", "x".repeat(boundaryLength)]]))
		.storage,
);
assert.equal(boundary.privateBytes, QUALIFICATION_MAX_BYTES);
assert.throws(
	() =>
		captureCutoverQualification(
			observerStorage(
				new Map([["pi-ui-entry:bytes", "x".repeat(boundaryLength + 1)]]),
			).storage,
		),
	/Qualification capture unavailable/,
);

let schemaPayloadReads = 0;
const hugeSchema = observerStorage(new Map()).storage;
Object.assign(hugeSchema, {
	sql: {
		exec(query: string) {
			if (query.includes("COUNT(*)") && query.includes("sqlite_master"))
				return {
					toArray: () => [{ rows: 1, bytes: QUALIFICATION_MAX_BYTES + 1 }],
				};
			schemaPayloadReads++;
			return { toArray: () => [] };
		},
	},
});
assert.throws(
	() => captureCutoverQualification(hugeSchema),
	/Qualification capture unavailable/,
);
assert.equal(schemaPayloadReads, 0);

for (const stage of [
	"accepted",
	"answered",
	"sending",
	"completed",
	"uncertain",
]) {
	const telegram = {
		version: 1,
		operation: {},
		claim: null,
		turn: {},
		thread: {},
		stage,
		chunks: ["PRIVATE_CHUNK"],
		nextChunk: 0,
		messageIds: [],
	};
	const q = captureCutoverQualification(
		observerStorage(new Map([["tedix:pi:telegram:reply:original", telegram]]))
			.storage,
	).projection;
	assert.equal(q.rows[0]!.structuralState, "known");
	assert.equal(q.rows[0]!.observedState, stage);
	assert.equal(q.rows[0]!.completionValidation, "not_passed");
	assert(!JSON.stringify(q).includes("PRIVATE_CHUNK"));
}
const futureAccounting = { ...checkpoint("started"), future: "PRIVATE" };
assert.equal(
	captureCutoverQualification(
		observerStorage(new Map([["pi-accounting:unit", futureAccounting]]))
			.storage,
	).projection.rows[0]!.structuralState,
	"unsupported",
);

for (const command of [
	"inspect_native_preservation",
	"capture_native_preservation",
	"audit_native_preservation",
] as const) {
	const base = {
		...rootExclusion,
		command,
		operationId: "native",
		...(command === "inspect_native_preservation"
			? {}
			: { archiveId: "00000000-0000-4000-8000-000000000005" }),
		...(command === "capture_native_preservation" ? { proof: "opaque" } : {}),
	};
	assert.equal((await parseCutoverOperation(base)).query.command, command);
	for (const extra of [
		{ expectedGeneration: 0 },
		{ custody: null },
		{ expectedHash: hash },
		{ expectedInspectionHash: hash },
		{ candidateObjectNames: ["canonical-root"] },
		{ routeTediId: "11111111-1111-4111-8111-111111111111" },
	])
		await assert.rejects(parseCutoverOperation({ ...base, ...extra }));
}

for (const command of [
	"inspect_session_preservation",
	"capture_session_preservation",
	"audit_session_preservation",
	"inspect_session_rehydration",
] as const) {
	const base = {
		...rootExclusion,
		command,
		operationId: "native",
		...(command === "inspect_session_preservation"
			? {}
			: { archiveId: "00000000-0000-4000-8000-000000000005" }),
		...(command === "capture_session_preservation" ? { proof: "opaque" } : {}),
	};
	assert.equal((await parseCutoverOperation(base)).query.command, command);
	for (const extra of [
		{ expectedGeneration: 0 },
		{ custody: null },
		{ expectedHash: hash },
		{ expectedInspectionHash: hash },
		{ candidateObjectNames: ["canonical-root"] },
		{ routeTediId: "11111111-1111-4111-8111-111111111111" },
	])
		await assert.rejects(parseCutoverOperation({ ...base, ...extra }));
}

for (const command of [
	"inspect_sdk_preservation",
	"capture_sdk_preservation",
	"audit_sdk_preservation",
] as const) {
	const base = {
		...rootExclusion,
		command,
		operationId: "native",
		...(command === "inspect_sdk_preservation"
			? {}
			: { archiveId: "00000000-0000-4000-8000-000000000005" }),
		...(command === "capture_sdk_preservation" ? { proof: "opaque" } : {}),
	};
	assert.equal((await parseCutoverOperation(base)).query.command, command);
	for (const extra of [
		{ expectedGeneration: 0 },
		{ custody: null },
		{ expectedHash: hash },
		{ expectedInspectionHash: hash },
		{ candidateObjectNames: ["canonical-root"] },
		{ routeTediId: "11111111-1111-4111-8111-111111111111" },
	])
		await assert.rejects(parseCutoverOperation({ ...base, ...extra }));
}

// Pending auth/body promises settle under the original transport deadline without entering storage.
{
	const timer = globalThis.setTimeout,
		digest = crypto.subtle.digest;
	let bodyReads = 0;
	const delays: number[] = [];
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		delays.push(delay ?? 0);
		return timer(callback, 0, ...args);
	}) as typeof setTimeout;
	try {
		crypto.subtle.digest = (() =>
			new Promise<ArrayBuffer>(() => {})) as typeof crypto.subtle.digest;
		const request = new Request("https://fixture/__admin/pi-state-cutover", {
			method: "POST",
			headers: { "X-Tedix-Admin-Token": token },
			body: "{}",
		});
		Object.defineProperty(request, "clone", {
			value: () => {
				bodyReads++;
				throw new Error("body before auth");
			},
		});
		assert.equal(
			(
				await operateStoredCutover({
					ctx: untouched,
					env: { SECRETS_MASTER_KEY: token } as Cloudflare.Env,
					request,
				})
			).status,
			409,
		);
		assert.equal(bodyReads, 0);
		assert.equal(delays.length, 1);
		assert.ok(delays[0]! > 0 && delays[0]! <= 30000);
		crypto.subtle.digest = digest;
		delays.length = 0;
		const body = new Request("https://fixture/__admin/pi-state-cutover", {
			method: "POST",
			headers: { "X-Tedix-Admin-Token": token },
			body: "{}",
		});
		Object.defineProperty(body, "clone", {
			value: () => ({
				json: () => {
					bodyReads++;
					return new Promise(() => {});
				},
			}),
		});
		assert.equal(
			(
				await operateStoredCutover({
					ctx: untouched,
					env: { SECRETS_MASTER_KEY: token } as Cloudflare.Env,
					request: body,
				})
			).status,
			400,
		);
		assert.equal(bodyReads, 1);
		assert.equal(delays.length, 2);
		assert.ok(delays[1]! <= delays[0]!);
	} finally {
		crypto.subtle.digest = digest;
		globalThis.setTimeout = timer;
	}
	console.log(
		"Pending auth/body deadline: zero storage gate, auth-first and original remaining duration",
	);
}

{
	const { passiveRegisteredCutover } = await import("./pi-cutover-admin");
	const timer = globalThis.setTimeout;
	let gates = 0;
	const delays: number[] = [];
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		delays.push(delay ?? 0);
		return timer(callback, 0, ...args);
	}) as typeof setTimeout;
	const held = {
		blockConcurrencyWhile: () => {
			gates++;
			return new Promise(() => {});
		},
	} as unknown as DurableObjectState;
	const body = {
		...rootExclusion,
		command: "inspect_session_rehydration",
		archiveId: "00000000-0000-4000-8000-000000000005",
	};
	try {
		const result = await operateStoredCutover({
			ctx: held,
			env: { SECRETS_MASTER_KEY: token } as Cloudflare.Env,
			request: new Request("https://fixture/__admin/pi-state-cutover", {
				method: "POST",
				headers: { "X-Tedix-Admin-Token": token },
				body: JSON.stringify(body),
			}),
		});
		assert.equal(result.status, 409);
		assert.equal(gates, 1);
		const leaf = await passiveRegisteredCutover(
			held,
			{ SECRETS_MASTER_KEY: token } as Cloudflare.Env,
			{ token, body: JSON.stringify(body), custody: "{}", index: 1 },
		);
		assert.equal(leaf.status, 409);
		assert.equal(gates, 2);
		assert.ok(delays.every((delay) => delay > 0 && delay <= 30000));
	} finally {
		globalThis.setTimeout = timer;
	}
	console.log(
		"Root and registered pending qualification gates settle under original deadline",
	);
}

// Body evaluation may synchronously reject and expire the original deadline
// before the await wrapper enters. That rejection must already be observed.
{
	const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
	let clock = 0;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	Object.defineProperty(performance, "now", {
		configurable: true,
		value: () => clock,
	});
	try {
		const request = new Request("https://fixture/__admin/pi-state-cutover", {
			method: "POST",
			headers: { "X-Tedix-Admin-Token": token },
			body: "{}",
		});
		Object.defineProperty(request, "clone", {
			value: () => ({
				json: async () => {
					clock = 30001;
					throw new Error("private body rejection");
				},
			}),
		});
		const result = await operateStoredCutover({
			ctx: untouched,
			env: { SECRETS_MASTER_KEY: token } as Cloudflare.Env,
			request,
		});
		assert.equal(result.status, 400);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(unhandled, []);
	} finally {
		if (descriptor) Object.defineProperty(performance, "now", descriptor);
		else Reflect.deleteProperty(performance, "now");
		process.off("unhandledRejection", onUnhandled);
	}
}

// The actual qualifier import producer rejects synchronously after changing
// original custody. readChecked's first readGuard must not strand that rejection.
{
	let name = rootExclusion.custody.objectName,
		producerCalls = 0,
		writes = 0;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	const record = JSON.stringify({
		owner: { ...rootExclusion.custody, objectId },
		state: "quarantined",
		generation: 2,
		evidence: null,
		reason: "fixture",
	});
	const storage = {
		kv: { get: (key: string) => (key === "__ps_name" ? name : undefined) },
		sql: {
			exec(q: string, ...args: unknown[]) {
				if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(q)) writes++;
				const rows = q.startsWith("SELECT record FROM runtime_admission")
					? [{ record }]
					: q.includes("sqlite_master") &&
						  (q.includes("'runtime_admission'") ||
								args[0] === "runtime_admission")
						? [{ name: "runtime_admission" }]
						: [];
				return {
					toArray: () => rows,
					[Symbol.iterator]: () => rows[Symbol.iterator](),
				};
			},
		},
	} as unknown as DurableObjectStorage;
	process.on("unhandledRejection", onUnhandled);
	mock.module("./session-state-preservation", () => {
		producerCalls++;
		name = "changed-original-name";
		throw new Error("private import producer rejection");
	});
	try {
		const response = await operateStoredCutover({
			ctx: {
				id: {
					name: rootExclusion.custody.objectName,
					toString: () => objectId,
				},
				storage,
				blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
			} as unknown as DurableObjectState,
			env: {
				SECRETS_MASTER_KEY: token,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([objectId]),
				TEDI_AGENT: canonicalNamespace,
			} as Cloudflare.Env,
			receiver: "raw-cutover-v1",
			request: new Request("https://fixture/__admin/pi-state-cutover", {
				method: "POST",
				headers: { "X-Tedix-Admin-Token": token },
				body: JSON.stringify({
					...rootExclusion,
					command: "inspect_session_rehydration",
					archiveId: "00000000-0000-4000-8000-000000000005",
				}),
			}),
		});
		assert.equal(response.status, 409);
		assert.equal(producerCalls, 1);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(unhandled, []);
		assert.equal(writes, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		mock.restore();
	}
}
