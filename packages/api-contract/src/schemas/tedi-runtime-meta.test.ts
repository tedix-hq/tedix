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
