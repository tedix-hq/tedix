import "@orpc/openapi/extensions/route";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	BrowserMcpAuthorizationSchema,
	OsOperationalContextSchema,
	OsUserPreferencesSchema,
	OsUserPreferencesStateSchema,
} from "../schemas/user-settings";

/**
 * Per-user OS settings: durable preferences the operator owns, plus the
 * read-only operational context the settings surface renders around them.
 *
 * WRITE SURFACE IS DELIBERATELY TINY. The only thing this contract mutates is
 * the caller's own preference row. Billing, membership and secrets are NOT
 * duplicated here — those stay in `billing`, `members`/`tenantMembership` and
 * `secrets`/`tediSecrets`; their policy-checked OS admin routes remain canonical.
 * Budgets and the effective model policy are likewise not re-derived:
 * `runtimeEntitlements.get` already projects exactly what the admission path
 * enforces, and connections are owned by `connections.getUserConnections`.
 * Rebuilding either here would create a second source of truth that drifts.
 *
 * Preferences are stored per user PER ORGANIZATION. The row key is the
 * caller's credential-resolved organization, so a member of several tenants
 * gets an independent set in each — which also matches today's behavior, where
 * the theme lives in per-origin `localStorage` on a `{slug}.os.tedix.dev` host.
 */

const preferencesConflictErrors = {
	CONFLICT: {
		message: "Preference revision conflict",
		data: z
			.object({
				expectedRevision: z.number().int(),
				currentRevision: z
					.number()
					.int()
					.nullable()
					.describe(
						"Revision the store actually holds at conflict time; null when no row exists",
					),
			})
			.optional()
			.describe(
				"Present when the expectedRevision compare-and-swap lost against a concurrent write — a second tab, or another harness saving the same profile",
			),
	},
} as const;

export const userSettingsContract = oc
	.route({ tags: ["user-settings"], prefix: "/user-settings" })
	.errors(baseErrors)
	.router({
		getPreferences: oc
			.route({
				method: "GET",
				path: "/preferences",
				summary: "Get the caller's stored OS preferences",
				description:
					'Reads the caller\'s preference row for the credential-resolved organization. When nothing is stored the platform defaults are returned with `source: "default"` and `revision: 0`, so a surface can tell an unset profile from one deliberately saved with default values.',
			})
			.input(z.object({}))
			.output(OsUserPreferencesStateSchema),

		updatePreferences: oc
			.route({
				method: "PUT",
				path: "/preferences",
				summary: "Replace the caller's OS preferences",
				description:
					"Replaces the complete preference object using its previously read `revision`. Omitted keys are cleared, not merged. A failed compare-and-swap returns CONFLICT with the current revision and writes nothing. `expectedRevision: 0` creates a row and refuses to overwrite an existing row.",
			})
			.errors(preferencesConflictErrors)
			.input(
				z.object({
					preferences: OsUserPreferencesSchema,
					expectedRevision: z
						.number()
						.int()
						.min(0)
						.describe(
							"The revision returned by getPreferences. 0 creates the row.",
						),
				}),
			)
			.output(OsUserPreferencesStateSchema),

		getContext: oc
			.route({
				method: "GET",
				path: "/context",
				summary: "Get the caller's read-only operational context",
				description:
					"Tenant identity resolved from the CREDENTIAL (never from the hostname that served the shell), the caller's effective authority on both authorization planes computed with the same predicates the request guards use, and the purpose charter's status. Purpose reports `restricted` rather than null when the caller lacks the charter's own read permission, so 'no charter' and 'not allowed to look' stay distinguishable. Budgets, the effective model policy and connections are intentionally absent — read `runtimeEntitlements.get` and `connections.getUserConnections` for those.",
			})
			.input(z.object({}))
			.output(OsOperationalContextSchema),

		getBrowserMcpAuthorization: oc
			.route({
				method: "GET",
				path: "/browser-mcp-authorization",
				summary: "Resolve browser MCP capabilities for this tenant session",
				description:
					"Returns the versioned, granular MCP capability set derived from the caller's effective tenant permissions. It never returns wildcard or platform authority and is re-evaluated for every browser relay call.",
			})
			.input(z.object({}))
			.output(BrowserMcpAuthorizationSchema),
	});

export type UserSettingsContract = typeof userSettingsContract;
