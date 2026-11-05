import { describe, expect, it } from "vite-plus/test";
import {
	readResponseFields,
	selectResponseFields,
	withFieldSelectionSchema,
	fieldSelectionSources,
} from "./field-selection";
import {
	jsonSchemaToInputSchema,
	jsonSchemaToOutputSchema,
} from "./utils/schema";
import { ToolHandler, type ToolExecutionContext } from "./handler";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";

describe("reserved response field selection", () => {
	it("selects nested paths across arrays and omits missing paths", () => {
		const data = {
			data: [
				{ id: "1", title: "one", owner: { name: "A", secret: true } },
				{ id: "2", title: "two" },
			],
			pagination: { total: 2 },
		};
		expect(
			selectResponseFields(data, ["data.id", "data.owner.name", "absent"]),
		).toEqual({ data: [{ id: "1", owner: { name: "A" } }, { id: "2" }] });
		expect(data.data[0]?.owner?.secret).toBe(true);
		expect(selectResponseFields(data, [])).toEqual({});
		expect(selectResponseFields(data, ["absent"])).toEqual({});
		expect(
			selectResponseFields({ owner: { id: 1 }, id: "1" }, [
				"owner.missing",
				"id.missing",
			]),
		).toEqual({});
	});
	it("merges overlapping paths and handles nested arrays and nulls", () => {
		expect(
			selectResponseFields(
				{ rows: [[{ id: 1, extra: true }]], nullable: null },
				["rows.id", "nullable"],
			),
		).toEqual({ rows: [[{ id: 1 }]], nullable: null });
		expect(selectResponseFields({ a: { b: 1, c: 2 } }, ["a.b", "a"])).toEqual({
			a: { b: 1, c: 2 },
		});
	});
	it.each([
		null,
		"id",
		[1],
		[""],
		["a..b"],
		["__proto__.polluted"],
		["constructor.x"],
	])("rejects invalid selectors: %j", (fields) => {
		expect(() => readResponseFields({ _fields: fields })).toThrow("_fields");
	});
	it("advertises and retains the reserved input without changing the source schema", async () => {
		const original = {
			type: "object" as const,
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		};
		const presented = withFieldSelectionSchema(original);
		expect(original.properties).not.toHaveProperty("_fields");
		expect(presented.properties?._fields).toMatchObject({ type: "array" });
		const validated = await jsonSchemaToInputSchema(presented, {
			toolId: "read",
			lenient: false,
		})["~standard"].validate({ id: "a", _fields: ["data.id"] });
		expect(validated).toEqual({ value: { id: "a", _fields: ["data.id"] } });
	});
	it("strips _fields before upstream RPC dispatch", async () => {
		let observed: Record<string, unknown> | undefined;
		const ctx = {
			appId: "example-app",
			app: { organizationId: "example-org" },
			toolId: "list_rows",
			config: {
				transport: "rpc",
				endpoint: "rows/list",
				allowExplicitAppId: true,
				allowExplicitTediId: true,
			},
			env: {
				API_URL: "https://api.example",
				API_SERVICE: {
					fetch: async (request: Request) => {
						observed = (
							(await request.json()) as { json: Record<string, unknown> }
						).json;
						return Response.json({ json: { data: [] } });
					},
				},
			},
		} as unknown as ToolExecutionContext<ToolConfig>;
		await new ToolHandler().execute(
			{ query: "work", _fields: ["data.id"] },
			ctx,
		);
		expect(observed).toMatchObject({ query: "work" });
		expect(observed).not.toHaveProperty("_fields");
	});
	it("keeps strict union input branches intact with reserved fields", async () => {
		const schema = withFieldSelectionSchema({
			type: "object",
			oneOf: [
				{
					properties: { id: { type: "string" } },
					required: ["id"],
					additionalProperties: false,
				},
			],
		});
		const validate = jsonSchemaToInputSchema(schema, {
			toolId: "union",
			lenient: false,
		})["~standard"].validate;
		expect(await validate({ id: "a", _fields: ["data.id"] })).toEqual({
			value: { id: "a", _fields: ["data.id"] },
		});
		expect(
			(await validate({ id: 1, _fields: ["data.id"] })).issues,
		).toBeDefined();
	});
	it("validates the full source for SDK output validation of selected results", async () => {
		const schema = jsonSchemaToOutputSchema({
			type: "object",
			properties: { id: { type: "string" }, title: { type: "string" } },
			required: ["id", "title"],
			additionalProperties: false,
		})!;
		const selected = { id: "a" };
		fieldSelectionSources.set(selected, { id: "a", title: "A" });
		expect(await schema["~standard"].validate(selected)).toEqual({
			value: selected,
		});
		expect(
			(await schema["~standard"].validate({ id: "a" })).issues,
		).toBeDefined();
		fieldSelectionSources.set(selected, { id: "a", title: 42 });
		expect((await schema["~standard"].validate(selected)).issues).toBeDefined();
	});
});
