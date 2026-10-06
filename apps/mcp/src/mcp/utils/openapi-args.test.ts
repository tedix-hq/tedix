import { describe, expect, it } from "vite-plus/test";
import {
	isExternalOpenApiTool,
	normalizeOpenApiExternalArgs,
} from "./openapi-args";

describe("isExternalOpenApiTool", () => {
	it("matches only external transport + openapi schemaSource", () => {
		expect(
			isExternalOpenApiTool({
				config: { transport: "external" },
				schemaSource: "openapi",
			}),
		).toBe(true);
		expect(
			isExternalOpenApiTool({
				config: { transport: "external" },
				schemaSource: "manual",
			}),
		).toBe(false);
		expect(
			isExternalOpenApiTool({
				config: { transport: "mcp" },
				schemaSource: "openapi",
			}),
		).toBe(false);
		expect(
			isExternalOpenApiTool({ config: null, schemaSource: "openapi" }),
		).toBe(false);
	});
});

describe("normalizeOpenApiExternalArgs", () => {
	it("rounds unsupported OpenAPI page-size limits up to the nearest allowed value", () => {
		const args = normalizeOpenApiExternalArgs(
			{ limit: 5, status: "RUNNING" },
			{
				type: "object",
				properties: {
					limit: {
						default: 10,
						anyOf: [
							{ type: "number", enum: [10] },
							{ type: "number", enum: [20] },
							{ type: "number", enum: [50] },
							{ type: "number", enum: [100] },
							{ type: "string", enum: ["10"] },
							{ type: "string", enum: ["20"] },
							{ type: "string", enum: ["50"] },
							{ type: "string", enum: ["100"] },
						],
					},
					status: {
						anyOf: [
							{ type: "string", enum: ["RUNNING"] },
							{ type: "string", enum: ["STOPPED"] },
						],
					},
				},
				additionalProperties: false,
			},
		);

		expect(args).toEqual({ limit: 10, status: "RUNNING" });
	});

	it("leaves valid page-size choices and semantic enums untouched", () => {
		const args = { limit: 20, status: "BROKEN" };

		expect(
			normalizeOpenApiExternalArgs(args, {
				type: "object",
				properties: {
					limit: {
						anyOf: [
							{ type: "number", enum: [10] },
							{ type: "number", enum: [20] },
						],
					},
					status: {
						anyOf: [
							{ type: "string", enum: ["RUNNING"] },
							{ type: "string", enum: ["STOPPED"] },
						],
					},
				},
			}),
		).toBe(args);
	});
});
