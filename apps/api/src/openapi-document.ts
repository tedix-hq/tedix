import type { OpenAPIGeneratorGenerateOptions } from "@orpc/openapi";
import { isPublicProcedure, PUBLIC_REST_TAG } from "./rpc/openapi-filter";

/**
 * The spec version this API publishes. oRPC generates 3.2 and downgrades on
 * request; its default moved to `3.2.0` in `@orpc/openapi` 2.0.0-beta.34, so
 * pinning keeps the published document byte-comparable with what beta.23
 * emitted instead of changing the public contract inside a dependency bump.
 */
export const OPENAPI_VERSION = "3.1.2" as const;

export const OPENAPI_SPEC_BASE = {
	info: {
		title: "Tedix API",
		version: "1.0.0",
		description:
			"Multi-tenant AI app platform API. Build AI-powered apps by mapping your API endpoints to MCP tools with pre-built widget layouts.",
		contact: {
			name: "Tedix Support",
			url: "https://tedix.dev",
		},
	},
	servers: [
		{ url: "https://api.tedix.dev/v1", description: "Production" },
		{ url: "http://localhost:8787/v1", description: "Local Development" },
	],
	externalDocs: {
		description: "Tedix API reference",
		url: "https://api.tedix.dev/docs",
	},
} satisfies OpenAPIGeneratorGenerateOptions<typeof OPENAPI_VERSION>["base"];

/**
 * oRPC v2 accepts document metadata under `base`; top-level fields on the
 * generate options object are ignored. Keep this shape shared with the
 * regression test so an upgrade cannot silently restore oRPC's placeholder
 * `API Reference` / `0.0.0` metadata.
 */
export function createPublicOpenApiGenerateOptions(): OpenAPIGeneratorGenerateOptions<
	typeof OPENAPI_VERSION
> {
	return {
		version: OPENAPI_VERSION,
		base: OPENAPI_SPEC_BASE,
		filter: isPublicProcedure,
	};
}

/** Remove the publication marker from the user-visible OpenAPI tag groups. */
export function stripPublicRestMarker(document: unknown): void {
	if (!document || typeof document !== "object") return;
	const paths = (document as { paths?: Record<string, unknown> }).paths;
	if (!paths) return;
	for (const pathItem of Object.values(paths)) {
		if (!pathItem || typeof pathItem !== "object") continue;
		for (const operation of Object.values(pathItem)) {
			if (!operation || typeof operation !== "object") continue;
			const record = operation as { tags?: unknown };
			if (!Array.isArray(record.tags)) continue;
			record.tags = record.tags.filter((tag) => tag !== PUBLIC_REST_TAG);
		}
	}
}

/** oRPC does not generate security schemes, so the endpoint merges these in. */
export const OPENAPI_SECURITY_EXTENSIONS = {
	security: [{ bearerAuth: [] }, { apiKey: [] }],
	components: {
		securitySchemes: {
			bearerAuth: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "JWT",
				description: "Descope JWT token (user or M2M)",
			},
			apiKey: {
				type: "apiKey",
				in: "header",
				name: "X-API-Key",
				description: "Organization-scoped API key (sk_ prefix)",
			},
			tediJwt: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "JWT",
				description:
					"Descope tedi JWT (container → API, exchanged from access key)",
			},
		},
	},
};
