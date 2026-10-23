import { describe, expect, test } from "bun:test";
import type { WorkContext, WorkOptions } from "./work";
import { nativeCommands } from "./work-native";
import {
	CREATE_EXCEPTION_CLASSES,
	expiresToIso,
	parseObjectArgument,
	projectArg,
	resolveWorkItemId,
	workCreate,
	workFind,
	workList,
} from "./work-queries";

const ORGANIZATION_ID = "99999999-9999-4999-8999-999999999999";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_A = "aaaaaa11-2222-4333-8444-555555555555";
const ITEM_B = "aaaaaa22-2222-4333-8444-555555555555";

function descriptor(name: string, endpoint: string) {
	return {
		name,
		toolRowId: `row-${name}`,
		endpoint,
		eligible: true,
		authorized: true,
		schemaFreshness: {
			source: "orpc",
			sourceRef: endpoint,
			sourceHash: "fixture-hash",
			syncedAt: "2026-10-22T12:00:00.000Z",
		},
	};
}

function workRow(id: string, title: string, view: "board" | "resolve") {
	return {
		id,
		workKind: "coding",
		disposition: "accepted",
		riskLevel: "medium",
		priority: "medium",
		title,
		projectId: PROJECT_ID,
		createdAt: "2026-10-22T12:00:00.000Z",
		...(view === "board" ? { activeAttempt: null } : {}),
	};
}

function makeContext(
	rows: Array<{ id: string; title: string }> = [],
	work: WorkOptions = {},
) {
	const calls: Record<string, unknown>[] = [];
	const callTool = async (name: string, args: Record<string, unknown>) => {
		if (name === "get_info") {
			return {
				nativeContext: {
					version: 1,
					surface: "mcp-gateway",
					appId: "fixture-app",
					appSlug: "fixture",
					organizationId: ORGANIZATION_ID,
					actor: { authType: "user" },
					nativeTransportAvailable: true,
				},
				nativeCatalog: {
					status: "usable",
					search: descriptor("catalog_search", "catalog/search"),
					describe: descriptor("catalog_describe", "catalog/describe"),
				},
			};
		}

		const callable = `${String(args.namespace)}.${String(args.query)}`;
		const native = descriptor(
			`configured_${callable.replaceAll(".", "__")}`,
			"workItems/listCliProjection",
		);
		if (name === "catalog_search") {
			return {
				results: [{ callable, authorized: true, native, outputSchema: {} }],
			};
		}
		if (name === "catalog_describe") {
			const describedCallable = String(args.callable);
			const describedNative = descriptor(
				`configured_${describedCallable.replaceAll(".", "__")}`,
				"workItems/listCliProjection",
			);
			return {
				callable: describedCallable,
				authorized: true,
				native: describedNative,
				schemaFreshness: describedNative.schemaFreshness,
				parameters: { type: "object", additionalProperties: true },
				outputSchema: {},
			};
		}

		calls.push(args);
		const view = args.view as "board" | "resolve";
		const data = rows.map((row) => workRow(row.id, row.title, view));
		return {
			view,
			data,
			pagination: {
				limit: args.limit,
				offset: args.offset ?? 0,
				total: data.length,
				hasMore: false,
			},
		};
	};

	const client = {
		callTool,
		callToolWithDestructiveApproval: callTool,
		getTimeoutMs: () => 60_000,
	} as unknown as WorkContext["client"];
	const ctx: WorkContext = {
		client,
		color: { enabled: false },
		json: true,
		workspace: "test",
		mcpUrl: "https://fixture.example/mcp",
		organizationId: ORGANIZATION_ID,
		attemptStore: {} as WorkContext["attemptStore"],
		work,
	};
	nativeCommands.set(ctx, {
		protocolSequence: {},
		deadlineAt: Date.now() + 60_000,
	});
	return { ctx, calls };
}

async function captureJson(run: () => Promise<number>) {
	const output: string[] = [];
	const original = console.log;
	console.log = (...values: unknown[]) =>
		output.push(values.map(String).join(" "));
	try {
		const code = await run();
		return { code, output: output.map((line) => JSON.parse(line)) };
	} finally {
		console.log = original;
	}
}

