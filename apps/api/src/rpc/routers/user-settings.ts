/**
 * Per-user OS settings: the one durable preference write the OS surface owns,
 * plus the read-only operational context it renders around it.
 *
 * Two rules this handler exists to hold:
 *
 * 1. **One store.** Preferences live in the pre-existing generic `user_configs`
 *    table (migrated, relation-mapped, OSS-classified `tenant-product`, and
 *    until now uncalled) — not a second preference table. The row is keyed by
 *    the caller's credential-resolved organization, so preferences are
 *    per-user PER TENANT, matching the per-origin `localStorage` behavior the
 *    OS shell already had on `{slug}.os.tedix.dev`.
 *
 * 2. **No second source of truth.** The context read projects only state that
 *    has no existing projection. Budgets and the effective model policy are
 *    `runtimeEntitlements.get`'s job; connections are
 *    `connections.getUserConnections`'s. Authority is not re-interpreted here
 *    either — it is computed with `userHoldsPermission`/`hasRequiredScope`,
 *    the exact predicates the request guards run.
 */

import { ORPCError, implement } from "@orpc/server";
import { userSettingsContract } from "@tedix/api-contract/contracts/user-settings";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { McpGranularCapabilityScopeName } from "@tedix/api-contract/schemas/mcp-capability-scopes";
import {
	DEFAULT_OS_USER_PREFERENCES,
	type OsCallerAuthority,
	type OsPurposeStatus,
	type OsUserPreferences,
	OsUserPreferencesSchema,
} from "@tedix/api-contract/schemas/user-settings";
import { OrganizationOsThemeSchema } from "@tedix/api-contract/schemas/os-theme";
import { ALL_PERMISSIONS, type Permission } from "@tedix/auth/rbac";
import { getActivePurposeCharter } from "@tedix/db/queries/organization-purpose";
import {
	getOrganizationOsTheme,
	getOrganizationProfile,
} from "@tedix/db/queries/organizations";
import { getUserConfig, putUserConfig } from "@tedix/db/queries/user-configs";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	hasRequiredScope,
	userHoldsPermission,
	withAuth,
} from "../orpc";

const os = implement(userSettingsContract).$context<BaseContext>();

/**
 * Namespace for the OS preference row. The unique key is
 * `(user_id, namespace, key)` and the KEY carries the organization id, which
 * is what binds a preference row to a tenant: both the read and the write
 * resolve it from `requireOrgId(context)`, never from input, so a caller can
 * only ever touch preferences for an organization their credential already
 * scopes them to.
 */
const OS_PREFERENCES_NAMESPACE = "os.preferences";

/**
 * The stable Tedix user id, and ONLY that.
 *
 * `user_configs.user_id` joins `users` (relations/tenancy.ts), so the canonical
 * id resolved from the principal-identity mapping is the correct key. Falling
 * back to the Descope `sub` when the mapping has not resolved would key a
 * second row for the same human and silently split their preferences the day
 * the mapping appeared. A machine principal, which holds no user identity at
 * all, is refused outright.
 */
function requirePreferenceUserId(context: BaseContext): string {
	if (context.userId) return context.userId;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"OS preferences belong to a Tedix user identity; this credential resolves none",
	);
}

/**
 * Machine-plane scopes as the guards see them. A human session is authorized
 * on the permission plane instead, so it reports none here rather than an
 * invented wildcard.
 */
function machineScopes(context: BaseContext): string[] {
	switch (context.authType) {
		case "apikey":
			return [...(context.apiKey?.scopes ?? [])];
		case "m2m":
			return context.serviceAccount?.scope?.split(/\s+/).filter(Boolean) ?? [];
		case "tedi":
			return [...(context.tediScopes ?? [])];
		case "service-binding":
			// A trusted service binding short-circuits `hasRequiredScope` entirely;
			// it holds no enumerable scope list, and printing one would be fiction.
			return [];
		default:
			return [];
	}
}

