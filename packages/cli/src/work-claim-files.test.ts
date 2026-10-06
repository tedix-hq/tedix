import { describe, expect, test } from "bun:test";
import { withCompletionEvidence } from "@tedix/api-contract/schemas/execution-evidence";
import { claimFiles, fileResourceKeys } from "./work-claim-files";

const ITEM = "11111111-1111-4111-8111-111111111111";
const CURSOR = "22222222-2222-4222-8222-222222222222";
const KEY = "file:tedix:src/a.ts";
const SECOND = "file:tedix:src/b.ts";
const receipt = (
	resources = [{ resourceKey: "api:release", quantity: 2 }],
) => ({
	workItemId: ITEM,
	workItemVersion: 7,
	admissionSpecRevision: "revision-3",
	resources,
	budget: { limitMicros: 100, reservationMicros: 30 },
});
const pool = (resourceKey: string, extra = {}) => ({
	id: CURSOR,
	orgId: ITEM,
	resourceKey,
	allocationMode: "exclusive",
	capacity: 1,
	ownerRef: "existing-owner",
	createdAt: "2026-09-19T00:00:00Z",
	updatedAt: null,
	version: 4,
	...extra,
});
const page = (keys: string[], nextCursor: string | null = null) => ({
	data: keys.map((key) => ({
		pool: pool(key),
		activeReserved: 1,
		effectiveAvailable: 0,
	})),
	nextCursor,
});
const conflict = {
	value: null,
	error: { code: "CONFLICT", status: 409, message: "stale version" },
};

type Input = Record<string, unknown>;
function gateway(
	override?: (
		tool: string,
		input: Input,
	) =>
		| {
				value: unknown;
				error?: { code?: string; status?: number; message: string };
		  }
		| undefined,
) {
	const calls: { tool: string; input: Input }[] = [];
	const call = async (tool: string, input: Input) => {
		calls.push({ tool, input });
		if (tool.endsWith("list_work_resource_pools")) {
			expect(input).toEqual({ resourceKey: expect.any(String), limit: 1 });
		}
		const result = override?.(tool, input);
		if (result) return result;
		if (tool.endsWith("get_work_admission_specification"))
			return { value: receipt() };
		if (tool.endsWith("list_work_resource_pools")) return { value: page([]) };
		if (tool.endsWith("put_work_resource_pool"))
			return { value: pool(String(input.resourceKey)) };
		if (tool.endsWith("replace_work_admission_specification"))
			return {
				value: {
					...receipt(),
					...(input.specification as object),
					workItemVersion: 8,
					admissionSpecRevision: "revision-4",
				},
			};
		throw new Error(`Unexpected call ${tool}`);
	};
	return {
		call,
		calls,
		writes: () => calls.filter(({ tool }) => /put_|replace_/.test(tool)),
	};
}

describe("literal file resource keys", () => {
	test("preserves spaces, order and case while deduplicating exact paths", () => {
		expect(
			fileResourceKeys("tedix", [
				"src/My File.ts",
				"src/a.ts",
				"src/My File.ts",
			]),
		).toEqual(["file:tedix:src/My File.ts", KEY]);
	});
	test.each([
		undefined,
		"",
		"Tedix",
		"../tedix",
		"tedix:app",
		" tedix",
		"tedix--app",
	])("rejects malformed repo key %p", (key) => {
		expect(() => fileResourceKeys(key, ["src/a.ts"])).toThrow();
	});
	test.each([
		"",
		"/src/a",
		"../a",
		"src/../a",
		"./a",
		"src//a",
		"src/",
		"src/./a",
		"C:/a",
		"src\\a",
		"src/*.ts",
		"src/[ab].ts",
		"src/{a,b}.ts",
		"src/a?",
		"a\nb",
		"a\u0000b",
		" a",
		"a ",
		"src/ a",
		"~user/a",
		"cafe\u0301.ts",
	])("rejects ambiguous path %p", (path) => {
		expect(() => fileResourceKeys("tedix", [path])).toThrow();
	});
	test("requires paths and bounds key size and unique resource count", () => {
		expect(() => fileResourceKeys("tedix", [])).toThrow("--path");
		expect(() => fileResourceKeys("tedix", undefined)).toThrow("--path");
		expect(fileResourceKeys("tedix", ["a".repeat(289)])[0]?.length).toBe(300);
		expect(() => fileResourceKeys("tedix", ["a".repeat(290)])).toThrow("300");
		expect(() =>
			fileResourceKeys(
				"tedix",
				Array.from({ length: 101 }, (_, n) => `${n}.ts`),
			),
		).toThrow("100");
		expect(fileResourceKeys("tedix", Array(101).fill("a.ts"))).toHaveLength(1);
	});
});

