/**
 * Regression: the generated OpenAPI document must equal the explicit external
 * operation manifest. RPC stays the complete backend surface.
 */

import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { describe, expect, it } from "vite-plus/test";
import {
	createPublicOpenApiGenerateOptions,
	stripPublicRestMarker,
} from "./openapi-document";
import { PUBLIC_REST_OPERATIONS } from "./rpc/public-rest-operations";
import { apiRouter } from "./rpc/routers/index";

const HTTP_METHODS = new Set([
	"get",
	"put",
	"post",
	"delete",
	"patch",
	"head",
	"options",
	"trace",
]);

describe("OpenAPI spec generation", () => {
	it("generates exactly the operation-opt-in public contract", async () => {
		const generator = new OpenAPIGenerator({
			converters: [new ZodToJsonSchemaConverter()],
		});

		const spec = (await generator.generate(
			apiRouter,
			createPublicOpenApiGenerateOptions(),
		)) as {
			info: { title: string; version: string };
			externalDocs?: { description?: string; url?: string };
			paths?: Record<
				string,
				Record<
					string,
					{ tags?: string[]; summary?: string; description?: string }
				>
			>;
		};
		stripPublicRestMarker(spec);

		expect(spec.info).toMatchObject({
			title: "Tedix API",
			version: "1.0.0",
		});
		expect(spec.externalDocs).toEqual({
			description: "Tedix API reference",
			url: "https://api.tedix.dev/docs",
		});

		const generatedOperations = Object.entries(spec.paths ?? {}).flatMap(
			([path, pathItem]) =>
				Object.keys(pathItem)
					.filter((method) => HTTP_METHODS.has(method))
					.map((method) => `${method.toUpperCase()} ${path}`),
		);
		expect(generatedOperations.sort()).toEqual(
			[...PUBLIC_REST_OPERATIONS].sort(),
		);

		// Representative stable external resources remain published.
		for (const operation of [
			"GET /apps",
			"POST /organizations",
			"GET /tedis/{tediId}",
			"GET /catalog/apps",
			"GET /organizations/{organizationId}/billing-ledger",
		]) {
			expect(PUBLIC_REST_OPERATIONS.has(operation)).toBe(true);
		}

		// Runtime, credential, governance, secret, and observability internals
		// remain available through RPC/MCP but are absent from REST/OpenAPI.
		for (const privatePath of [
			"/analytics/tool-calls/payloads",
			"/connections/store-api-key",
			"/content/apps/{appId}/sources",
			"/docs/sites",
			"/apps/{appId}/items",
			"/mcp-payments/events",
			"/seo/research-keywords",
			"/submissions",
			"/tedis/{tediId}/auth/rotate-access-key",
			"/tedis/{tediId}/domains",
			"/tedis/{tediId}/logs",
			"/tedis/{tediId}/secrets",
			"/tedis/{tediId}/sessions/state",
			"/tedis/{tediId}/storage/file",
			"/work-items",
		]) {
			expect(spec.paths?.[privatePath]).toBeUndefined();
		}

		// Tags and paths are user-visible API groups. Keep them aligned with the
		// kebab-case REST surface; no compatibility aliases are supported.
		const operations = Object.entries(spec.paths ?? {}).flatMap(
			([path, pathItem]) =>
				Object.entries(pathItem).flatMap(([method, operation]) =>
					HTTP_METHODS.has(method) ? [{ path, method, operation }] : [],
				),
		);
		const operationTags = operations.flatMap(
			({ operation }) => operation.tags ?? [],
		);
		expect(operationTags).not.toContain("REST");
		expect(
			[...new Set(operationTags)].filter((tag) => /[a-z][A-Z]/.test(tag)),
		).toEqual([]);

		// Every supported operation remains useful for generated reference and
		// client discovery.
		expect(
			operations
				.filter(({ operation }) => !operation.summary?.trim())
				.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
		).toEqual([]);
		expect(
			operations
				.filter(({ operation }) => !operation.description?.trim())
				.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
		).toEqual([]);

		// Method migrations remain hard cutovers on retained public resources.
		expect(spec.paths?.["/apps/{appId}/tools/order"]?.put).toBeDefined();
		expect(spec.paths?.["/apps/{appId}/tools/order"]?.post).toBeUndefined();
	});
});
