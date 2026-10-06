/**
 * Durable per-user OS settings, and the read-only operational context the
 * settings surface renders beside them.
 *
 * Two halves with deliberately different authorities:
 *
 * 1. **Preferences** — the only thing a settings surface WRITES. Personal
 *    presentation and conversational defaults, persisted in the generic
 *    `user_configs` store under `namespace = "os.preferences"` with the
 *    caller's organization id as the key. Nothing here is policy: a stored
 *    `conversationModelRef` is a request, not a grant, and the runtime's
 *    admission path still decides whether that model may run.
 *
 * 2. **Context** — a read-only projection assembled from the canonical readers
 *    other surfaces already use. It duplicates no source of truth: budgets and
 *    the effective model policy stay owned by `runtimeEntitlements.get`, and
 *    connections stay owned by `connections.getUserConnections`. What lives
 *    here is exactly the state with no existing projection — tenant identity
 *    resolved from the CREDENTIAL, the caller's effective authority on both
 *    authorization planes, and the purpose charter's status.
 */

import * as z from "zod";
import { ModelRefSchema } from "./model-catalog";
import { OrganizationOsThemeSchema } from "./os-theme";

// =============================================================================
// PREFERENCES
// =============================================================================

export const OsThemePreferenceSchema = z.enum(["system", "light", "dark"]);
export type OsThemePreference = z.infer<typeof OsThemePreferenceSchema>;

export const OsDensityPreferenceSchema = z.enum(["comfortable", "compact"]);
export type OsDensityPreference = z.infer<typeof OsDensityPreferenceSchema>;

/**
 * Motion and contrast are TRI-state, not booleans: the OS already honors the
 * `prefers-reduced-motion` / `prefers-contrast` media queries, so "I never
 * chose" and "I explicitly chose the non-reduced option" are different states
 * and collapsing them into `false` would silently override the operating
 * system's own accessibility setting.
 */
export const OsMotionPreferenceSchema = z.enum(["system", "full", "reduced"]);
export type OsMotionPreference = z.infer<typeof OsMotionPreferenceSchema>;

export const OsContrastPreferenceSchema = z.enum(["system", "high"]);
export type OsContrastPreference = z.infer<typeof OsContrastPreferenceSchema>;

function isCanonicalLocale(value: string): boolean {
	try {
		return Intl.getCanonicalLocales(value).length === 1;
	} catch {
		return false;
	}
}

function isResolvableTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/**
 * A real BCP-47 tag, proved by `Intl.getCanonicalLocales` rather than by a
 * regex that would wave `en-ZZZZZZ` through and then break every formatter
 * downstream. Available in every runtime this contract loads in (workerd,
 * Node, browsers).
 */
export const OsLocaleSchema = z
	.string()
	.trim()
	.min(2)
	.max(35)
	.refine(isCanonicalLocale, {
		message: "locale must be a canonical BCP-47 language tag (e.g. `es-MX`)",
	});

/** A real IANA zone, proved by constructing a formatter with it. */
export const OsTimeZoneSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.refine(isResolvableTimeZone, {
		message:
			"timezone must be an IANA time zone identifier (e.g. `America/Mexico_City`)",
	});

/**
 * Deliberately just motion and contrast. A text-scale control was considered
 * and DROPPED: the OS stylesheet sizes in absolute pixels, so no root-level
 * scale would have moved a single glyph, and a toggle that changes nothing is
 * worse than an absent one. Both preferences here are applied by real
 * stylesheet rules keyed on `data-motion` / `data-contrast`.
 */
export const OsAccessibilityPreferencesSchema = z.object({
	motion: OsMotionPreferenceSchema,
	contrast: OsContrastPreferenceSchema,
});
export type OsAccessibilityPreferences = z.infer<
	typeof OsAccessibilityPreferencesSchema
>;

/**
 * Signal subscriptions stored on the user's profile.
 *
 * HONEST SCOPE: these are persisted preferences with NO delivery engine behind
 * them yet — no OS notification centre, no email digest, no push. They are
 * stored so the preference survives, and the surface that renders them says so
 * rather than implying a delivery that does not happen. Wiring a consumer is
 * tracked separately; do not read these as evidence a notification was sent.
 */