export function callerAuthority(context: BaseContext): OsCallerAuthority {
	const isUser = context.authType === "user";
	return {
		authType: context.authType ?? null,
		role: context.userRole ?? null,
		permissions: isUser
			? ALL_PERMISSIONS.filter((permission) =>
					userHoldsPermission(context, permission),
				)
			: [],
		machineScopes: machineScopes(context),
		crossTenantOverrideActive: context.crossTenantOverrideActive === true,
	};
}

/**
 * Explicit, versioned human-permission -> browser MCP capability policy.
 *
 * This is deliberately not a role mapping: every entry is evaluated through
 * `userHoldsPermission`, the same tenant-aware predicate used by API guards.
 * A browser session receives only these named tenant capabilities, never a
 * wildcard, and the MCP edge still resolves the exact scopes required by each
 * tool on every call.
 */
const BROWSER_MCP_PERMISSION_POLICY = {
	"mcp:tedis.read": ["tedis:read"],
	"mcp:tedis.write": ["tedis:update", "tedis:create"],
	"mcp:apps.read": ["apps:read"],
	"mcp:apps.write": ["apps:update", "apps:create"],
	"mcp:memory.read": ["tedis:read"],
	"mcp:memory.write": ["tedis:update"],
	"mcp:memory.admin": ["os:approve", "settings:manage"],
	"mcp:skills.read": ["tedis:read"],
	"mcp:skills.write": ["tedis:update"],
	"mcp:content.read": ["apps:read"],
	"mcp:content.write": ["apps:update"],
	"mcp:catalog.read": ["apps:read"],
	"mcp:catalog.write": ["apps:update", "catalog:manage"],
	"mcp:observe.read": ["analytics:read"],
	"mcp:messaging.read": ["tedis:read"],
	"mcp:messaging.write": ["tedis:update"],
	"mcp:settings.read": ["settings:manage"],
	"mcp:settings.write": ["settings:manage"],
	"mcp:settings.admin": ["settings:manage"],
	"mcp:work.read": ["os:read", "settings:manage"],
	"mcp:work.write": ["os:author", "os:run", "settings:manage"],
	"mcp:work.admin": ["os:admin", "os:approve", "settings:manage"],
} as const satisfies Partial<
	Record<McpGranularCapabilityScopeName, readonly Permission[]>
>;

export function browserMcpAuthorization(context: BaseContext): {
	policyVersion: 1;
	scopes: McpGranularCapabilityScopeName[];
} {
	if (context.authType !== "user") return { policyVersion: 1, scopes: [] };
	return {
		policyVersion: 1,
		scopes: Object.entries(BROWSER_MCP_PERMISSION_POLICY)
			.filter(([, permissions]) =>
				permissions.some((permission) =>
					userHoldsPermission(context, permission),
				),
			)
			.map(([scope]) => scope as McpGranularCapabilityScopeName),
	};
}

const DAY_MS = 86_400_000;

/**
 * `activatedAt` + `reviewCadenceDays`. The charter stores the cadence, not a
 * due date, so this is derived — and derived only from fields the row actually
 * carries.
 */
function reviewDueAt(activatedAt: string, cadenceDays: number): string {
	const activated = Date.parse(activatedAt);
	if (Number.isNaN(activated)) return activatedAt;
	return new Date(activated + cadenceDays * DAY_MS).toISOString();
}

/**
 * The purpose charter is guarded by `settings:manage` on its own router, while
 * this projection is guarded by the broader OS read pair. Rather than widening
 * that boundary, a caller who cannot read the charter is told `restricted` —
 * so "no charter authored" and "not allowed to look" never collapse into the
 * same null.
 */