describe("expiresToIso", () => {
	test("normalizes relative and absolute expiries", () => {
		const now = Date.parse("2026-10-22T12:00:00.000Z");
		expect(expiresToIso("30m", now)).toBe("2026-10-22T12:30:00.000Z");
		expect(expiresToIso("2h", now)).toBe("2026-10-22T14:00:00.000Z");
		expect(expiresToIso("1d", now)).toBe("2026-10-23T12:00:00.000Z");
		expect(expiresToIso("2026-11-01T09:30:00Z", now)).toBe(
			"2026-11-01T09:30:00.000Z",
		);
	});

	test("rejects invalid expiries", () => {
		expect(() => expiresToIso("later")).toThrow("--expires");
	});

	test.each(["999999999999d", `${"9".repeat(309)}w`, "100000000d"])(
		"rejects out-of-range relative expiry %s with the validation error",
		(raw) => {
			const now = Date.parse("2026-10-22T12:00:00.000Z");
			expect(() => expiresToIso(raw, now)).toThrow(
				`--expires must be a duration (45m, 72h, 7d) or an ISO datetime, got "${raw}"`,
			);
		},
	);

	test("accepts the maximum date and rejects a duration beyond it", () => {
		expect(expiresToIso("100000000d", 0)).toBe("+275760-09-13T00:00:00.000Z");
		expect(() => expiresToIso("100000001d", 0)).toThrow("--expires");
	});
});

describe("projectArg", () => {
	test("accepts a canonical project id and rejects a project key", () => {
		expect(projectArg(PROJECT_ID)).toEqual({ projectId: PROJECT_ID });
		expect(() => projectArg("example-project")).toThrow(
			"canonical project UUID",
		);
	});
});

describe("resolveWorkItemId", () => {
	test("uses a full id without querying", async () => {
		const { ctx, calls } = makeContext();
		expect(await resolveWorkItemId(ctx, ITEM_A)).toBe(ITEM_A);
		expect(calls).toEqual([]);
	});

	test("resolves one matching prefix", async () => {
		const { ctx, calls } = makeContext([{ id: ITEM_A, title: "Example item" }]);
		expect(await resolveWorkItemId(ctx, "AAAAAA11")).toBe(ITEM_A);
		expect(calls).toEqual([
			expect.objectContaining({ idPrefix: "aaaaaa11", limit: 2 }),
		]);
	});

	test("rejects ambiguous and missing prefixes", async () => {
		const ambiguous = makeContext([
			{ id: ITEM_A, title: "First item" },
			{ id: ITEM_B, title: "Second item" },
		]);
		await expect(resolveWorkItemId(ambiguous.ctx, "aaaaaa")).rejects.toThrow(
			"ambiguous prefix aaaaaa matches 2 items",
		);
		const missing = makeContext();
		await expect(resolveWorkItemId(missing.ctx, "ffffff")).rejects.toThrow(
			"no work item matches prefix ffffff",
		);
	});
});

describe("parseObjectArgument", () => {
	test("parses a JSON object", () => {
		expect(parseObjectArgument('{"enabled":true}', "--input")).toEqual({
			enabled: true,
		});
	});

	test("rejects invalid and non-object JSON", () => {
		expect(() => parseObjectArgument("{", "--input")).toThrow();
		expect(() => parseObjectArgument("[]", "--input")).toThrow(
			"--input must contain one JSON object",
		);
	});
});

describe("query commands", () => {
	test("workCreate rejects a class outside the supported exceptions", async () => {
		const unsupportedClass = "objective";
		expect(CREATE_EXCEPTION_CLASSES.has(unsupportedClass)).toBe(false);
		const { ctx, calls } = makeContext([], {
			workClass: unsupportedClass,
			expires: "1d",
		});
		await expect(workCreate(ctx, "Example work")).rejects.toThrow(
			"--class must be one of maintenance|incident|hygiene",
		);
		expect(calls).toEqual([]);
	});

	test("workFind prints its JSON data envelope", async () => {
		const row = { id: ITEM_A, title: "Example query result" };
		const { ctx } = makeContext([row]);
		const result = await captureJson(() => workFind(ctx, "query result"));
		expect(result.code).toBe(0);
		expect(result.output).toEqual([{ data: [expect.objectContaining(row)] }]);
	});

	test("workList prints the native JSON page", async () => {
		const row = { id: ITEM_A, title: "Example list result" };
		const { ctx } = makeContext([row]);
		const result = await captureJson(() => workList(ctx, ""));
		expect(result.code).toBe(0);
		expect(result.output).toHaveLength(1);
		expect(result.output[0]).toMatchObject({
			data: [row],
			pagination: { limit: 20, offset: 0, total: 1, hasMore: false },
		});
		expect(result.output[0]).not.toHaveProperty("view");
	});
});