export const OsNotificationPreferencesSchema = z.object({
	approvals: z
		.boolean()
		.describe("Approval requests awaiting this operator's decision"),
	runFailures: z.boolean().describe("Runs that terminate in a failed state"),
	budgetAlerts: z
		.boolean()
		.describe("Runtime admission blocks caused by budget or entitlement state"),
});
export type OsNotificationPreferences = z.infer<
	typeof OsNotificationPreferencesSchema
>;

export const OsUserPreferencesSchema = z.object({
	theme: OsThemePreferenceSchema,
	density: OsDensityPreferenceSchema,
	locale: OsLocaleSchema.nullable().describe(
		"Null follows the browser's own locale; the OS never guesses a stored one",
	),
	timezone: OsTimeZoneSchema.nullable().describe(
		"Null follows the browser's resolved zone; the OS never guesses a stored one",
	),
	accessibility: OsAccessibilityPreferencesSchema,
	notifications: OsNotificationPreferencesSchema,
	conversationModelRef: ModelRefSchema.nullable().describe(
		"Preferred model for this operator's own conversations, as `<provider>/<model-id>`. A REQUEST, not a grant: the runtime's admission path still applies the organization and tedi model policy, so a stored ref can be refused at turn time. Null defers to the workspace default.",
	),
});
export type OsUserPreferences = z.infer<typeof OsUserPreferencesSchema>;

/**
 * The preference set a user who never saved anything is treated as holding.
 *
 * Exported so the server, the tests, and the zero-account fixture lane cannot
 * disagree about what "unset" renders as. Every value is a follow-the-system
 * or least-surprising default — none of them assert a choice the user made,
 * which is why the read also reports `source`.
 */
export const DEFAULT_OS_USER_PREFERENCES: OsUserPreferences = {
	theme: "system",
	density: "comfortable",
	locale: null,
	timezone: null,
	accessibility: { motion: "system", contrast: "system" },
	notifications: { approvals: true, runFailures: true, budgetAlerts: true },
	conversationModelRef: null,
};

/**
 * `stored` means these exact values came out of D1. `default` means no row
 * exists and the payload is {@link DEFAULT_OS_USER_PREFERENCES} — the two are
 * kept distinguishable so a surface never reports a default back as the user's
 * choice.
 */
export const OsPreferencesSourceSchema = z.enum(["stored", "default"]);

export const OsUserPreferencesStateSchema = z.object({
	preferences: OsUserPreferencesSchema,
	source: OsPreferencesSourceSchema,
	revision: z
		.number()
		.int()
		.min(0)
		.describe(
			"Compare-and-swap token. 0 means nothing is stored; pass it back as expectedRevision on the next write.",
		),
	updatedAt: z
		.string()
		.nullable()
		.describe("Last write timestamp; null when nothing is stored"),
});
export type OsUserPreferencesState = z.infer<
	typeof OsUserPreferencesStateSchema
>;

// =============================================================================
// OPERATIONAL CONTEXT (READ-ONLY)
// =============================================================================

/**
 * The closed set of tenant RBAC permissions the API's guards evaluate.
 *
 * Mirrors `Permission` in `@tedix/auth/rbac`, which this package cannot import
 * (the dependency runs the other way). `packages/auth/src/rbac.test.ts` asserts
 * the two sets are identical, so a permission added there without being added
 * here fails a test instead of silently disappearing from every projection.
 */
export const OrganizationPermissionSchema = z.enum([
	"apps:create",
	"apps:read",
	"apps:update",
	"apps:delete",
	"tedis:create",
	"tedis:read",
	"tedis:update",
	"tedis:delete",
	"secrets:manage",
	"integrations:manage",
	"api_keys:manage",
	"team:read",
	"team:manage",
	"billing:read",
	"billing:manage",
	"settings:manage",
	"analytics:read",
	"catalog:manage",
	"platform:admin",
	"os:read",
	"os:author",
	"os:run",
	"os:publish",
	"os:approve",
	"os:admin",
]);
export type OrganizationPermission = z.infer<
	typeof OrganizationPermissionSchema
>;