describe("claim-files admission convenience", () => {
	test("accepts native gateway completionEvidence on get, list, create and replacement responses", async () => {
		const g = gateway();
		const result = await claimFiles(ITEM, [KEY], async (tool, input) => {
			const response = await g.call(tool, input);
			return {
				...response,
				value: withCompletionEvidence(tool, response.value),
			};
		});
		expect(result.error).toBeUndefined();
		expect(result.value).toMatchObject({
			changed: true,
			createdResourceKeys: [KEY],
		});
		expect(result.value?.admission).not.toHaveProperty("completionEvidence");
		expect(result.value?.admission.resources).toEqual([
			...receipt().resources,
			{ resourceKey: KEY, quantity: 1 },
		]);
		expect(g.writes()).toHaveLength(2);
	});

	test("removing gateway enrichment does not loosen unknown admission business fields", async () => {
		for (const extra of [
			{ unexpectedBusinessField: true },
			{
				resources: [{ resourceKey: KEY, quantity: 1, completionEvidence: {} }],
			},
		]) {
			const g = gateway((tool) =>
				tool.endsWith("get_work_admission_specification")
					? { value: withCompletionEvidence(tool, { ...receipt(), ...extra }) }
					: undefined,
			);
			expect((await claimFiles(ITEM, [KEY], g.call)).error).toBeDefined();
			expect(g.writes()).toEqual([]);
		}
	});

	test("replacement receipt still rejects unknown business fields with gateway enrichment", async () => {
		const g = gateway((tool) =>
			tool.endsWith("replace_work_admission_specification")
				? {
						value: withCompletionEvidence(tool, {
							...receipt(),
							unexpectedBusinessField: true,
						}),
					}
				: undefined,
		);
		expect((await claimFiles(ITEM, [KEY], g.call)).error).toMatchObject({
			replacementAttempted: true,
			createdResourceKeys: [KEY],
		});
		expect(g.writes()).toHaveLength(2);
	});

	test("creates only missing pools and preserves resources, quantities, budget, and both CAS values", async () => {
		const g = gateway((tool, input) =>
			tool.endsWith("list_work_resource_pools")
				? { value: page(input.resourceKey === SECOND ? [SECOND] : []) }
				: undefined,
		);
		const result = await claimFiles(ITEM, [KEY, SECOND], g.call);
		expect(result.error).toBeUndefined();
		expect(g.writes()).toEqual([
			{
				tool: "work.put_work_resource_pool",
				input: { resourceKey: KEY, allocationMode: "exclusive", capacity: 1 },
			},
			{
				tool: "work.replace_work_admission_specification",
				input: {
					id: ITEM,
					expectedWorkItemVersion: 7,
					expectedAdmissionSpecRevision: "revision-3",
					specification: {
						resources: [
							...receipt().resources,
							{ resourceKey: KEY, quantity: 1 },
							{ resourceKey: SECOND, quantity: 1 },
						],
						budget: receipt().budget,
					},
				},
			},
		]);
		expect(g.calls.map(({ tool }) => tool)).toEqual([
			"work.get_work_admission_specification",
			"work.list_work_resource_pools",
			"work.list_work_resource_pools",
			"work.put_work_resource_pool",
			"work.replace_work_admission_specification",
		]);
		expect(result.value?.createdResourceKeys).toEqual([KEY]);
		expect(result.value?.reservation).toBe("at_work_start");
	});
	test.each([
		"missing",
		"extra",
		"duplicate",
		"quantity",
		"budget",
		"null-budget",
	])(
		"rejects a replacement receipt with %s specification drift",
		async (drift) => {
			const g = gateway((tool, input) => {
				if (!tool.endsWith("replace_work_admission_specification"))
					return undefined;
				const requested = input.specification as ReturnType<typeof receipt>;
				let resources = requested.resources.map((resource) => ({
					...resource,
				}));
				let budget: typeof requested.budget | null = requested.budget;
				if (drift === "missing") resources = resources.slice(0, -1);
				if (drift === "extra")
					resources.push({ resourceKey: SECOND, quantity: 1 });
				if (drift === "duplicate") resources = [resources[0]!, resources[0]!];
				if (drift === "quantity") resources[0]!.quantity += 1;
				if (drift === "budget") budget = { ...budget, reservationMicros: 31 };
				if (drift === "null-budget") budget = null;
				return { value: { ...receipt(), resources, budget } };
			});
			const result = await claimFiles(ITEM, [KEY], g.call);
			expect(result.value).toBeUndefined();
			expect(result.error?.message).toContain(
				"does not match the requested specification",
			);
			expect(result.error).toMatchObject({
				replacementAttempted: true,
				createdResourceKeys: [KEY],
			});
		},
	);

	test("accepts an exact replacement receipt with reordered resources", async () => {
		const g = gateway((tool, input) => {
			if (!tool.endsWith("replace_work_admission_specification"))
				return undefined;
			const requested = input.specification as ReturnType<typeof receipt>;
			return {
				value: {
					...receipt(),
					...requested,
					resources: [...requested.resources].reverse(),
				},
			};
		});
		expect((await claimFiles(ITEM, [KEY], g.call)).error).toBeUndefined();
	});

	test("an already declared request is read-only and does not invalidate admission approvals", async () => {
		const existing = receipt([{ resourceKey: KEY, quantity: 2 }]);
		const g = gateway((tool) =>
			tool.endsWith("get_work_admission_specification")
				? { value: existing }
				: tool.endsWith("list_work_resource_pools")
					? { value: page([KEY]) }
					: undefined,
		);
		const result = await claimFiles(ITEM, [KEY], g.call);
		expect(result.value?.changed).toBe(false);
		expect(result.value?.admission).toEqual(existing);
		expect(g.calls).toHaveLength(2);
		expect(g.writes()).toEqual([]);
	});
	test("already declared files still reject incompatible pools", async () => {
		const g = gateway((tool) =>
			tool.endsWith("get_work_admission_specification")
				? { value: receipt([{ resourceKey: KEY, quantity: 1 }]) }
				: tool.endsWith("list_work_resource_pools")
					? {
							value: {
								...page([KEY]),
								data: [
									{
										pool: pool(KEY, { capacity: 2 }),
										activeReserved: 0,
										effectiveAvailable: 2,
									},
								],
							},
						}
					: undefined,
		);
		expect((await claimFiles(ITEM, [KEY], g.call)).error?.message).toContain(
			"not exclusive with capacity 1",
		);
		expect(g.writes()).toEqual([]);
	});

	test("repairs a missing pool for an existing requirement without replacing admission", async () => {
		const existing = receipt([{ resourceKey: KEY, quantity: 1 }]);
		const g = gateway((tool) =>
			tool.endsWith("get_work_admission_specification")
				? { value: existing }
				: undefined,
		);
		const result = await claimFiles(ITEM, [KEY], g.call);
		expect(result.value).toMatchObject({
			changed: true,
			addedResourceKeys: [],
			createdResourceKeys: [KEY],
			admission: existing,
		});
		expect(g.writes()).toEqual([
			{
				tool: "work.put_work_resource_pool",
				input: { resourceKey: KEY, allocationMode: "exclusive", capacity: 1 },
			},
		]);
	});

	test("does not create pools when the merged specification exceeds its limit", async () => {
		const g = gateway((tool) =>
			tool.endsWith("get_work_admission_specification")
				? {
						value: receipt(
							Array.from({ length: 100 }, (_, n) => ({
								resourceKey: `other:${n}`,
								quantity: 1,
							})),
						),
					}
				: undefined,
		);
		expect((await claimFiles(ITEM, [KEY], g.call)).error).toBeDefined();
		expect(g.writes()).toEqual([]);
	});
	test("validates the admission receipt and its identity before writes", async () => {
		for (const value of [
			{ ...receipt(), workItemId: CURSOR },
			{ ...receipt(), budget: { limitMicros: 1, reservationMicros: 2 } },
			{ ...receipt(), admissionSpecRevision: "" },
		]) {
			const g = gateway(() => ({ value }));
			expect((await claimFiles(ITEM, [KEY], g.call)).error).toBeDefined();
			expect(g.writes()).toEqual([]);
		}
	});
	test("finds requested keys beyond 800 unrelated pools without enumerating them", async () => {
		const inventory = new Set([
			...Array.from({ length: 801 }, (_, i) => `unrelated:${i}`),
			KEY,
		]);
		const g = gateway((tool, input) =>
			tool.endsWith("list_work_resource_pools")
				? {
						value: page(
							inventory.has(String(input.resourceKey))
								? [String(input.resourceKey)]
								: [],
						),
					}
				: undefined,
		);
		const result = await claimFiles(
			ITEM,
			fileResourceKeys("tedix", ["src/a.ts", "src/a.ts"]),
			g.call,
		);
		expect(result.error).toBeUndefined();
		expect(
			g.calls.filter(({ tool }) => tool.endsWith("list_work_resource_pools")),
		).toEqual([
			{
				tool: "work.list_work_resource_pools",
				input: { resourceKey: KEY, limit: 1 },
			},
		]);
		expect(g.writes().map(({ tool }) => tool)).toEqual([
			"work.replace_work_admission_specification",
		]);
	});
	test.each([
		{},
		{ data: [], nextCursor: undefined },
		{ data: [], nextCursor: CURSOR },
		{ data: [{ pool: pool(KEY) }], nextCursor: null },
		page([], "bad-cursor"),
		page([KEY, KEY]),
		page([SECOND]),
		page([KEY], CURSOR),
	])(
		"rejects incomplete, mismatched or malformed exact lookups without writes: %p",
		async (value) => {
			const g = gateway((tool) =>
				tool.endsWith("list_work_resource_pools") ? { value } : undefined,
			);
			expect((await claimFiles(ITEM, [KEY], g.call)).error).toBeDefined();
			expect(g.writes()).toEqual([]);
		},
	);
	test("a later lookup error prevents creating an earlier missing pool", async () => {
		const g = gateway((tool, input) =>
			tool.endsWith("list_work_resource_pools") && input.resourceKey === SECOND
				? {
						value: null,
						error: { code: "FORBIDDEN", status: 403, message: "read denied" },
					}
				: undefined,
		);
		expect((await claimFiles(ITEM, [KEY, SECOND], g.call)).error).toMatchObject(
			{ code: "FORBIDDEN", replacementAttempted: false },
		);
		expect(g.writes()).toEqual([]);
	});
	test.each([{ allocationMode: "capacity" }, { capacity: 2 }])(
		"refuses incompatible pools before creating any missing pool: %p",
		async (extra) => {
			const g = gateway((tool, input) =>
				tool.endsWith("list_work_resource_pools") &&
				input.resourceKey === SECOND
					? {
							value: {
								...page([SECOND]),
								data: [
									{
										pool: pool(SECOND, extra),
										activeReserved: 0,
										effectiveAvailable: 1,
									},
								],
							},
						}
					: undefined,
			);
			expect(
				(await claimFiles(ITEM, [KEY, SECOND], g.call)).error?.message,
			).toContain("not exclusive with capacity 1");
			expect(g.writes()).toEqual([]);
		},
	);
	test("preserves an existing file quantity when adding another file", async () => {
		const g = gateway((tool, input) =>
			tool.endsWith("get_work_admission_specification")
				? { value: receipt([{ resourceKey: KEY, quantity: 2 }]) }
				: tool.endsWith("list_work_resource_pools")
					? { value: page([String(input.resourceKey)]) }
					: undefined,
		);
		const result = await claimFiles(ITEM, [KEY, SECOND], g.call);
		expect(result.value?.admission.resources).toEqual([
			{ resourceKey: KEY, quantity: 2 },
			{ resourceKey: SECOND, quantity: 1 },
		]);
	});
	test("stops safely on concurrent pool creation and never updates that pool", async () => {
		const g = gateway((tool) =>
			tool.endsWith("put_work_resource_pool") ? conflict : undefined,
		);
		const result = await claimFiles(ITEM, [KEY], g.call);
		expect(result.error).toMatchObject({
			code: "CONFLICT",
			status: 409,
			unconfirmedPoolKey: KEY,
			replacementAttempted: false,
			createdResourceKeys: [],
		});
		expect(g.writes()).toHaveLength(1);
		expect(g.writes()[0]?.input).not.toHaveProperty("expectedVersion");
	});
	test("reports retained pools on a partial failure without cleanup or admission replacement", async () => {
		const g = gateway((tool, input) =>
			tool.endsWith("put_work_resource_pool") && input.resourceKey === SECOND
				? {
						value: null,
						error: {
							code: "FORBIDDEN",
							status: 403,
							message: "owner/admin required",
						},
					}
				: undefined,
		);
		const result = await claimFiles(ITEM, [KEY, SECOND], g.call);
		expect(result.error).toMatchObject({
			code: "FORBIDDEN",
			status: 403,
			createdResourceKeys: [KEY],
			unconfirmedPoolKey: SECOND,
			replacementAttempted: false,
		});
		expect(result.error?.message).toContain("owner/admin required");
		expect(result.error?.message).toContain("Confirmed created pools remain");
		expect(g.writes()).toHaveLength(2);
	});
	test("does not retry stale admission CAS and reports created pools", async () => {
		const g = gateway((tool) =>
			tool.endsWith("replace_work_admission_specification")
				? conflict
				: undefined,
		);
		const result = await claimFiles(ITEM, [KEY], g.call);
		expect(result.error).toMatchObject({
			code: "CONFLICT",
			status: 409,
			createdResourceKeys: [KEY],
			replacementAttempted: true,
		});
		expect(result.error?.message).toContain("re-read before retrying");
		expect(g.writes()).toHaveLength(2);
	});
	test("a malformed creation receipt is not success or a reason to replace admission", async () => {
		const g = gateway((tool) =>
			tool.endsWith("put_work_resource_pool")
				? { value: pool(SECOND) }
				: undefined,
		);
		expect((await claimFiles(ITEM, [KEY], g.call)).error).toMatchObject({
			unconfirmedPoolKey: KEY,
			replacementAttempted: false,
		});
		expect(g.writes()).toHaveLength(1);
	});
});