async function purposeStatus(
	context: BaseContext,
	organizationId: string,
): Promise<OsPurposeStatus> {
	const permitted =
		context.authType === "user"
			? userHoldsPermission(context, "settings:manage")
			: hasRequiredScope(context, "apps:read");
	if (!permitted) return { access: "restricted", charter: null };

	const charter = await getActivePurposeCharter(context.db, organizationId);
	if (!charter) return { access: "granted", charter: null };
	return {
		access: "granted",
		charter: {
			id: charter.id,
			version: charter.version,
			status: charter.status,
			activatedAt: charter.activatedAt,
			reviewCadenceDays: charter.reviewCadenceDays,
			reviewDueAt: reviewDueAt(charter.activatedAt, charter.reviewCadenceDays),
		},
	};
}

/**
 * A stored row is validated on the way OUT, not trusted. `user_configs.value`
 * is an untyped JSON bag, so a row written before a schema change (or by any
 * other namespace user) must not be able to hand a malformed preference set to
 * the client. An unparseable row falls back to the defaults and reports
 * `source: "default"`, which is the truth: nothing usable is stored.
 */
function parseStoredPreferences(value: unknown): OsUserPreferences | null {
	const parsed = OsUserPreferencesSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

const getPreferences = os.getPreferences
	.use(withAuth)
	.use(AUTHZ.osRead)
	.handler(async ({ context }) => {
		const organizationId = requireOrgId(context);
		const userId = requirePreferenceUserId(context);
		const row = await getUserConfig(context.db, {
			userId,
			namespace: OS_PREFERENCES_NAMESPACE,
			key: organizationId,
		});
		const stored = row ? parseStoredPreferences(row.value) : null;
		if (!row || !stored) {
			return {
				preferences: DEFAULT_OS_USER_PREFERENCES,
				source: "default" as const,
				revision: row?.revision ?? 0,
				updatedAt: row?.updatedAt ?? null,
			};
		}
		return {
			preferences: stored,
			source: "stored" as const,
			revision: row.revision,
			updatedAt: row.updatedAt ?? null,
		};
	});

const updatePreferences = os.updatePreferences
	.use(withAuth)
	.use(AUTHZ.osRead)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const userId = requirePreferenceUserId(context);
		const result = await putUserConfig(context.db, {
			userId,
			namespace: OS_PREFERENCES_NAMESPACE,
			key: organizationId,
			// The contract's zod parse already stripped unknown keys, so the value
			// reaching D1 is exactly the declared preference shape.
			value: input.preferences as unknown as Record<string, JsonValue>,
			expectedRevision: input.expectedRevision,
		});
		if (!result.ok) {
			throw new ORPCError("CONFLICT", {
				message:
					"Preference revision compare-and-swap lost against a concurrent write",
				data: {
					expectedRevision: input.expectedRevision,
					currentRevision: result.currentRevision,
				},
			});
		}
		return {
			preferences: input.preferences,
			source: "stored" as const,
			revision: result.row.revision,
			updatedAt: result.row.updatedAt ?? null,
		};
	});

const getContext = os.getContext
	.use(withAuth)
	.use(AUTHZ.osRead)
	.handler(async ({ context }) => {
		const organizationId = requireOrgId(context);
		const [organization, appearance, purpose] = await Promise.all([
			getOrganizationProfile(context.db, organizationId),
			getOrganizationOsTheme(context.db, organizationId),
			purposeStatus(context, organizationId),
		]);
		if (!organization) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"The credential's organization no longer exists",
			);
		}
		const parsedAppearance = OrganizationOsThemeSchema.safeParse(appearance);
		return {
			organization: {
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				type: organization.type,
				descopeTenantId: organization.descopeTenantId,
				logoUrl: organization.logoUrl,
				appearance: parsedAppearance.success ? parsedAppearance.data : null,
			},
			authority: callerAuthority(context),
			purpose,
		};
	});

const getBrowserMcpAuthorization = os.getBrowserMcpAuthorization
	.use(withAuth)
	.use(AUTHZ.osRead)
	.handler(({ context }) => browserMcpAuthorization(context));

export const userSettingsContractRouter = os.router({
	getPreferences,
	updatePreferences,
	getContext,
	getBrowserMcpAuthorization,
});