export const OsContextOrganizationSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	slug: z
		.string()
		.describe(
			"Credential-derived slug. Administration deep links MUST be built from this, never from the hostname the shell was served on — every `*.os.tedix.dev` label resolves, so a hostname-derived link can point at a tenant the caller has no membership in.",
		),
	type: z
		.string()
		.describe(
			"`personal` for an auto-created workspace, otherwise `organization`",
		),
	descopeTenantId: z
		.string()
		.nullable()
		.describe(
			"Canonical identity-provider tenant for organization-bound authentication flows; null only for an unmapped legacy organization",
		),
	logoUrl: z
		.string()
		.nullable()
		.describe(
			"Lifecycle: `organizations.logo_url` is nullable and no upload is required at creation, so null means no logo has been set — never a failed read",
		),
	appearance: OrganizationOsThemeSchema.nullable().describe(
		"Published organization appearance profile; null uses the Tedix product theme",
	),
});
export type OsContextOrganization = z.infer<typeof OsContextOrganizationSchema>;

export const OsCallerAuthTypeSchema = z.enum([
	"user",
	"m2m",
	"apikey",
	"tedi",
	"service-binding",
]);

/**
 * The caller's effective authority on BOTH authorization planes, computed with
 * the same predicates the request guards use — not a second interpretation of
 * the token.
 *
 * `permissions` is the human RBAC plane and is empty for machine principals,
 * which are authorized by scope instead; `machineScopes` is the machine plane
 * and is empty for a human session. Empty means "this plane does not apply to
 * this principal", which is why both are reported rather than merged into one
 * flat list that would misrepresent how the caller was actually admitted.
 */
export const OsCallerAuthoritySchema = z.object({
	authType: OsCallerAuthTypeSchema.nullable().describe(
		"Authority: the credential class the guards admitted this request under. Null only when no authentication mode resolved one, which the procedure's guard already refuses — it is never a mode this projection failed to name",
	),
	role: z
		.string()
		.nullable()
		.describe(
			"Membership role resolved for this organization; null when the principal holds no membership row",
		),
	permissions: z.array(OrganizationPermissionSchema),
	machineScopes: z.array(z.string()),
	crossTenantOverrideActive: z
		.boolean()
		.describe(
			"True when org scope came from an `X-Tedix-Tenant-Id` override. The token's own role/permission claims belong to a different tenant and are ignored under it, so `permissions` here reflects the membership role alone.",
		),
});
export type OsCallerAuthority = z.infer<typeof OsCallerAuthoritySchema>;

export const OsPurposeCharterStatusSchema = z.object({
	id: z.uuid(),
	version: z.number().int().positive(),
	status: z.enum(["active", "superseded"]),
	activatedAt: z.string(),
	reviewCadenceDays: z.number().int().positive(),
	reviewDueAt: z
		.string()
		.describe(
			"Derived: `activatedAt` + `reviewCadenceDays`. Not a stored column — the charter carries the cadence, not the due date.",
		),
});

/**
 * Purpose access is a real fork, not a nullable charter.
 *
 * `organizationPurpose.getActive` is guarded by `settings:manage`, while this
 * projection is guarded by the broader OS read pair. A member who legitimately
 * cannot read the charter must be told `restricted`, never handed a `null` that
 * reads as "your organization has no purpose".
 */
export const OsPurposeStatusSchema = z.object({
	access: z.enum(["granted", "restricted"]),
	charter: OsPurposeCharterStatusSchema.nullable().describe(
		"The active charter's status fields. Null with access `granted` means no charter has been authored; null with access `restricted` means it was not read at all.",
	),
});
export type OsPurposeStatus = z.infer<typeof OsPurposeStatusSchema>;

export const OsOperationalContextSchema = z.object({
	organization: OsContextOrganizationSchema,
	authority: OsCallerAuthoritySchema,
	purpose: OsPurposeStatusSchema,
});
export type OsOperationalContext = z.infer<typeof OsOperationalContextSchema>;

export const BrowserMcpAuthorizationSchema = z.object({
	policyVersion: z.literal(1),
	scopes: z.array(z.string()),
});
export type BrowserMcpAuthorization = z.infer<
	typeof BrowserMcpAuthorizationSchema
>;
