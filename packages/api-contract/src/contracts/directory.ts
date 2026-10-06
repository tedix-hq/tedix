import "@orpc/openapi/extensions/route";
/**
 * Cross-surface workspace directory contract.
 *
 * A caller-scoped read model over the app-level surfaces (OS, MCP, CMS) each of the
 * authenticated user's organizations exposes. It answers the launcher's two
 * questions: "which workspaces can I open, and where does each surface live?"
 *
 * Provisioning is D1-authoritative and fail-closed. `provisionComplete` gates
 * the whole organization on a minted Descope tenant; an org without one renders
 * disabled and is never routed into (every surface reports `provisioned:false`,
 * `canonicalUrl:null`). Each surface's canonical URL and browser handoff URL
 * are built server-side from `@tedix/tenant-directory` so the client never
 * assembles a hostname or session-broker path.
 *
 * Because the underlying per-surface resolvers cache (OS edge 300s, CMS
 * 5min, MCP aggregate ~12min) with no push-purge for the positive TTLs, a
 * just-provisioned surface may report `provisioned:true` here up to those
 * windows before the surface edge itself serves it. This directory is itself
 * D1-live and must not be cached longer than any downstream surface's TTL.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	createPaginatedResponseSchema,
	PaginationSchema,
} from "../schemas/common";

/** An app-level surface in the cross-workspace directory. */
export const DirectorySurfaceSchema = z.enum(["os", "mcp", "cms"]);

export const DirectorySurfaceRecordSchema = z.object({
	surface: DirectorySurfaceSchema,
	provisioned: z
		.boolean()
		.describe(
			"Whether this app-level surface is live for the org per its D1 provision signal. Always false when the org is not provisionComplete.",
		),
	canonicalUrl: z
		.string()
		.nullable()
		.describe(
			"Server-built canonical HTTPS entry point for the surface, or a custom-domain override; null when the surface is not provisioned.",
		),
	handoffUrl: z
		.string()
		.nullable()
		.describe(
			"Server-built browser session-broker entry point for OS and CMS; null for MCP and unprovisioned surfaces.",
		),
	customDomain: z
		.string()
		.optional()
		.describe(
			"Present only when a per-surface custom domain overrides the platform subdomain (MCP customMcpDomain or CMS blogConfig.cmsDomain).",
		),
});

export const DirectoryWorkspaceRecordSchema = z.object({
	org: z.object({
		organizationId: z.string(),
		slug: z.string(),
		name: z.string(),
		descopeTenantId: z
			.string()
			.nullable()
			.describe(
				"The org's minted Descope tenant id; null until provisioning completes, which is exactly what drives provisionComplete.",
			),
		provisionComplete: z
			.boolean()
			.describe(
				"True when the org has a minted Descope tenant (descopeTenantId != null). False orgs are disabled and never routed into.",
			),
	}),
	surfaces: z.array(DirectorySurfaceRecordSchema),
});

export type DirectorySurface = z.infer<typeof DirectorySurfaceSchema>;
export type DirectorySurfaceRecord = z.infer<
	typeof DirectorySurfaceRecordSchema
>;
export type DirectoryWorkspaceRecord = z.infer<
	typeof DirectoryWorkspaceRecordSchema
>;

export const directoryContract = oc
	.route({ tags: ["directory"], prefix: "/directory" })
	.errors(baseErrors)
	.router({
		/**
		 * Enumerate the caller's own active memberships as directory records.
		 * RPC-only launcher projection scoped strictly to `user.sub`; the caller
		 * supplies no organization id.
		 */
		listMyWorkspaces: oc
			.route({
				summary: "List my workspaces and their provisioned surfaces",
				description:
					"Enumerate every organization the current user is an active member of, each with its D1-provisioned app-level surfaces (OS, MCP, CMS) and server-built canonical URLs, for the tenant-neutral launcher.",
			})
			.input(PaginationSchema)
			.output(createPaginatedResponseSchema(DirectoryWorkspaceRecordSchema)),

		/**
		 * Resolve a single workspace the caller belongs to. Takes a UUID (never a
		 * slug) and binds the caller's membership before returning; a non-member
		 * or unknown org resolves to null (fail closed).
		 */
		resolveWorkspace: oc
			.route({
				summary: "Resolve one of my workspaces and its surfaces",
				description:
					"Resolve a single organization the current user is an active member of to its provisioned surfaces and canonical URLs; returns null when the caller is not an active member of the given organization.",
			})
			.input(
				z.object({
					organizationId: z
						.string()
						.uuid()
						.describe("The target organization UUID (never a slug)."),
				}),
			)
			.output(DirectoryWorkspaceRecordSchema.nullable()),
	});
