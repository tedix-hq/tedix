import {
	TediRuntimeCutoverInventoryResponseSchema,
	CutoverQualificationTables,
	CutoverQualificationFamilies,
} from "@tedix/api-contract/schemas/tedi";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import type { BaseContext } from "../../orpc";
import {
	TediRuntimeCutoverOperationQuerySchema,
	TediRuntimeCutoverQuerySchema,
} from "@tedix/api-contract/schemas/tedi";
import {
	cutoverInventoryFromAdminFetch,
	inspectRuntimeCutoverProcedure,
	operateRuntimeCutoverProcedure,
} from "./cutover-inventory";

const { getTediById } = vi.hoisted(() => ({ getTediById: vi.fn() }));
vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById,
}));
const { getRetainedRuntimeRoot } = vi.hoisted(() => ({
	getRetainedRuntimeRoot: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedi-runtime-bootstrap", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/tedi-runtime-bootstrap")
	>()),
	getRetainedRuntimeRoot,
}));
const ROUTE_TEDI = "11111111-1111-4111-8111-111111111111";
const OBJECT = "a".repeat(64);
const HASH = "c".repeat(64);
const MASTER = "inventory-private-token";
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
const snapshot = {
	version: "pi-cutover-inspection-v2",
	qualification: emptyQualification,
	admission: null,
	sdkWork: [
		"cf_agents_fibers",
		"cf_agents_runs",
		"cf_agents_task_runs",
		"cf_agents_workflows",
		"cf_agents_facet_runs",
	].map((table) => ({ table, present: false, counts: {} })),
	maintenanceJournal: { count: 0, offset: 0, records: [] },
	sdkWorkflows: { present: false, count: 0, offset: 0, rows: [] },
	ok: true as const,
	id: OBJECT,
	sampledAt: "2026-10-04T12:00:00.000Z",
	hash: HASH,
	inspectionHash: HASH,
	targetsKnown: false,
	inspectionTargets: [],
	offset: 0,
	limit: 200,
	counts: {
		tables: 1,
		receipts: 1,
		privateImages: 1,
		children: 1,
		maintenance: 1,
	},
	nextOffset: null,
	inventory: {
		storedOwner: {
			tediId: "other-stored-tedi",
			orgId: "other-stored-org",
			slug: "other-stored-slug",
			sessionKey: null,
			unknown: false,
		},
		tables: [{ name: "cf_agents_state", rows: 1 }],
		imported: false,
		activeConversationId: null,
		receipts: [
			{
				id: "delivery",
				source: "kv",
				status: "send-intent",
				terminal: false,
				sha256: HASH,
			},
		],
		privateImages: [
			{
				key: "pi-image-projection:v1:image",
				tediId: "other-stored-tedi",
				orgId: "other-stored-org",
				scheme: "tedix-r2:",
				sha256: HASH,
			},
		],
		children: [
			{
				className: "ConversationFacet",
				name: "session",
				identityVersion: "path-v2",
				identityName: "recorded-path",
			},
		],
		maintenance: [
			{ taskId: "isolate-brain-digest", scheduleId: "prior", nextRunAt: 12345 },
		],
		blocked: true,
	},
};
const transport = vi.fn<typeof fetch>();
function context(overrides: Partial<BaseContext> = {}): BaseContext {
	return {
		authType: "user",
		organizationId: "anchor-org",
		db: {},
		headers: new Headers(),
		url: new URL("https://api.test/rpc/tedis/inspectRuntimeCutover"),
		env: {
			ENVIRONMENT: "production",
			SECRETS_MASTER_KEY: MASTER,
			TEDI_SERVICE: { fetch: transport },
		},
		user: {
			sub: "operator",
			roles: ["platform-admin"],
			permissions: [],
			aud: "test",
			dct: "tenant",
			exp: 2,
			iat: 1,
			iss: "test",
		},
		...overrides,
	} as unknown as BaseContext;
}
function client(ctx = context()) {
	return createRouterClient(
		{
			inspectRuntimeCutover: inspectRuntimeCutoverProcedure,
			operateRuntimeCutover: operateRuntimeCutoverProcedure,
		},
		{ context: ctx },
	);
}
const input = { routeTediId: ROUTE_TEDI, objectId: OBJECT };
beforeEach(() => {
	vi.clearAllMocks();
	getRetainedRuntimeRoot.mockResolvedValue(null);
	getTediById.mockResolvedValue({
		id: ROUTE_TEDI,
		organizationId: "anchor-org",
		slug: "transport-anchor",
	});
	transport.mockResolvedValue(Response.json(snapshot));
});

