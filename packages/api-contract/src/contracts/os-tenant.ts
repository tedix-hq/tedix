import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { SURFACE_SLUG_PATTERN } from "@tedix/tenant-directory";
import * as z from "zod";
import { baseErrors } from "../errors";

/**
 * Internal OS tenant resolution for the `tedix-os` edge Worker.
 *
 * The `*.os.tedix.dev` wildcard DNS record makes every slug resolve, so the
 * origin router must re-establish the fail-closed property per request: only a
 * provisioned organization (`features.os`) may be served the shell.
 *
 * Deliberately slug-keyed — the hostname slug is the only identity the edge
 * has before any session exists. Registered in `contract-routers.ts` ROUTERS
 * for contract/router parity, but listed in the tool-schema-sync
 * UNPROJECTABLE_ROUTERS set so projection can never surface it on an MCP app.
 * Service-binding auth only; this is routing context, never authorization:
 * `apps/api` re-derives the caller's organization on every data request
 * regardless of what hostname served the shell.
 */
export const osTenantContract = oc
	.route({ tags: ["os-tenant", "internal"], prefix: "/os-tenant" })
	.errors(baseErrors)
	.router({
		resolve: oc
			.route({
				method: "POST",
				path: "/resolve",
				summary: "Resolve whether a hostname slug is a provisioned OS tenant",
			})
			.input(
				z.object({
					slug: z
						.string()
						.min(1)
						.max(63)
						.regex(SURFACE_SLUG_PATTERN)
						.describe("The `{slug}.os.tedix.dev` hostname label"),
				}),
			)
			.output(
				z.object({
					provisioned: z.boolean(),
					organizationId: z
						.string()
						.nullable()
						.describe(
							"The provisioned organization id; null when unprovisioned",
						),
					descopeTenantId: z
						.string()
						.nullable()
						.describe(
							"The org's Descope tenant id, for the edge worker to assert as the host-bound tenant on proxied requests (apps/api still proves the caller's membership); null when unprovisioned or unset",
						),
				}),
			),
	});