describe("temporary finite raw cutover inventory", () => {
	it("uses the tedi solely as an access and service-binding transport anchor", async () => {
		expect(await client().inspectRuntimeCutover(input)).toEqual(snapshot);
		expect(getTediById).toHaveBeenCalledWith(expect.anything(), ROUTE_TEDI);
		const [url, options] = transport.mock.calls[0]!;
		const parsed = new URL(String(url));
		expect(parsed.pathname).toBe("/__admin/pi-state-cutover");
		expect([...parsed.searchParams]).toEqual([
			["objectId", OBJECT],
			["offset", "0"],
			["limit", "200"],
		]);
		expect(options?.method).toBe("GET");
		expect(options?.body).toBeUndefined();
		expect(options?.headers).toMatchObject({
			"X-Tedix-Admin-Token": MASTER,
			"X-Service-Binding": "true",
			"X-Tedix-Host": "transport-anchor.tedi.tedix.dev",
		});
	});
	it("forwards exact candidate names as one safely encoded JSON query without returning them", async () => {
		const candidateObjectNames = [
			"synthetic-root-name",
			'quote"backslash\\unicode-☃?&=#',
			" exact-whitespace ",
		];
		expect(
			await client().inspectRuntimeCutover({ ...input, candidateObjectNames }),
		).toEqual(snapshot);
		const [url] = transport.mock.calls[0]!;
		const params = new URL(String(url)).searchParams;
		expect(params.get("objectId")).toBe(OBJECT);
		expect(JSON.parse(params.get("candidateObjectNames")!)).toEqual(
			candidateObjectNames,
		);
		expect([...params.keys()]).toEqual([
			"objectId",
			"offset",
			"limit",
			"candidateObjectNames",
		]);
		expect(JSON.stringify(snapshot)).not.toContain("synthetic-root-name");
	});
	it("accepts the finite candidate bounds and preserves an explicit empty candidate list", async () => {
		expect(
			TediRuntimeCutoverQuerySchema.safeParse({
				...input,
				candidateObjectNames: Array(100).fill("x".repeat(1024)),
			}).success,
		).toBe(true);
		expect(
			await client().inspectRuntimeCutover({
				...input,
				candidateObjectNames: [],
			}),
		).toEqual(snapshot);
		expect(
			new URL(String(transport.mock.calls[0]![0])).searchParams.get(
				"candidateObjectNames",
			),
		).toBe("[]");
	});
	it("rejects invalid candidate arrays before any runtime transport", async () => {
		for (const candidateObjectNames of [
			Array(101).fill("synthetic"),
			[""],
			["x".repeat(1025)],
			[123],
			null,
			"synthetic",
		]) {
			const invalid = { ...input, candidateObjectNames };
			expect(TediRuntimeCutoverQuerySchema.safeParse(invalid).success).toBe(
				false,
			);
			await expect(
				client().inspectRuntimeCutover(
					invalid as unknown as Parameters<
						ReturnType<typeof client>["inspectRuntimeCutover"]
					>[0],
				),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(transport).not.toHaveBeenCalled();
	});
	it("candidate names do not grant org-admin authority or relax exact response ID validation", async () => {
		const ctx = context();
		ctx.user = {
			...ctx.user!,
			roles: ["org-admin"],
			permissions: ["tedis:read"],
		};
		await expect(
			client(ctx).inspectRuntimeCutover({
				...input,
				candidateObjectNames: ["synthetic-root-name"],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(transport).not.toHaveBeenCalled();
		transport.mockResolvedValueOnce(
			Response.json({ ...snapshot, id: "b".repeat(64) }),
		);
		await expect(
			client().inspectRuntimeCutover({
				...input,
				candidateObjectNames: ["synthetic-root-name"],
			}),
		).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			message: "Runtime cutover inventory returned an unexpected payload",
		});
	});
	it.each(["org-admin", "owner"])(
		"denies %s without platform authority before transport",
		async (role) => {
			const ctx = context();
			ctx.user = {
				...ctx.user!,
				roles: [role],
				permissions: ["tedis:read", "tedis:manage"],
			};
			await expect(
				client(ctx).inspectRuntimeCutover(input),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(transport).not.toHaveBeenCalled();
			expect(getTediById).not.toHaveBeenCalled();
		},
	);
	it("denies tenant-only API keys and permits platform-scoped keys", async () => {
		const ctx = context({
			user: undefined,
			authType: "apikey",
			apiKey: {
				id: "key",
				scopes: ["mcp:tedis.admin"],
			} as BaseContext["apiKey"],
		});
		await expect(
			client(ctx).inspectRuntimeCutover(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(transport).not.toHaveBeenCalled();
		ctx.apiKey = { ...ctx.apiKey!, scopes: ["platform:admin"] };
		expect(await client(ctx).inspectRuntimeCutover(input)).toEqual(snapshot);
	});
	it("permits a platform-delegated service binding and rejects bare binding authority", async () => {
		const ctx = context({
			user: undefined,
			authType: "service-binding",
			organizationId: "system",
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Tedi-Scopes": "platform:admin",
			}),
		});
		expect(await client(ctx).inspectRuntimeCutover(input)).toEqual(snapshot);
		transport.mockClear();
		ctx.organizationId = "unrelated-org";
		ctx.headers.delete("X-Tedix-Tedi-Scopes");
		ctx.tediScopes = undefined;
		await expect(
			client(ctx).inspectRuntimeCutover(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(transport).not.toHaveBeenCalled();
	});
	it("rejects nonexistent anchors and missing internal transport without public fetch fallback", async () => {
		getTediById.mockResolvedValueOnce(null);
		await expect(client().inspectRuntimeCutover(input)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(transport).not.toHaveBeenCalled();
		const fallback = vi.spyOn(globalThis, "fetch");
		try {
			const ctx = context();
			ctx.env = {
				...ctx.env,
				TEDI_SERVICE: undefined,
			} as unknown as CloudflareEnv;
			await expect(
				client(ctx).inspectRuntimeCutover(input),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				message:
					"Runtime cutover inventory unavailable (transport service_binding_unavailable)",
			});
			expect(fallback).not.toHaveBeenCalled();
		} finally {
			fallback.mockRestore();
		}
	});
	it("accepts unknown stored ownership without inventing ownership from the anchor", () => {
		const response = structuredClone(snapshot);
		response.inventory.storedOwner = {
			tediId: null,
			orgId: null,
			slug: null,
			sessionKey: null,
			unknown: true,
		} as unknown as typeof response.inventory.storedOwner;
		expect(
			cutoverInventoryFromAdminFetch(
				{ ok: true, status: 200, json: response },
				OBJECT,
			),
		).toEqual(response);
	});
	it("rejects mismatched IDs and malformed, failed or secret-bearing transport results", () => {
		for (const response of [
			{ ok: true, status: 200, json: { ...snapshot, id: "b".repeat(64) } },
			{
				ok: true,
				status: 200,
				json: { ...snapshot, id: OBJECT.toUpperCase() },
			},
			{ ok: true, status: 200, json: {} },
			{ ok: false, status: 403, json: { error: "PRIVATE-RUNTIME-ERROR" } },
			{
				error: "PRIVATE-INTERNAL-HOST-AND-TOKEN",
				failure: "transport_failure" as const,
			},
		]) {
			try {
				cutoverInventoryFromAdminFetch(response, OBJECT);
				throw new Error("unexpected success");
			} catch (error) {
				expect(error).toMatchObject({ code: "BAD_GATEWAY" });
				expect(String(error)).not.toMatch(/PRIVATE/);
			}
		}
	});
	it("rejects unexpected fields at every metadata nesting layer", () => {
		const payloads = [
			{ ...snapshot, state: "PRIVATE" },
			{ ...snapshot, inventory: { ...snapshot.inventory, content: "PRIVATE" } },
			{
				...snapshot,
				inventory: {
					...snapshot.inventory,
					storedOwner: { ...snapshot.inventory.storedOwner, token: "PRIVATE" },
				},
			},
			{
				...snapshot,
				inventory: {
					...snapshot.inventory,
					tables: [{ ...snapshot.inventory.tables[0], payload: "PRIVATE" }],
				},
			},
			{
				...snapshot,
				inventory: {
					...snapshot.inventory,
					receipts: [{ ...snapshot.inventory.receipts[0], error: "PRIVATE" }],
				},
			},
			{
				...snapshot,
				inventory: {
					...snapshot.inventory,
					privateImages: [
						{
							...snapshot.inventory.privateImages[0],
							url: "tedix-r2://private-key",
						},
					],
				},
			},
			{
				...snapshot,
				inventory: {
					...snapshot.inventory,
					children: [
						{ ...snapshot.inventory.children[0], checkpoint: "PRIVATE" },
					],
				},
			},
			{
				...snapshot,
				inventory: {
					...snapshot.inventory,
					maintenance: [
						{ ...snapshot.inventory.maintenance[0], input: "PRIVATE" },
					],
				},
			},
		];
		for (const json of payloads)
			expect(() =>
				cutoverInventoryFromAdminFetch({ ok: true, status: 200, json }, OBJECT),
			).toThrow("unexpected payload");
	});
	it("rejects oversized or invalid metadata rather than returning a partial inventory", () => {
		for (const inventory of [
			{
				...snapshot.inventory,
				receipts: Array(1001).fill(snapshot.inventory.receipts[0]),
			},
			{
				...snapshot.inventory,
				children: [
					{ ...snapshot.inventory.children[0], name: "x".repeat(513) },
				],
			},
			{ ...snapshot.inventory, tables: [{ name: "table", rows: -1 }] },
			{
				...snapshot.inventory,
				privateImages: [
					{ ...snapshot.inventory.privateImages[0], scheme: "https://secret" },
				],
			},
		])
			expect(() =>
				cutoverInventoryFromAdminFetch(
					{ ok: true, status: 200, json: { ...snapshot, inventory } },
					OBJECT,
				),
			).toThrow("unexpected payload");
	});
	it("returns only bounded schema paths, codes and lengths without logging private payloads", async () => {
		const secret = "PRIVATE-token-content-https://private.example/metadata-id";
		const json = {
			...snapshot,
			[secret]: secret,
			inventory: {
				...snapshot.inventory,
				receipts: Array(1001).fill(snapshot.inventory.receipts[0]),
				children: [
					{
						...snapshot.inventory.children[0],
						identityName: secret.repeat(20),
					},
				],
				storedOwner: {
					...snapshot.inventory.storedOwner,
					sessionKey: secret.repeat(20),
				},
			},
		};
		const logs = [
			vi.spyOn(console, "log"),
			vi.spyOn(console, "warn"),
			vi.spyOn(console, "error"),
		];
		try {
			transport.mockResolvedValueOnce(Response.json(json));
			let error: unknown;
			try {
				await client().inspectRuntimeCutover(input);
			} catch (caught) {
				error = caught;
			}
			expect(error).toMatchObject({ code: "BAD_GATEWAY" });
			const message = (error as Error).message;
			expect(message).toContain("inventory.receipts:too_big length=1001");
			expect(message).toContain(
				"inventory.children.[0].identityName:too_big length=",
			);
			expect(message).toContain(
				"inventory.storedOwner.sessionKey:too_big length=",
			);
			expect(message.length).toBeLessThanOrEqual(1000);
			expect(message).not.toContain(secret);
			expect(JSON.stringify(error)).not.toContain(secret);
			for (const log of logs) expect(log).not.toHaveBeenCalled();
		} finally {
			for (const log of logs) log.mockRestore();
		}
	});
	it("caps diagnostics even when every array entry fails validation", () => {
		const json = {
			...snapshot,
			inventory: {
				...snapshot.inventory,
				children: Array(1001).fill({
					...snapshot.inventory.children[0],
					name: "PRIVATE".repeat(100),
				}),
			},
		};
		try {
			cutoverInventoryFromAdminFetch({ ok: true, status: 200, json }, OBJECT);
			throw new Error("unexpected success");
		} catch (error) {
			expect(error).toMatchObject({ code: "BAD_GATEWAY" });
			const message = (error as Error).message;
			expect(message.length).toBeLessThanOrEqual(1000);
			expect(message).not.toContain("PRIVATE");
			expect(message.match(/too_big/g)?.length).toBeLessThanOrEqual(5);
		}
	});
	it("forwards a stable continuation and rejects mismatched page metadata or incomplete counts", async () => {
		const continuation = {
			...snapshot,
			qualification: { ...emptyQualification, offset: 200 },
			offset: 200,
			maintenanceJournal: { count: 0, offset: 200, records: [] },
			sdkWorkflows: { present: false, count: 0, offset: 200, rows: [] },
			limit: 2,
			nextOffset: 202,
			counts: {
				tables: 1,
				receipts: 1,
				privateImages: 1,
				children: 205,
				maintenance: 1,
			},
			inventory: {
				...snapshot.inventory,
				tables: [],
				receipts: [],
				privateImages: [],
				maintenance: [],
				children: Array(2).fill(snapshot.inventory.children[0]),
			},
		};
		transport.mockResolvedValueOnce(Response.json(continuation));
		expect(
			await client().inspectRuntimeCutover({
				...input,
				offset: 200,
				limit: 2,
				expectedHash: HASH,
				expectedInspectionHash: HASH,
			}),
		).toEqual(continuation);
		const params = new URL(String(transport.mock.calls[0]![0])).searchParams;
		expect(params.get("offset")).toBe("200");
		expect(params.get("limit")).toBe("2");
		expect(params.get("expectedHash")).toBe(HASH);
		for (const bad of [
			{ ...continuation, hash: "d".repeat(64) },
			{ ...continuation, offset: 201 },
			{ ...continuation, nextOffset: null },
			{ ...continuation, counts: { ...continuation.counts, children: 1 } },
		]) {
			transport.mockResolvedValueOnce(Response.json(bad));
			await expect(
				client().inspectRuntimeCutover({
					...input,
					offset: 200,
					limit: 2,
					expectedHash: HASH,
					expectedInspectionHash: HASH,
				}),
			).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		}
	});
	it("rejects unbounded or unhashed continuation requests before transport", async () => {
		for (const page of [
			{ offset: 1 },
			{ offset: -1 },
			{ offset: 0, limit: 201 },
			{ offset: 0, limit: 0 },
			{ offset: 0, expectedHash: "PRIVATE" },
		]) {
			await expect(
				client().inspectRuntimeCutover({ ...input, ...page }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(transport).not.toHaveBeenCalled();
	});
	it("requires an exact lowercase object ID and rejects extra input fields", async () => {
		for (const invalid of [
			{ ...input, objectId: OBJECT.toUpperCase() },
			{ ...input, objectId: "a".repeat(63) },
			{ ...input, routeTediId: "slug" },
			{ ...input, state: "PRIVATE" },
		]) {
			expect(TediRuntimeCutoverQuerySchema.safeParse(invalid).success).toBe(
				false,
			);
			await expect(
				client().inspectRuntimeCutover(invalid),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(transport).not.toHaveBeenCalled();
	});
});

describe("explicit operator proxy", () => {
	const custodyTediId = "22222222-2222-4222-8222-222222222222";
	const request = {
		...input,
		command: "apply" as const,
		operationId: "operator-op",
		custodyTediId,
		expectedGeneration: 2,
		sourceHash: HASH,
	};
	const receipt = {
		ok: true,
		id: OBJECT,
		command: "apply",
		operationId: "operator-op",
		generation: 2,
		state: "held",
		sourceHash: HASH,
		entries: 1,
		conversations: 1,
		preservedNativeConversations: 0,
	};
	function custody() {
		getTediById.mockImplementation(async (_db, id) => ({
			id,
			organizationId: "anchor-org",
			slug: id === ROUTE_TEDI ? "transport-anchor" : "custodian",
			isolateAgentId: "canonical-server-name",
		}));
	}
	it("projects an MCP object input while retaining exact command validation", () => {
		const projected = zodToToolInputJsonSchema(
			TediRuntimeCutoverOperationQuerySchema,
		);
		expect(projected.type).toBe("object");
		expect(projected.properties).toHaveProperty("command");
		expect(TediRuntimeCutoverOperationQuerySchema.parse(request)).toEqual(
			request,
		);
		for (const invalid of [
			{ ...request, custodyTediId: undefined },
			{ ...request, expectedGeneration: 0 },
			{ ...request, verificationAction: "hold" },
			{ ...request, command: "prepare", evidenceHash: undefined },
			{
				...request,
				command: "quarantine",
				custodyTediId: undefined,
				sourceHash: undefined,
				reasonCode: "unknown_owner",
				target: {
					className: "ConversationFacet",
					name: "x",
					identityVersion: null,
					identityName: null,
					objectId: OBJECT,
					registryHash: HASH,
					parentGeneration: 2,
				},
			},
		])
			expect(
				TediRuntimeCutoverOperationQuerySchema.safeParse(invalid).success,
			).toBe(false);
	});
	it("resolves D1 custody separately and forwards only the trusted operation body", async () => {
		custody();
		transport.mockResolvedValueOnce(Response.json(receipt));
		expect(await client().operateRuntimeCutover(request)).toEqual(receipt);
		expect(getTediById.mock.calls.map((call) => call[1])).toEqual([
			ROUTE_TEDI,
			custodyTediId,
		]);
		const [url, options] = transport.mock.calls[0]!;
		expect(new URL(String(url)).pathname).toBe("/__admin/pi-state-cutover");
		expect(options?.method).toBe("POST");
		expect(JSON.parse(String(options?.body))).toEqual({
			command: "apply",
			objectId: OBJECT,
			operationId: "operator-op",
			expectedGeneration: 2,
			sourceHash: HASH,
			custody: {
				tediId: custodyTediId,
				orgId: "anchor-org",
				objectName: "canonical-server-name",
			},
		});
	});
	it("binds child generation/state receipts to the actual target while preserving the finite parent ID", async () => {
		custody();
		const target = {
			className: "ConversationFacet",
			name: "synthetic-facet",
			identityVersion: "path-v2",
			identityName: "synthetic-recorded-identity",
			objectId: "b".repeat(64),
			registryHash: HASH,
			parentGeneration: 5,
		};
		const childRequest = { ...request, target };
		const childReceipt = { ...receipt, targetObjectId: target.objectId };
		transport.mockResolvedValueOnce(Response.json(childReceipt));
		expect(await client().operateRuntimeCutover(childRequest)).toEqual(
			childReceipt,
		);
		expect(
			JSON.parse(String(transport.mock.calls[0]![1]?.body)).target,
		).toEqual(target);
		for (const bad of [
			receipt,
			{ ...childReceipt, targetObjectId: "c".repeat(64) },
			{ ...childReceipt, id: target.objectId },
			{ ...childReceipt, generation: 5 },
			{ ...childReceipt, state: "active" },
		]) {
			transport.mockResolvedValueOnce(Response.json(bad));
			await expect(
				client().operateRuntimeCutover(childRequest),
			).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		}
		transport.mockResolvedValueOnce(Response.json(childReceipt));
		await expect(client().operateRuntimeCutover(request)).rejects.toMatchObject(
			{ code: "BAD_GATEWAY" },
		);
	});
	it("rejects asserted custody, unknown activation and missing facet epochs before transport", async () => {
		custody();
		for (const bad of [
			{ ...request, verified: true },
			{
				...input,
				command: "quarantine",
				operationId: "unknown",
				expectedGeneration: 0,
				reasonCode: "unknown_owner",
				target: {
					className: "ConversationFacet",
					name: "x",
					identityVersion: null,
					identityName: null,
					objectId: OBJECT,
					registryHash: HASH,
					parentGeneration: 2,
				},
			},
			{ ...request, custody: { tediId: "PRIVATE" } },
			{ ...request, objectName: "caller-name" },
			{ ...request, custodyTediId: undefined },
			{ ...request, command: "DELETE" },
			{
				...request,
				target: {
					className: "ConversationFacet",
					name: "x",
					identityVersion: null,
					identityName: null,
					objectId: OBJECT,
					registryHash: HASH,
				},
			},
		])
			await expect(
				client().operateRuntimeCutover(bad as typeof request),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(transport).not.toHaveBeenCalled();
	});
	it("quarantines anonymous custody and never falls back from missing canonical name to slug", async () => {
		const unknown = {
			...input,
			command: "quarantine" as const,
			operationId: "unknown-op",
			expectedGeneration: 0,
			reasonCode: "unknown_owner" as const,
		};
		transport.mockResolvedValueOnce(
			Response.json({
				ok: true,
				id: OBJECT,
				command: "quarantine",
				operationId: "unknown-op",
				generation: 1,
				state: "quarantined",
			}),
		);
		await client().operateRuntimeCutover(unknown);
		expect(
			JSON.parse(String(transport.mock.calls[0]![1]?.body)).custody,
		).toBeNull();
		transport.mockClear();
		await expect(client().operateRuntimeCutover(request)).rejects.toMatchObject(
			{ code: "BAD_REQUEST", message: "Canonical cutover custody unavailable" },
		);
		expect(transport).not.toHaveBeenCalled();
	});
	it("denies org-admin and missing service binding before mutation", async () => {
		custody();
		const denied = context();
		denied.user = { ...denied.user!, roles: ["org-admin"] };
		await expect(
			client(denied).operateRuntimeCutover(request),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(transport).not.toHaveBeenCalled();
		const noBinding = context();
		noBinding.env = {
			...noBinding.env,
			TEDI_SERVICE: undefined,
		} as unknown as CloudflareEnv;
		await expect(
			client(noBinding).operateRuntimeCutover(request),
		).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			message: "Runtime cutover operation unavailable (transport failure)",
		});
		expect(transport).not.toHaveBeenCalled();
	});
	it("reports bounded runtime refusal without exposing unknown private error data", async () => {
		custody();
		transport.mockResolvedValueOnce(
			Response.json(
				{ ok: false, rejection: "nonterminal_sdk_work" },
				{ status: 409 },
			),
		);
		await expect(client().operateRuntimeCutover(request)).rejects.toMatchObject(
			{
				code: "BAD_GATEWAY",
				message:
					"Runtime cutover operation unavailable (runtime status 409; rejection nonterminal_sdk_work)",
			},
		);
		transport.mockResolvedValueOnce(
			Response.json(
				{ ok: false, rejection: "PRIVATE token/url" },
				{ status: 409 },
			),
		);
		await expect(client().operateRuntimeCutover(request)).rejects.toMatchObject(
			{
				code: "BAD_GATEWAY",
				message: "Runtime cutover operation unavailable (runtime status 409)",
			},
		);
	});
	it("rejects stale/wrong receipts and private payloads", async () => {
		custody();
		const secret = "PRIVATE-content-token-url";
		for (const bad of [
			{ ...receipt, id: "b".repeat(64) },
			{ ...receipt, operationId: "wrong" },
			{ ...receipt, generation: 3 },
			{ ...receipt, generation: 0 },
			{ ...receipt, state: "active" },
			{ ...receipt, unknown: 1 },
			{ ...receipt, nonterminal: 1 },
			{ ...receipt, sourceHash: "d".repeat(64) },
			{ ...receipt, [secret]: secret },
		]) {
			transport.mockResolvedValueOnce(Response.json(bad));
			try {
				await client().operateRuntimeCutover(request);
				throw new Error("unexpected success");
			} catch (error) {
				expect(error).toMatchObject({ code: "BAD_GATEWAY" });
				expect(JSON.stringify(error)).not.toContain(secret);
			}
		}
	});
	it("accepts planning/bootstrap/accounting metadata and requires transfer fingerprints", async () => {
		custody();
		const cases = [
			[
				{
					command: "plan",
					expectedGeneration: 0,
					verificationAction: "initialize",
				},
				{
					state: "uninitialized",
					generation: 0,
					sourceHash: HASH,
					evidenceHash: HASH,
				},
			],
			[
				{
					command: "bootstrap_prepare",
					expectedGeneration: 0,
					sourceHash: HASH,
					evidenceHash: HASH,
				},
				{ state: "held", generation: 2, sourceHash: HASH },
			],
			[
				{ command: "inspect_accounting", expectedGeneration: 0 },
				{
					state: "uninitialized",
					generation: 0,
					accountingManifestHash: HASH,
					records: 1,
				},
			],
			[
				{
					command: "transfer_accounting",
					expectedGeneration: 2,
					accountingManifestHash: HASH,
				},
				{
					state: "held",
					generation: 2,
					accountingManifestHash: HASH,
					records: 1,
					sourceHashBefore: HASH,
					sourceHashAfter: HASH,
					destinationHashBefore: HASH,
					destinationHashAfter: HASH,
				},
			],
		];
		for (const [operation, output] of cases) {
			transport.mockResolvedValueOnce(
				Response.json({
					ok: true,
					id: OBJECT,
					command: operation!.command,
					operationId: "operator-op",
					...output,
				}),
			);
			await expect(
				client().operateRuntimeCutover({
					...input,
					operationId: "operator-op",
					custodyTediId,
					...operation,
				} as Parameters<ReturnType<typeof client>["operateRuntimeCutover"]>[0]),
			).resolves.toMatchObject({ command: operation!.command });
		}
	});
});

describe("passive inspection metadata contract", () => {
	it("projects a bounded hop object schema and requires canonical custody for registered hops", () => {
		const hop = {
			className: "Researcher",
			name: "research",
			identityVersion: "path-v2",
			identityName: "registered",
			objectId: OBJECT,
			registryHash: HASH,
			parentGeneration: 0,
		};
		const input = {
			routeTediId: ROUTE_TEDI,
			objectId: OBJECT,
			custodyTediId: ROUTE_TEDI,
			targetPath: [hop],
			expectedGeneration: 0,
		};
		expect(TediRuntimeCutoverQuerySchema.parse(input).targetPath).toEqual([
			hop,
		]);
		expect(
			TediRuntimeCutoverQuerySchema.safeParse({
				...input,
				custodyTediId: undefined,
			}).success,
		).toBe(false);
		expect(
			TediRuntimeCutoverQuerySchema.safeParse({
				...input,
				targetPath: Array(17).fill(hop),
			}).success,
		).toBe(false);
		expect(
			zodToToolInputJsonSchema(TediRuntimeCutoverQuerySchema),
		).toMatchObject({
			type: "object",
			properties: { targetPath: { type: "array", items: { type: "object" } } },
		});
	});
	it("rejects forged generations and SDK payloads without exposing them", () => {
		expect(() =>
			cutoverInventoryFromAdminFetch(
				{ ok: true, status: 200, json: snapshot },
				OBJECT,
				{ offset: 0, limit: 200, expectedGeneration: 1 },
			),
		).toThrow(/unexpected payload/);
		for (const extra of [
			{ admission: { state: "active", generation: 0 } },
			{
				sdkWork: snapshot.sdkWork.map((row) => ({
					...row,
					payload: "PRIVATE",
				})),
			},
			{ sdkWork: Array(5).fill(snapshot.sdkWork[0]) },
			{ maintenanceJournal: { count: 1, offset: 0, records: [] } },
		])
			expect(() =>
				cutoverInventoryFromAdminFetch(
					{ ok: true, status: 200, json: { ...snapshot, ...extra } },
					OBJECT,
				),
			).toThrow(/unexpected payload/);
	});
});

it("forwards a registered inspection chain exactly and validates the final facet response ID", async () => {
	const child = "d".repeat(64),
		hop = {
			className: "Researcher",
			name: "research",
			identityVersion: "path-v2" as const,
			identityName: "exact-registered-name",
			objectId: child,
			registryHash: HASH,
			parentGeneration: 0,
		};
	const response = { ...snapshot, id: child };
	transport.mockResolvedValue(Response.json(response));
	expect(
		await client().inspectRuntimeCutover({
			...input,
			custodyTediId: ROUTE_TEDI,
			targetPath: [hop],
			expectedGeneration: 0,
		}),
	).toEqual(response);
	const [url] = transport.mock.calls[0]!;
	const params = new URL(String(url)).searchParams;
	expect(JSON.parse(params.get("targetPath")!)).toEqual([hop]);
	expect(params.get("custodyTediId")).toBe(ROUTE_TEDI);
	expect(params.get("expectedGeneration")).toBe("0");
	transport.mockResolvedValue(Response.json(snapshot));
	await expect(
		client().inspectRuntimeCutover({
			...input,
			custodyTediId: ROUTE_TEDI,
			targetPath: [hop],
		}),
	).rejects.toMatchObject({ code: "BAD_GATEWAY" });
});

it("requires the separate inspection pin and validates journal-only continuation", () => {
	expect(
		TediRuntimeCutoverQuerySchema.safeParse({
			...input,
			offset: 1,
			expectedHash: HASH,
		}).success,
	).toBe(false);
	const record = {
		taskId: "isolate-corpus-audit",
		nextRunAt: 100,
		legacyScheduleIds: [],
		legacyCancelled: true,
		nativeScheduleId: null,
		recurringScheduleId: null,
	};
	const page = {
		...snapshot,
		limit: 1,
		counts: {
			tables: 0,
			receipts: 0,
			privateImages: 0,
			children: 0,
			maintenance: 0,
		},
		nextOffset: 1,
		maintenanceJournal: { count: 5, offset: 0, records: [record] },
		inventory: {
			...snapshot.inventory,
			tables: [],
			receipts: [],
			privateImages: [],
			children: [],
			maintenance: [],
		},
	};
	expect(
		cutoverInventoryFromAdminFetch(
			{ ok: true, status: 200, json: page },
			OBJECT,
			{ offset: 0, limit: 1 },
		),
	).toEqual(page);
	expect(() =>
		cutoverInventoryFromAdminFetch(
			{ ok: true, status: 200, json: { ...page, nextOffset: null } },
			OBJECT,
			{ offset: 0, limit: 1 },
		),
	).toThrow(/unexpected payload/);
	expect(() =>
		cutoverInventoryFromAdminFetch(
			{ ok: true, status: 200, json: page },
			OBJECT,
			{ offset: 0, limit: 1, expectedInspectionHash: "f".repeat(64) },
		),
	).toThrow(/unexpected payload/);
});

it("validates bounded SDK workflow metadata, cached-status counts and workflow-only pagination", () => {
	const row = {
		workflow_id: "provider-instance",
		workflow_name: "CHAT_TURN_WORKFLOW",
		status: "queued",
		created_at: 1700000000,
		updated_at: 1700000001,
		completed_at: null,
	};
	const page = {
		...snapshot,
		limit: 1,
		nextOffset: 1,
		sdkWork: snapshot.sdkWork.map((summary) =>
			summary.table === "cf_agents_workflows"
				? { ...summary, present: true, counts: { queued: 2 } }
				: summary,
		),
		sdkWorkflows: { present: true, count: 2, offset: 0, rows: [row] },
	};
	const read = (json: unknown) =>
		cutoverInventoryFromAdminFetch({ ok: true, status: 200, json }, OBJECT, {
			offset: 0,
			limit: 1,
			expectedHash: HASH,
			expectedInspectionHash: HASH,
		});
	expect(read(page)).toEqual(page);
	for (const status of [
		"queued",
		"running",
		"paused",
		"errored",
		"terminated",
		"complete",
		"waiting",
		"waitingForPause",
		"unknown",
	]) {
		expect(
			read({
				...page,
				sdkWork: page.sdkWork.map((summary) =>
					summary.table === "cf_agents_workflows"
						? { ...summary, counts: { [status]: 2 } }
						: summary,
				),
				sdkWorkflows: { ...page.sdkWorkflows, rows: [{ ...row, status }] },
			}),
		).toMatchObject({ sdkWorkflows: { rows: [{ status }] } });
	}
	for (const bad of [
		{ ...page, nextOffset: null },
		{ ...page, sdkWorkflows: { ...page.sdkWorkflows, count: 3 } },
		{ ...page, sdkWorkflows: { ...page.sdkWorkflows, offset: 1 } },
		{ ...page, sdkWorkflows: { ...page.sdkWorkflows, present: false } },
		{ ...page, sdkWorkflows: { ...page.sdkWorkflows, rows: [] } },
		...["metadata", "params", "error_name", "error_message", "id"].map(
			(field) => ({
				...page,
				sdkWorkflows: {
					...page.sdkWorkflows,
					rows: [{ ...row, [field]: "PRIVATE_WORKFLOW_PAYLOAD" }],
				},
			}),
		),
		...[
			{ created_at: -1 },
			{ updated_at: 1.5 },
			{ completed_at: "PRIVATE_ERROR" },
			{ workflow_id: "x".repeat(513) },
			{ status: "PRIVATE_PROVIDER_STATUS" },
		].map((invalid) => ({
			...page,
			sdkWorkflows: { ...page.sdkWorkflows, rows: [{ ...row, ...invalid }] },
		})),
	])
		expect(() => read(bad)).toThrow(/unexpected payload/);
	expect(() => read({ ...page, inspectionHash: "f".repeat(64) })).toThrow(
		/unexpected payload/,
	);
	const duplicate = {
		...page,
		limit: 2,
		nextOffset: null,
		sdkWorkflows: { ...page.sdkWorkflows, rows: [row, row] },
	};
	expect(() =>
		cutoverInventoryFromAdminFetch(
			{ ok: true, status: 200, json: duplicate },
			OBJECT,
			{ offset: 0, limit: 2 },
		),
	).toThrow(/unexpected payload/);
	const unsorted = {
		...duplicate,
		sdkWorkflows: {
			...duplicate.sdkWorkflows,
			rows: [{ ...row, workflow_id: "z" }, row],
		},
	};
	expect(() =>
		cutoverInventoryFromAdminFetch(
			{ ok: true, status: 200, json: unsorted },
			OBJECT,
			{ offset: 0, limit: 2 },
		),
	).toThrow(/unexpected payload/);
});

describe("root writer exclusion", () => {
	const input = {
		routeTediId: ROUTE_TEDI,
		custodyTediId: ROUTE_TEDI,
		objectId: OBJECT,
		operationId: "exclude",
		command: "exclude_writers" as const,
		expectedGeneration: 2,
	};
	it("projects actual input footprint and inspection-first UNKNOWN guidance", () => {
		const projected = JSON.stringify(
			zodToToolInputJsonSchema(TediRuntimeCutoverOperationQuerySchema),
		);
		for (const text of [
			"exclude_writers",
			"root hosted graph",
			"no success receipt",
			"UNKNOWN",
			"Before retry",
			"current owner custody",
			"physical object",
			"nonactive generation",
			"actual Raw receiver raw-cutover-v1",
			"stop retrying",
			"Never retry automatically",
		])
			expect(projected).toContain(text);
		expect(TediRuntimeCutoverOperationQuerySchema.parse(input)).toEqual(input);
		for (const extra of [
			{ targetPath: [] },
			{ target: {} },
			{ sourceHash: HASH },
			{ expectedGeneration: 0 },
			{ custodyTediId: undefined },
			{ candidateObjectNames: [] },
		])
			expect(
				TediRuntimeCutoverOperationQuerySchema.safeParse({ ...input, ...extra })
					.success,
			).toBe(false);
	});
	it("never accepts transport errors, private failures or forged success as reset receipt", async () => {
		const { cutoverOperationFromAdminFetch } =
			await import("./cutover-inventory");
		for (const result of [
			{ error: "PRIVATE transport" },
			{ ok: false, status: 503, json: { rejection: "PRIVATE secret" } },
			{ ok: true, status: 200, json: { ok: true, command: "exclude_writers" } },
			{ ok: true, status: 200, json: {} },
		]) {
			expect(() => cutoverOperationFromAdminFetch(result, input)).toThrow(
				"outcome UNKNOWN",
			);
			try {
				cutoverOperationFromAdminFetch(result, input);
			} catch (error) {
				expect(String(error)).not.toContain("PRIVATE");
				expect(String(error)).toContain("Before retry");
				expect(String(error)).toContain("raw-cutover-v1");
			}
		}
	});
});

it("existing authenticated procedure sends exclusion once and requires inspection for lost or forged outcomes", async () => {
	const request = {
		routeTediId: ROUTE_TEDI,
		custodyTediId: ROUTE_TEDI,
		objectId: OBJECT,
		operationId: "exclude-procedure",
		command: "exclude_writers" as const,
		expectedGeneration: 2,
	};
	getTediById.mockResolvedValue({
		id: ROUTE_TEDI,
		organizationId: "anchor-org",
		slug: "anchor",
		isolateAgentId: "canonical-server-name",
	});
	for (const result of ["lost", "forged"]) {
		transport.mockClear();
		if (result === "lost")
			transport.mockRejectedValueOnce(new Error("PRIVATE timeout"));
		else
			transport.mockResolvedValueOnce(
				Response.json({
					ok: true,
					command: "exclude_writers",
					operationId: request.operationId,
					id: OBJECT,
					state: "quarantined",
					generation: 2,
				}),
			);
		await expect(client().operateRuntimeCutover(request)).rejects.toMatchObject(
			{
				code: "BAD_GATEWAY",
				message: expect.stringContaining("outcome UNKNOWN"),
			},
		);
		expect(transport).toHaveBeenCalledTimes(1);
		const [, options] = transport.mock.calls[0]!;
		expect(options?.method).toBe("POST");
		const body = JSON.parse(String(options?.body));
		expect(body.command).toBe("exclude_writers");
		expect(body.custody).toEqual({
			tediId: ROUTE_TEDI,
			orgId: "anchor-org",
			objectName: "canonical-server-name",
		});
		expect(new Headers(options?.headers).get("X-Tedix-Admin-Token")).toBe(
			MASTER,
		);
	}
});

describe("capture size diagnostic", () => {
	const input = {
		routeTediId: ROUTE_TEDI,
		custodyTediId: ROUTE_TEDI,
		objectId: OBJECT,
		operationId: "capture",
		command: "inspect_capture_size" as const,
		expectedGeneration: 0,
	};
	const response = {
		ok: true,
		id: OBJECT,
		operationId: "capture",
		command: "inspect_capture_size",
		generation: 0,
		state: "uninitialized",
		selectorVersion: HASH,
		observation: "read_window_not_atomic_snapshot",
		sampledAt: "2026-10-05T00:00:00.000Z",
		complete: true,
		sql: [
			{
				category: "sdk",
				selector: 1,
				present: true,
				rows: 1,
				castValueBytes: 11,
				maxRowCastValueBytes: 11,
			},
		],
		kv: { entries: 0, canonicalItemBytes: 0 },
	};
	it("accepts scalar batches through 32 and rejects oversized or malformed observations", async () => {
		const { cutoverOperationFromAdminFetch } =
			await import("./cutover-inventory");
		for (const entries of [0, 1, 31, 32]) {
			const batch = {
				...response,
				kv: { entries, canonicalItemBytes: entries * 100 },
			};
			expect(
				cutoverOperationFromAdminFetch(
					{ ok: true, status: 200, json: batch },
					input,
				),
			).toEqual(batch);
		}
		for (const entries of [-1, 33, 1.5, "32"]) {
			expect(() =>
				cutoverOperationFromAdminFetch(
					{
						ok: true,
						status: 200,
						json: { ...response, kv: { entries, canonicalItemBytes: 0 } },
					},
					input,
				),
			).toThrow("Runtime cutover operation returned an unexpected payload");
		}
	});
	it("projects bounded read observations and refuses nested or unrelated command fields", () => {
		const projection = JSON.stringify(
			zodToToolInputJsonSchema(TediRuntimeCutoverOperationQuerySchema),
		);
		for (const text of [
			"inspect_capture_size",
			"read-window observations",
			"not an atomic snapshot",
			"archive size",
			"peak heap",
			"financial coverage",
		])
			expect(projection).toContain(text);
		expect(TediRuntimeCutoverOperationQuerySchema.parse(input)).toEqual(input);
		for (const change of [
			{ targetPath: [] },
			{ target: {} },
			{ sourceHash: HASH },
			{ custodyTediId: undefined },
			{ expectedGeneration: -1 },
			{ unknown: "PRIVATE" },
		])
			expect(
				TediRuntimeCutoverOperationQuerySchema.safeParse({
					...input,
					...change,
				}).success,
			).toBe(false);
		expect(
			TediRuntimeCutoverOperationQuerySchema.safeParse({
				...input,
				command: "exclude_writers",
				expectedGeneration: 1,
				continuation: "ciphertext",
			}).success,
		).toBe(false);
	});
	it("checks exact response identity and keeps malformed upstream labels/failures private", async () => {
		const { cutoverOperationFromAdminFetch } =
			await import("./cutover-inventory");
		expect(
			cutoverOperationFromAdminFetch(
				{ ok: true, status: 200, json: response },
				input,
			),
		).toEqual(response);
		const invalid = [
			{ ...response, id: "b".repeat(64) },
			{ ...response, generation: 1 },
			{ ...response, operationId: "wrong" },
			{ ...response, command: "plan" },
			{ ...response, sourceHash: HASH },
			{
				...response,
				sql: [{ ...response.sql[0], category: "private_customer_secret" }],
			},
			{ ...response, sql: [{ table: "PRIVATE", rows: 2 }] },
		];
		for (const json of invalid) {
			try {
				cutoverOperationFromAdminFetch({ ok: true, status: 200, json }, input);
				throw Error("Unexpected acceptance");
			} catch (error) {
				expect(String(error)).toContain("unexpected payload");
				expect(String(error)).not.toContain("PRIVATE");
				expect(String(error)).not.toContain("private_customer_secret");
			}
		}
		for (const result of [
			{ error: "PRIVATE transport" },
			{
				ok: false,
				status: 503,
				json: { rejection: "private_customer_secret" },
			},
			{
				ok: false,
				status: 409,
				json: { rejection: "canonical_custody_mismatch" },
			},
		])
			expect(() => cutoverOperationFromAdminFetch(result, input)).toThrow(
				"Runtime capture size diagnostic unavailable",
			);
	});
	it("uses existing authenticated procedure with canonical server custody and no retries", async () => {
		getTediById.mockResolvedValue({
			id: ROUTE_TEDI,
			organizationId: "anchor-org",
			slug: "anchor",
			isolateAgentId: "canonical-server-name",
		});
		transport.mockResolvedValueOnce(Response.json(response));
		expect(await client().operateRuntimeCutover(input)).toEqual(response);
		expect(transport).toHaveBeenCalledTimes(1);
		const [, options] = transport.mock.calls[0]!;
		const body = JSON.parse(String(options?.body));
		expect(body.custody).toEqual({
			tediId: ROUTE_TEDI,
			orgId: "anchor-org",
			objectName: "canonical-server-name",
		});
		expect(new Headers(options?.headers).get("X-Tedix-Admin-Token")).toBe(
			MASTER,
		);
		transport.mockClear();
		transport.mockRejectedValueOnce(Error("PRIVATE transport"));
		await expect(client().operateRuntimeCutover(input)).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			message: "Runtime capture size diagnostic unavailable",
		});
		expect(transport).toHaveBeenCalledTimes(1);
	});
});

describe("root historical custody operator", () => {
	const base = {
		routeTediId: ROUTE_TEDI,
		custodyTediId: ROUTE_TEDI,
		objectId: OBJECT,
		operationId: "historical",
		expectedGeneration: 1,
	};
	const commands = [
		"inspect_historical_custody",
		"capture_historical_custody",
		"audit_historical_custody",
	] as const;
	const summary = {
		ok: true,
		id: OBJECT,
		operationId: "historical",
		generation: 1,
		state: "quarantined",
		receiver: "raw-cutover-v1",
		snapshotId: HASH,
		sourceHash: HASH,
		workflowCount: 1,
		fiberCount: 1,
		identityCount: 4,
	};
	it.each(commands)(
		"projects strict %s root-only command fields and scalar summary",
		async (command) => {
			const input = {
				...base,
				command,
				...(command === "inspect_historical_custody"
					? {}
					: { expectedSourceHash: HASH }),
			};
			expect(TediRuntimeCutoverOperationQuerySchema.parse(input)).toEqual(
				input,
			);
			const projection = JSON.stringify(
				zodToToolInputJsonSchema(TediRuntimeCutoverOperationQuerySchema),
			);
			expect(projection).toContain(command);
			expect(projection).toContain("selected physical object fixed whitelist");
			expect(projection).toContain("expectedSourceHash");
			for (const change of [
				{ target: {} },
				{ targetPath: [] },
				{ candidateObjectNames: [] },
				{ sourceHash: HASH },
				{ continuation: "PRIVATE" },
				{ expectedGeneration: 0 },
				{ custodyTediId: undefined },
				{ verificationAction: "hold" },
				{ reasonCode: "operator_hold" },
			])
				expect(
					TediRuntimeCutoverOperationQuerySchema.safeParse({
						...input,
						...change,
					}).success,
				).toBe(false);
			const { cutoverOperationFromAdminFetch } =
				await import("./cutover-inventory");
			const response = { ...summary, command };
			const parsed = TediRuntimeCutoverOperationQuerySchema.parse(input);
			expect(
				cutoverOperationFromAdminFetch(
					{ ok: true, status: 200, json: response },
					parsed,
				),
			).toEqual(response);
			for (const change of [
				{ command: "plan" },
				{ id: "b".repeat(64) },
				{ operationId: "other" },
				{ generation: 2 },
				{ state: "active" },
				{ receiver: undefined },
				{ privateFacts: "PRIVATE" },
				...(command === "inspect_historical_custody"
					? []
					: [{ sourceHash: "f".repeat(64) }]),
			])
				expect(() =>
					cutoverOperationFromAdminFetch(
						{ ok: true, status: 200, json: { ...response, ...change } },
						parsed,
					),
				).toThrow("unexpected payload");
			for (const result of [
				{ error: "PRIVATE transport" },
				{
					ok: false,
					status: 409,
					json: { rejection: "private_customer_secret" },
				},
			])
				expect(() => cutoverOperationFromAdminFetch(result, parsed)).toThrow(
					"Runtime historical custody unavailable",
				);
		},
	);
	it.each(commands)(
		"authenticated %s procedure uses canonical server custody and dispatches once",
		async (command) => {
			getTediById.mockResolvedValue({
				id: ROUTE_TEDI,
				organizationId: "anchor-org",
				slug: "anchor",
				isolateAgentId: "canonical-server-name",
			});
			const input = {
					...base,
					command,
					...(command === "inspect_historical_custody"
						? {}
						: { expectedSourceHash: HASH }),
				},
				response = { ...summary, command };
			transport.mockResolvedValueOnce(Response.json(response));
			expect(await client().operateRuntimeCutover(input)).toEqual(response);
			expect(transport).toHaveBeenCalledTimes(1);
			const [, options] = transport.mock.calls[0]!;
			expect(JSON.parse(String(options?.body)).custody).toEqual({
				tediId: ROUTE_TEDI,
				orgId: "anchor-org",
				objectName: "canonical-server-name",
			});
			transport.mockClear();
			transport.mockRejectedValueOnce(Error("PRIVATE transport"));
			await expect(client().operateRuntimeCutover(input)).rejects.toMatchObject(
				{
					code: "BAD_GATEWAY",
					message: "Runtime historical custody unavailable",
				},
			);
			expect(transport).toHaveBeenCalledTimes(1);
		},
	);
});

it("dispatches quarantine-only registered path once and validates the last physical leaf receipt", async () => {
	getTediById.mockResolvedValue({
		id: ROUTE_TEDI,
		organizationId: "anchor-org",
		slug: "anchor",
		isolateAgentId: "canonical-server-name",
	});
	const first = {
		className: "Researcher",
		name: "original",
		identityVersion: null,
		identityName: null,
		objectId: "b".repeat(64),
		registryHash: HASH,
		parentGeneration: 4,
	};
	const last = {
		...first,
		name: "nested",
		objectId: "d".repeat(64),
		parentGeneration: 0,
	};
	const input = {
		routeTediId: ROUTE_TEDI,
		custodyTediId: ROUTE_TEDI,
		objectId: OBJECT,
		operationId: "path-quarantine",
		command: "quarantine" as const,
		expectedGeneration: 0,
		reasonCode: "unresolved_work" as const,
		targetPath: [first, last],
	};
	const response = {
		ok: true,
		id: OBJECT,
		targetObjectId: last.objectId,
		operationId: input.operationId,
		command: input.command,
		generation: 1,
		state: "quarantined",
	};
	const client = createRouterClient(
		{ operateRuntimeCutover: operateRuntimeCutoverProcedure },
		{ context: context() },
	);
	transport.mockResolvedValueOnce(Response.json(response));
	expect(await client.operateRuntimeCutover(input)).toEqual(response);
	expect(transport).toHaveBeenCalledTimes(1);
	const sent = JSON.parse(String(transport.mock.calls[0]![1]?.body));
	expect(sent.targetPath).toEqual(input.targetPath);
	expect(sent.custody).toEqual({
		tediId: ROUTE_TEDI,
		orgId: "anchor-org",
		objectName: "canonical-server-name",
	});
	for (const bad of [
		{ ...response, targetObjectId: first.objectId },
		{ ...response, targetObjectId: undefined },
		{ ...response, id: last.objectId },
	]) {
		transport.mockClear();
		transport.mockResolvedValueOnce(Response.json(bad));
		await expect(client.operateRuntimeCutover(input)).rejects.toMatchObject({
			code: "BAD_GATEWAY",
		});
		expect(transport).toHaveBeenCalledTimes(1);
	}

	for (const privateFailure of [
		new Response(JSON.stringify({ rejection: "private_customer_value" }), {
			status: 409,
		}),
		new Response("PRIVATE", { status: 500 }),
	]) {
		transport.mockClear();
		transport.mockResolvedValueOnce(privateFailure);
		await expect(client.operateRuntimeCutover(input)).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			message: "Runtime registered quarantine unavailable",
		});
		expect(transport).toHaveBeenCalledTimes(1);
	}
	for (const bad of [
		{ ...input, command: "release" },
		{ ...input, expectedGeneration: 1 },
		{ ...input, custodyTediId: undefined },
		{ ...input, target: first },
		{ ...input, targetPath: [] },
	])
		expect(TediRuntimeCutoverOperationQuerySchema.safeParse(bad).success).toBe(
			false,
		);
});

describe("original descendant historical custody boundary", () => {
	const hop = {
		className: "Researcher",
		name: "original",
		identityVersion: null,
		identityName: null,
		objectId: "d".repeat(64),
		registryHash: HASH,
		parentGeneration: 1,
	};
	it.each([
		"inspect_historical_custody",
		"capture_historical_custody",
		"audit_historical_custody",
	] as const)(
		"dispatches %s once and binds the exact leaf summary",
		async (command) => {
			getTediById.mockResolvedValue({
				id: ROUTE_TEDI,
				organizationId: "anchor-org",
				slug: "anchor",
				isolateAgentId: "canonical-server-name",
			});
			const input = {
				routeTediId: ROUTE_TEDI,
				custodyTediId: ROUTE_TEDI,
				objectId: OBJECT,
				operationId: "descendant",
				command,
				expectedGeneration: 2,
				targetPath: [hop],
				...(command === "inspect_historical_custody"
					? {}
					: { expectedSourceHash: HASH }),
			};
			const parsed = TediRuntimeCutoverOperationQuerySchema.parse(input);
			const response = {
				ok: true,
				id: OBJECT,
				targetObjectId: hop.objectId,
				operationId: "descendant",
				command,
				generation: 2,
				state: "quarantined",
				receiver: "raw-cutover-v1",
				snapshotId: HASH,
				sourceHash: HASH,
				workflowCount: 1,
				fiberCount: 1,
				identityCount: 4,
			};
			const client = createRouterClient(
				{ operateRuntimeCutover: operateRuntimeCutoverProcedure },
				{ context: context() },
			);
			transport.mockResolvedValueOnce(Response.json(response));
			expect(await client.operateRuntimeCutover(input)).toEqual(response);
			expect(transport).toHaveBeenCalledTimes(1);
			const sent = JSON.parse(String(transport.mock.calls[0]![1]?.body));
			expect(sent.targetPath).toEqual([hop]);
			expect(sent.custody).toEqual({
				tediId: ROUTE_TEDI,
				orgId: "anchor-org",
				objectName: "canonical-server-name",
			});
			const { cutoverOperationFromAdminFetch } =
				await import("./cutover-inventory");
			for (const change of [
				{ targetObjectId: undefined },
				{ targetObjectId: OBJECT },
				{ id: hop.objectId },
				{ generation: 1 },
				{ privateFact: "PRIVATE" },
			])
				expect(() =>
					cutoverOperationFromAdminFetch(
						{ ok: true, status: 200, json: { ...response, ...change } },
						parsed,
					),
				).toThrow("unexpected payload");
			for (const change of [
				{ expectedGeneration: 0 },
				{ targetPath: [] },
				{ target: {} },
				{ targetPath: Array(17).fill(hop) },
			])
				expect(
					TediRuntimeCutoverOperationQuerySchema.safeParse({
						...input,
						...change,
					}).success,
				).toBe(false);
		},
	);
});

async function recordedOriginalRoot() {
	const { HistoricalExposureInputSchema } =
		await import("@tedix/api-contract/schemas/billing");
	const { sha256Hex } = await import("@tedix/worker-kit/crypto");
	const organizationId = "22222222-2222-4222-8222-222222222222",
		observedBy = "independent-owner",
		observedUserId = "33333333-3333-4333-8333-333333333333",
		operationId = "original-record";
	const input = HistoricalExposureInputSchema.parse({
		tediId: ROUTE_TEDI,
		operationId,
		rootObjectId: OBJECT,
		objectId: OBJECT,
		targetPath: [],
		expectedGeneration: 1,
		snapshotId: HASH,
		sourceHash: HASH,
	});
	const requestHash = await sha256Hex(
		JSON.stringify([organizationId, observedBy, observedUserId, input]),
	);
	const value = {
		id: "44444444-4444-4444-8444-444444444444",
		organizationId,
		tediId: ROUTE_TEDI,
		rootObjectId: OBJECT,
		objectId: OBJECT,
		rootObjectName: "original",
		objectName: "original",
		className: "AgentTediDO",
		targetPath: [],
		generation: 1,
		snapshotId: HASH,
		sourceHash: HASH,
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
		observedBy,
		observedUserId,
		observedAt: "2026-10-05T00:00:00.000Z",
		requestHash,
	};
	return {
		...value,
		operationId,
		payload: JSON.stringify(value),
		currentOrganizationId: organizationId,
		currentObjectName: "fresh",
	};
}
describe("retained root original-name routing", () => {
	it("actual historical procedure derives old name from immutable root evidence and dispatches once", async () => {
		const row = await recordedOriginalRoot();
		getRetainedRuntimeRoot.mockResolvedValue(row);
		getTediById.mockResolvedValue({
			id: ROUTE_TEDI,
			organizationId: row.organizationId,
			slug: "transport",
			isolateAgentId: "fresh",
		});
		transport.mockResolvedValue(
			Response.json({
				ok: true,
				id: OBJECT,
				command: "audit_historical_custody",
				operationId: "original-audit",
				generation: 1,
				state: "quarantined",
				receiver: "raw-cutover-v1",
				snapshotId: HASH,
				sourceHash: HASH,
				workflowCount: 1,
				fiberCount: 1,
				identityCount: 1,
			}),
		);
		await client(
			context({ organizationId: row.organizationId }),
		).operateRuntimeCutover({
			routeTediId: ROUTE_TEDI,
			custodyTediId: ROUTE_TEDI,
			objectId: OBJECT,
			operationId: "original-audit",
			command: "audit_historical_custody",
			expectedGeneration: 1,
			expectedSourceHash: HASH,
		});
		expect(transport).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(String(transport.mock.calls[0]![1]!.body)).custody.objectName,
		).toBe("original");
	});
	it.each(["actor", "scalar", "hash", "final-row", "private-query-error"])(
		"rejects %s tampering before dispatch with static refusal",
		async (kind) => {
			const row = await recordedOriginalRoot();
			const changed =
				kind === "actor"
					? { ...row, observedBy: "PRIVATE contradictory actor" }
					: kind === "scalar"
						? { ...row, organizationId: "PRIVATE contradictory scalar" }
						: kind === "hash"
							? { ...row, requestHash: "f".repeat(64) }
							: { ...row, currentObjectName: "changed" };
			getRetainedRuntimeRoot.mockResolvedValue(changed);
			if (kind === "private-query-error")
				getRetainedRuntimeRoot.mockRejectedValue(
					new Error("PRIVATE DB error payload"),
				);
			if (kind === "final-row")
				getRetainedRuntimeRoot.mockResolvedValueOnce(row);
			getTediById.mockResolvedValue({
				id: ROUTE_TEDI,
				organizationId: row.organizationId,
				slug: "transport",
				isolateAgentId: "fresh",
			});
			await expect(
				client(
					context({ organizationId: row.organizationId }),
				).operateRuntimeCutover({
					routeTediId: ROUTE_TEDI,
					custodyTediId: ROUTE_TEDI,
					objectId: OBJECT,
					operationId: "original-audit",
					command: "audit_historical_custody",
					expectedGeneration: 1,
					expectedSourceHash: HASH,
				}),
			).rejects.toMatchObject({
				message: "Runtime historical custody unavailable",
			});
			expect(transport).not.toHaveBeenCalled();
		},
	);
	it("quarantine never resolves historical original-name evidence", async () => {
		const row = await recordedOriginalRoot();
		getRetainedRuntimeRoot.mockResolvedValue(row);
		getTediById.mockResolvedValue({
			id: ROUTE_TEDI,
			organizationId: row.organizationId,
			slug: "transport",
			isolateAgentId: "fresh",
		});
		transport.mockResolvedValue(
			Response.json({
				ok: true,
				id: OBJECT,
				command: "quarantine",
				operationId: "q",
				generation: 1,
				state: "quarantined",
			}),
		);
		await client(
			context({ organizationId: row.organizationId }),
		).operateRuntimeCutover({
			routeTediId: ROUTE_TEDI,
			custodyTediId: ROUTE_TEDI,
			objectId: OBJECT,
			operationId: "q",
			command: "quarantine",
			expectedGeneration: 0,
			reasonCode: "unresolved_work",
		});
		expect(getRetainedRuntimeRoot).not.toHaveBeenCalled();
		expect(
			JSON.parse(String(transport.mock.calls[0]![1]!.body)).custody.objectName,
		).toBe("fresh");
	});
});

it("requires strict v2 qualification and rejects incomplete/forged observations without leaking payload", () => {
	const read = (json: unknown) =>
		cutoverInventoryFromAdminFetch({ ok: true, status: 200, json }, OBJECT);
	expect(read(snapshot)).toEqual(snapshot);
	for (const json of [
		{ ...snapshot, version: undefined },
		{ ...snapshot, version: "v1" },
		{ ...snapshot, qualification: undefined },
		{
			...snapshot,
			qualification: { ...emptyQualification, PRIVATE_TOKEN: "do not leak" },
		},
		{
			...snapshot,
			qualification: { ...emptyQualification, nativeSchemaState: "supported" },
		},
		{
			...snapshot,
			qualification: {
				...emptyQualification,
				tables: emptyQualification.tables.map((t, i) =>
					i === 0 ? { ...t, statusCounts: { PRIVATE_STATUS: 1 } } : t,
				),
			},
		},
		{ ...snapshot, qualification: { ...emptyQualification, journalCount: 1 } },
		{ ...snapshot, qualification: { ...emptyQualification, offset: 1 } },
	]) {
		try {
			read(json);
			throw new Error("unexpected success");
		} catch (error) {
			expect(String(error)).toMatch(/unexpected payload/);
			expect(String(error)).not.toContain("PRIVATE");
		}
	}
});

it("rejects cross-family states and forged known/unknown accounting observations", () => {
	const row = {
		ordinal: 0,
		family: "native_accounting",
		identityHash: null,
		projectionHash: HASH,
		structuralState: "known",
		observedState: "present",
		completionValidation: "not_passed",
		faultPresent: false,
		phaseCounts: { started: 1 },
		unacknowledgedCount: 1,
		unsealedEffectsCount: 1,
		usageNullCounts: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
	};
	const q = {
		...emptyQualification,
		journalCount: 1,
		journalFamilies: emptyQualification.journalFamilies.map((f) =>
			f.family === "native_accounting"
				? { ...f, count: 1, states: { present: 1 } }
				: f,
		),
		rows: [row],
	};
	expect(
		TediRuntimeCutoverInventoryResponseSchema.safeParse({
			...snapshot,
			qualification: q,
		}).success,
	).toBe(true);
	for (const change of [
		{ projectionHash: null },
		{ observedState: "completed" },
		{ phaseCounts: { accepted: 1 } },
		{ usageNullCounts: { inputTokens: 1, outputTokens: 0, totalTokens: 0 } },
		{
			structuralState: "unsupported",
			projectionHash: null,
			completionValidation: "unknown",
		},
	])
		expect(
			TediRuntimeCutoverInventoryResponseSchema.safeParse({
				...snapshot,
				qualification: { ...q, rows: [{ ...row, ...change }] },
			}).success,
		).toBe(false);
	const tasks = {
		...emptyQualification,
		tables: emptyQualification.tables.map((t) =>
			t.table === "pi_tasks"
				? {
						...t,
						present: true,
						schemaState: "supported",
						rowCount: 1,
						projectionHash: HASH,
						statusCounts: { accepted: 1 },
					}
				: t,
		),
	};
	expect(
		TediRuntimeCutoverInventoryResponseSchema.safeParse({
			...snapshot,
			qualification: tasks,
		}).success,
	).toBe(false);
});

it("rejects missing task-state coverage and family-substituted ordinal rows", () => {
	const tasks = {
		...emptyQualification,
		tables: emptyQualification.tables.map((t) =>
			t.table === "pi_tasks"
				? {
						...t,
						present: true,
						schemaState: "supported",
						rowCount: 1,
						projectionHash: HASH,
						statusCounts: {},
					}
				: t,
		),
	};
	expect(
		TediRuntimeCutoverInventoryResponseSchema.safeParse({
			...snapshot,
			qualification: tasks,
		}).success,
	).toBe(false);
	const row = {
		ordinal: 0,
		family: "native_active_conversation",
		identityHash: null,
		projectionHash: HASH,
		structuralState: "known",
		observedState: "present",
		completionValidation: "unknown",
		faultPresent: null,
		phaseCounts: {},
		unacknowledgedCount: null,
		unsealedEffectsCount: null,
		usageNullCounts: null,
	};
	const q = {
		...emptyQualification,
		journalCount: 1,
		journalFamilies: emptyQualification.journalFamilies.map((f) =>
			f.family === "legacy_import_marker"
				? { ...f, count: 1, states: { present: 1 } }
				: f,
		),
		rows: [row],
	};
	q.journalFamilies = emptyQualification.journalFamilies.map((f) =>
		f.family === "legacy_import_marker"
			? { ...f, count: 1, states: { present: 1 } }
			: f,
	);
	expect(
		TediRuntimeCutoverInventoryResponseSchema.safeParse({
			...snapshot,
			qualification: q,
		}).success,
	).toBe(false);
});

it("new native preservation commands require exact strict response and reject old runtime receipts", async () => {
	const { cutoverOperationFromAdminFetch } =
		await import("./cutover-inventory");
	const { NativePreservationTableNames } =
		await import("@tedix/api-contract/schemas/tedi");
	const archiveId = "00000000-0000-4000-8000-000000000005";
	const archive = {
		format: "native-state-archive-v1",
		archiveId,
		selectorVersion: "a".repeat(64),
		metadata: {
			tables: NativePreservationTableNames.map((table) => ({
				table,
				present: false,
				rows: 0,
				schema: "absent",
			})),
			kvEntries: 0,
			sourceBytes: 0,
			recordCount: 0,
			localOwnerUnknown: true,
		},
		metadataDigest: "b".repeat(64),
		projectionDigest: null,
		legacyArchive: { state: "absent" },
	};
	for (const command of [
		"inspect_native_preservation",
		"capture_native_preservation",
		"audit_native_preservation",
	] as const) {
		const q = TediRuntimeCutoverOperationQuerySchema.parse({
			routeTediId: ROUTE_TEDI,
			objectId: OBJECT,
			operationId: "native",
			custodyTediId: ROUTE_TEDI,
			expectedGeneration: 1,
			command,
			...(command === "inspect_native_preservation" ? {} : { archiveId }),
			...(command === "capture_native_preservation" ? { proof: "opaque" } : {}),
		});
		const json = {
			ok: true,
			id: OBJECT,
			targetObjectId: OBJECT,
			operationId: "native",
			generation: 1,
			state: "held",
			receiver: "raw-cutover-v1",
			command,
			archive,
			...(command === "inspect_native_preservation" ? { proof: "opaque" } : {}),
		};
		expect(
			cutoverOperationFromAdminFetch({ ok: true, status: 200, json }, q),
		).toEqual(json);
		for (const mutation of [
			{ id: "f".repeat(64) },
			{ targetObjectId: "f".repeat(64) },
			{ operationId: "other" },
			{ generation: 2 },
			{ receiver: "native" },
			{ archive: { ...archive, sourceHash: "private" } },
			{ archive: { ...archive, projectionDigest: "a".repeat(64) } },
			{ archive: { ...archive, format: "historical-v1" } },
		])
			expect(() =>
				cutoverOperationFromAdminFetch(
					{ ok: true, status: 200, json: { ...json, ...mutation } },
					q,
				),
			).toThrow();
		expect(() =>
			cutoverOperationFromAdminFetch(
				{
					ok: true,
					status: 200,
					json: {
						ok: true,
						command: "audit_historical_custody",
						id: OBJECT,
						operationId: "native",
						generation: 1,
						state: "held",
						receiver: "raw-cutover-v1",
						snapshotId: "a".repeat(64),
						sourceHash: "b".repeat(64),
						workflowCount: 0,
						fiberCount: 0,
						identityCount: 0,
					},
				},
				q,
			),
		).toThrow();
		expect(() =>
			cutoverOperationFromAdminFetch(
				{ ok: false, status: 400, json: "Invalid cutover operation" },
				q,
			),
		).toThrow();
	}
});

it("new session preservation commands require exact strict response and reject old runtime receipts", async () => {
	const { cutoverOperationFromAdminFetch } =
		await import("./cutover-inventory");
	const { SessionPreservationTableNames } =
		await import("@tedix/api-contract/schemas/tedi");
	const archiveId = "00000000-0000-4000-8000-000000000005";
	const archive = {
		format: "session-state-archive-v1",
		archiveId,
		selectorVersion: "a".repeat(64),
		metadata: {
			tables: SessionPreservationTableNames.map((table) => ({
				table,
				present: false,
				rows: 0,
				schema: "absent",
			})),
			sourceBytes: 0,
			recordCount: 0,
			localOwnerUnknown: true,
		},
		metadataDigest: "b".repeat(64),
		projectionDigest: null,
		priorArchives: { historical: "absent", native: "absent" },
	};
	for (const command of [
		"inspect_session_preservation",
		"capture_session_preservation",
		"audit_session_preservation",
	] as const) {
		const q = TediRuntimeCutoverOperationQuerySchema.parse({
			routeTediId: ROUTE_TEDI,
			objectId: OBJECT,
			operationId: "native",
			custodyTediId: ROUTE_TEDI,
			expectedGeneration: 1,
			command,
			...(command === "inspect_session_preservation" ? {} : { archiveId }),
			...(command === "capture_session_preservation"
				? { proof: "opaque" }
				: {}),
		});
		const json = {
			ok: true,
			id: OBJECT,
			targetObjectId: OBJECT,
			operationId: "native",
			generation: 1,
			state: "held",
			receiver: "raw-cutover-v1",
			command,
			archive,
			...(command === "inspect_session_preservation"
				? { proof: "opaque" }
				: {}),
		};
		expect(
			cutoverOperationFromAdminFetch({ ok: true, status: 200, json }, q),
		).toEqual(json);
		for (const mutation of [
			{ id: "f".repeat(64) },
			{ targetObjectId: "f".repeat(64) },
			{ operationId: "other" },
			{ generation: 2 },
			{ receiver: "native" },
			{ archive: { ...archive, sourceHash: "private" } },
			{ archive: { ...archive, projectionDigest: "a".repeat(64) } },
			{ archive: { ...archive, format: "historical-v1" } },
		])
			expect(() =>
				cutoverOperationFromAdminFetch(
					{ ok: true, status: 200, json: { ...json, ...mutation } },
					q,
				),
			).toThrow();
		expect(() =>
			cutoverOperationFromAdminFetch(
				{
					ok: true,
					status: 200,
					json: {
						ok: true,
						command: "audit_historical_custody",
						id: OBJECT,
						operationId: "native",
						generation: 1,
						state: "held",
						receiver: "raw-cutover-v1",
						snapshotId: "a".repeat(64),
						sourceHash: "b".repeat(64),
						workflowCount: 0,
						fiberCount: 0,
						identityCount: 0,
					},
				},
				q,
			),
		).toThrow();
		expect(() =>
			cutoverOperationFromAdminFetch(
				{ ok: false, status: 400, json: "Invalid cutover operation" },
				q,
			),
		).toThrow();
	}
});

it("read-only session qualification requires original pins and coherent safe observations", async () => {
	const { cutoverOperationFromAdminFetch } =
		await import("./cutover-inventory");
	const { SessionPreservationTableNames } =
		await import("@tedix/api-contract/schemas/tedi");
	const archiveId = "00000000-0000-4000-8000-000000000005",
		q = TediRuntimeCutoverOperationQuerySchema.parse({
			routeTediId: ROUTE_TEDI,
			custodyTediId: ROUTE_TEDI,
			objectId: OBJECT,
			operationId: "qualification",
			expectedGeneration: 1,
			command: "inspect_session_rehydration",
			archiveId,
		});
	const absent = {
		status: "absent",
		reason: null,
		sessions: 0,
		messages: 0,
		branches: 0,
		compactions: 0,
		attachments: 0,
	};
	const archive = {
		format: "session-state-archive-v1",
		archiveId,
		selectorVersion: HASH,
		metadata: {
			tables: SessionPreservationTableNames.map((table) => ({
				table,
				present: false,
				rows: 0,
				schema: "absent",
			})),
			sourceBytes: 10,
			recordCount: 9,
			localOwnerUnknown: true,
		},
		metadataDigest: HASH,
		projectionDigest: null,
		priorArchives: { historical: "absent", native: "absent" },
	};
	const qualification = {
		schemaVersion: 2,
		budget: {
			policy: "session-semantic-stream-v2",
			sourceBytes: 10,
			selectedRows: 0,
			processedRows: 0,
			workUnits: 1,
			scanBytes: 10,
			retainedBytes: 0,
			exhausted: null,
			attemptedCharge: null,
			clockExpired: false,
			retainedAtFailure: null,
		},
		scope: "archived_selected_session8",
		archiveAuthenticated: true,
		parentLocal: absent,
		sdk7: absent,
		canonicalLedgerCorrespondence: "not_queried",
		adoptionReady: false,
		executionEligible: false,
	};
	const json = {
		ok: true,
		id: OBJECT,
		targetObjectId: OBJECT,
		operationId: "qualification",
		generation: 1,
		state: "quarantined",
		receiver: "raw-cutover-v1",
		command: q.command,
		archive,
		qualification,
	};
	expect(
		cutoverOperationFromAdminFetch({ ok: true, status: 200, json }, q),
	).toEqual(json);
	expect(
		cutoverOperationFromAdminFetch(
			{
				ok: true,
				status: 200,
				json: { ...json, archive: null, qualification: null },
			},
			q,
		),
	).toMatchObject({ archive: null, qualification: null });
	for (const mutation of [
		{ operationId: "other" },
		{ generation: 2 },
		{ targetObjectId: "f".repeat(64) },
		{
			archive: {
				...archive,
				archiveId: "00000000-0000-4000-8000-000000000006",
			},
		},
		{ qualification: { ...qualification, adoptionReady: true } },
		{ qualification: { ...qualification, executionEligible: true } },
		{
			qualification: {
				...qualification,
				canonicalLedgerCorrespondence: "matched",
			},
		},
		{ qualification: { ...qualification, privateText: "PRIVATE" } },
		{
			qualification: {
				...qualification,
				parentLocal: { ...absent, status: "supported", messages: 1 },
			},
		},
		{
			qualification: {
				...qualification,
				sdk7: { ...absent, status: "supported", messages: 1 },
			},
		},
		{
			qualification: {
				...qualification,
				parentLocal: { ...absent, status: "unavailable", reason: null },
			},
		},
		{ archive: null },
	])
		expect(() =>
			cutoverOperationFromAdminFetch(
				{ ok: true, status: 200, json: { ...json, ...mutation } },
				q,
			),
		).toThrow();
	getTediById.mockResolvedValue({
		id: ROUTE_TEDI,
		organizationId: "anchor-org",
		slug: "anchor",
		isolateAgentId: "canonical-server-name",
	});
	transport.mockResolvedValue(
		Response.json({ ...json, archive: null, qualification: null }),
	);
	expect(await client().operateRuntimeCutover(q)).toMatchObject({
		qualification: null,
	});
	const body = JSON.parse(String(transport.mock.calls.at(-1)![1]!.body));
	expect(body.command).toBe("inspect_session_rehydration");
	expect(body.archiveId).toBe(archiveId);
	expect(body.custody.tediId).toBe(ROUTE_TEDI);
});

it("new SDK preservation commands require exact strict response and reject old runtime receipts", async () => {
	const { cutoverOperationFromAdminFetch } =
		await import("./cutover-inventory");
	const { SdkPreservationTableNames } =
		await import("@tedix/api-contract/schemas/tedi");
	const archiveId = "00000000-0000-4000-8000-000000000005";
	const archive = {
		format: "sdk-work-state-archive-v1",
		archiveId,
		selectorVersion:
			"420335a11e49b81134025035a54fc9cda5b6b1bec4dd2b276f3766531651e242",
		metadata: {
			tables: SdkPreservationTableNames.map((table) => ({
				table,
				present: false,
				rows: 0,
				schema: "absent",
			})),
			kvEntries: 0,
			sourceBytes: 0,
			recordCount: 0,
			localOwnerUnknown: true,
		},
		metadataDigest: "b".repeat(64),
		projectionDigest: null,
		priorArchives: {
			historical: "absent",
			native: "absent",
			session: "absent",
		},
		alarmCovered: false,
		alarmConsistency: "UNKNOWN",
	};
	for (const command of [
		"inspect_sdk_preservation",
		"capture_sdk_preservation",
		"audit_sdk_preservation",
	] as const) {
		const q = TediRuntimeCutoverOperationQuerySchema.parse({
			routeTediId: ROUTE_TEDI,
			objectId: OBJECT,
			operationId: "native",
			custodyTediId: ROUTE_TEDI,
			expectedGeneration: 1,
			command,
			...(command === "inspect_sdk_preservation" ? {} : { archiveId }),
			...(command === "capture_sdk_preservation" ? { proof: "opaque" } : {}),
		});
		const json = {
			ok: true,
			id: OBJECT,
			targetObjectId: OBJECT,
			operationId: "native",
			generation: 1,
			state: "held",
			receiver: "raw-cutover-v1",
			command,
			archive,
			...(command === "inspect_sdk_preservation" ? { proof: "opaque" } : {}),
		};
		expect(
			cutoverOperationFromAdminFetch({ ok: true, status: 200, json }, q),
		).toEqual(json);
		for (const mutation of [
			{ id: "f".repeat(64) },
			{ targetObjectId: "f".repeat(64) },
			{ operationId: "other" },
			{ generation: 2 },
			{ receiver: "native" },
			{ archive: { ...archive, sourceHash: "private" } },
			{ archive: { ...archive, projectionDigest: "a".repeat(64) } },
			{ archive: { ...archive, format: "historical-v1" } },
			{ archive: { ...archive, alarmCovered: true } },
			{
				archive: {
					...archive,
					metadata: {
						...archive.metadata,
						tables: archive.metadata.tables.map((t, i) =>
							i === 25
								? { ...t, present: true, schema: "unknown", rows: 1 }
								: t,
						),
					},
				},
			},
		])
			expect(() =>
				cutoverOperationFromAdminFetch(
					{ ok: true, status: 200, json: { ...json, ...mutation } },
					q,
				),
			).toThrow();
		expect(() =>
			cutoverOperationFromAdminFetch(
				{
					ok: true,
					status: 200,
					json: {
						ok: true,
						command: "audit_historical_custody",
						id: OBJECT,
						operationId: "native",
						generation: 1,
						state: "held",
						receiver: "raw-cutover-v1",
						snapshotId: "a".repeat(64),
						sourceHash: "b".repeat(64),
						workflowCount: 0,
						fiberCount: 0,
						identityCount: 0,
					},
				},
				q,
			),
		).toThrow();
		expect(() =>
			cutoverOperationFromAdminFetch(
				{ ok: false, status: 400, json: "Invalid cutover operation" },
				q,
			),
		).toThrow();
	}
});

it("custody coverage authenticates exact identity and keeps incomplete domains explicit", async () => {
	const { cutoverOperationFromAdminFetch } =
		await import("./cutover-inventory");
	const q = TediRuntimeCutoverOperationQuerySchema.parse({
		command: "inspect_custody_coverage",
		routeTediId: ROUTE_TEDI,
		custodyTediId: ROUTE_TEDI,
		objectId: OBJECT,
		operationId: "coverage",
		expectedGeneration: 1,
	});
	const value = {
		ok: true,
		id: OBJECT,
		targetObjectId: OBJECT,
		operationId: "coverage",
		generation: 1,
		state: "quarantined",
		receiver: "raw-cutover-v1",
		command: "inspect_custody_coverage",
		version: "custody-coverage-metadata-v1",
		coverageHash: HASH,
		sqlMetadataHash: HASH,
		registryHash: HASH,
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
		cutoverOperationFromAdminFetch({ ok: true, status: 200, json: value }, q),
	).toEqual(value);
	for (const change of [
		{ id: "f".repeat(64) },
		{ targetObjectId: "f".repeat(64) },
		{ operationId: "different" },
		{ generation: 2 },
		{ wholePreservationReady: true },
		{ writerExclusionAck: "observed" },
		{ kv: { ...value.kv, complete: true } },
	])
		expect(() =>
			cutoverOperationFromAdminFetch(
				{ ok: true, status: 200, json: { ...value, ...change } },
				q,
			),
		).toThrow();
	expect(() =>
		cutoverOperationFromAdminFetch({ error: "PRIVATE_TRANSPORT" }, q),
	).toThrow();
	getTediById.mockResolvedValue({
		id: ROUTE_TEDI,
		organizationId: "00000000-0000-4000-8000-000000000002",
		isolateAgentId: "original",
		slug: "original",
	});
	transport.mockResolvedValue(Response.json(value));
	expect(await client().operateRuntimeCutover(q)).toEqual(value);
	const [, options] = transport.mock.calls[0]!;
	const body = JSON.parse(options!.body as string);
	expect(body.custody.objectName).toBe("original");
	expect(body.command).toBe(q.command);
	expect(body.routeTediId).toBeUndefined();
	expect(options?.headers).toMatchObject({ "X-Service-Binding": "true" });
	await expect(
		client(
			context({ env: { SECRETS_MASTER_KEY: MASTER } as BaseContext["env"] }),
		).operateRuntimeCutover(q),
	).rejects.toThrow();
});
