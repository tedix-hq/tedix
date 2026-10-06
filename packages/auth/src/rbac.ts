/**
 * @tedix/auth - RBAC Utilities
 * Permission and role checking for Descope JWT tokens
 *
 * Descope JWTs carry `roles`/`permissions` as flat arrays already scoped to
 * the current tenant (`dct`), so no per-tenant lookup is needed here.
 *
 * ## Descope owns the role model. This file is not its definition.
 *
 * Descope is the source of truth for roles, permissions and the
 * user→tenant→role assignment graph, and it mints the claims every API guard
 * authorizes against. Descope's own guidance draws the line: "Your app enforces
 * the JWT. Descope authenticates the user and puts tenant membership and roles
 * in the token. Your backend decides what that allows." We are the enforcement
 * point, not the registry.
 *
 * `ROLE_PERMISSION_GRANTS` therefore does two NARROW jobs, and neither is
 * "define what a role means":
 *
 *  1. **Baseline.** `bun descope:rbac-sync` provisions this map INTO Descope so
 *     a project always has the roles Tedix ships. The sync is superset-safe and
 *     never removes, so a role edited in the Console — or created by a tenant
 *     admin in the embedded Role Management widget — survives it untouched.
 *  2. **Fallback.** `userHoldsPermission` prefers the JWT's own `permissions`
 *     claim and only consults this map through the D1 membership role when the
 *     token does not carry one. That path is load-bearing: not every principal
 *     receives a permissions claim, and under a cross-tenant override token
 *     claims are deliberately distrusted.
 *
 * So adding a permission here does NOT grant it until Descope has it. Run the
 * sync, and check `controlPlane.getDescopeRbacDrift` (surfaced on Roles &
 * permissions) to confirm — that endpoint exists precisely because this file
 * and Descope can silently disagree.
 *
 * `ALL_PERMISSIONS` is the one thing that genuinely belongs in code: a
 * permission is a name guards are written against, and the Role Management
 * widget can compose roles only from permissions we pre-define. A ROLE is just
 * a named bundle a tenant may shape; a PERMISSION is an API contract.
 */

// All permissions using resource:action format (registered in Descope)
export type Permission =
	| "apps:create"
	| "apps:read"
	| "apps:update"
	| "apps:delete"
	| "tedis:create"
	| "tedis:read"
	| "tedis:update"
	| "tedis:delete"
	| "secrets:manage"
	| "integrations:manage"
	| "api_keys:manage"
	| "team:read"
	| "team:manage"
	| "billing:read"
	| "billing:manage"
	| "settings:manage"
	| "analytics:read"
	| "catalog:manage"
	| "platform:admin"
	// Tedix OS verbs (least privilege; every OS guard also accepts
	// settings:manage, so admins keep working before roles carry these).
	| "os:read"
	| "os:author"
	| "os:run"
	| "os:publish"
	| "os:approve"
	| "os:admin";

export type Role =
	| "owner"
	| "admin"
	| "member"
	| "viewer"
	| "platform-admin"
	| "catalog-operator"
	| "tedi";

const READ_PERMISSIONS = [
	"apps:read",
	"tedis:read",
	"team:read",
	"analytics:read",
] as const satisfies readonly Permission[];

/**
 * The six least-privilege OS verbs. Admin-grade roles hold all of them
 * EXPLICITLY rather than relying on the `settings:manage` half of each guard's
 * `anyOf` pair — so removing that backward-compat pairing later cannot silently
 * strip OS access from a role Descope still grants.
 */
const OS_PERMISSIONS = [
	"os:read",
	"os:author",
	"os:run",
	"os:publish",
	"os:approve",
	"os:admin",
] as const satisfies readonly Permission[];

const ADMIN_PERMISSIONS = [
	...READ_PERMISSIONS,
	"apps:create",
	"apps:update",
	"apps:delete",
	"tedis:create",
	"tedis:update",
	"tedis:delete",
	"secrets:manage",
	"integrations:manage",
	"api_keys:manage",
	"team:manage",
	"billing:read",
	"settings:manage",
	...OS_PERMISSIONS,
] as const satisfies readonly Permission[];

export const ROLE_PERMISSION_GRANTS: Record<Role, readonly Permission[]> = {
	owner: [...ADMIN_PERMISSIONS, "billing:manage"],
	admin: ADMIN_PERMISSIONS,
	// OS verbs: members do daily OS work (read/author/run) without
	// settings administration; approval/publish/destroy stay admin-tier
	// (admins pass every OS guard via settings:manage in the anyOf pairs).
	// This local mirror is LOAD-BEARING on tenant OS hosts: the host-binding
	// proxy asserts a tenant override, under which token claims are
	// distrusted and only the membership role authorizes.
	member: [...READ_PERMISSIONS, "os:read", "os:author", "os:run"],
	viewer: ["apps:read", "tedis:read", "analytics:read", "os:read"],
	// platform-admin holds no `settings:manage`, so before the OS verbs existed
	// it was locked out of the Tedix OS entirely. The OS grant is what gives it
	// access, not a redundancy.
	"platform-admin": ["platform:admin", "catalog:manage", ...OS_PERMISSIONS],
	"catalog-operator": ["catalog:manage"],
	// A tedi identity holds no human RBAC permissions — it is authorized via
	// capability scopes + Descope FGA, not ROLE_PERMISSION_GRANTS.
	tedi: [],
};

/**
 * Every tenant permission the guards can evaluate, as a runtime value.
 *
 * `Permission` is a type union and therefore erased, so anything that has to
 * ENUMERATE the permission space — an operator projection of the caller's
 * effective authority, for instance — had no list to iterate. `satisfies`
 * proves each entry is a real permission; `rbac.test.ts` proves none is
 * missing, in both directions, against the contract's mirror enum.
 */
export const ALL_PERMISSIONS = [
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
] as const satisfies readonly Permission[];

// =============================================================================
// PRESENTATION CATALOG
// =============================================================================

/**
 * Why this lives HERE and not in `@tedix/api-contract`.
 *
 * The permission model already has exactly one hand-mirrored copy on the wire
 * (`OrganizationPermissionSchema`), which exists only because api-contract
 * cannot import this package — the dependency runs the other way — and which a
 * both-directions test pins to `ALL_PERMISSIONS`. Descriptions are static build
 * -time data, so a SECOND mirror would buy nothing and add another surface that
 * can silently disagree with the guards. Apps that render authority import
 * `@tedix/auth/rbac` directly (this module has no imports and is pure data plus
 * pure functions, so it tree-shakes into a browser bundle cleanly).
 *
 * The product invariant this enables: a surface that shows a capability must
 * describe a permission the guards ACTUALLY evaluate. Before this catalog, the
 * Dashboard rendered its own unrelated 8-boolean model, so the Roles page could
 * advertise access the API would deny.
 */

/** Coarse grouping used to order and section a rendered permission matrix. */
export const PERMISSION_GROUPS = [
	"apps",
	"tedis",
	"os",
	"team",
	"billing",
	"platform",
] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export interface PermissionMetadata {
	/** Short human label, sentence case, no trailing period. */
	label: string;
	/** One sentence describing what holding this permission lets you do. */
	description: string;
	group: PermissionGroup;
}

export const PERMISSION_METADATA: Record<Permission, PermissionMetadata> = {
	"apps:create": {
		label: "Create apps",
		description: "Create new MCP apps in the organization.",
		group: "apps",
	},
	"apps:read": {
		label: "View apps",
		description: "View apps, their tools, and their configuration.",
		group: "apps",
	},
	"apps:update": {
		label: "Edit apps",
		description: "Change app configuration, tools, and widgets.",
		group: "apps",
	},
	"apps:delete": {
		label: "Delete apps",
		description: "Permanently delete an app and its configuration.",
		group: "apps",
	},
	"tedis:create": {
		label: "Create tedis",
		description: "Provision new digital workers.",
		group: "tedis",
	},
	"tedis:read": {
		label: "View tedis",
		description: "View digital workers, their memory, and their activity.",
		group: "tedis",
	},
	"tedis:update": {
		label: "Edit tedis",
		description:
			"Change a digital worker's configuration, skills, and budgets.",
		group: "tedis",
	},
	"tedis:delete": {
		label: "Delete tedis",
		description: "Decommission a digital worker.",
		group: "tedis",
	},
	"secrets:manage": {
		label: "Manage secrets",
		description: "Store and rotate credentials the organization's apps use.",
		group: "apps",
	},
	"integrations:manage": {
		label: "Manage integrations",
		description: "Connect, configure, and disconnect third-party providers.",
		group: "apps",
	},
	"api_keys:manage": {
		label: "Manage API keys",
		description: "Mint, rotate, and revoke organization API keys.",
		group: "team",
	},
	"team:read": {
		label: "View team",
		description: "View organization members and their roles.",
		group: "team",
	},
	"team:manage": {
		label: "Manage team",
		description: "Invite, remove, and change the role of a member.",
		group: "team",
	},
	"billing:read": {
		label: "View billing",
		description: "View subscription, usage, and invoices.",
		group: "billing",
	},
	"billing:manage": {
		label: "Manage billing",
		description: "Change the subscription, payment method, and spend caps.",
		group: "billing",
	},
	"settings:manage": {
		label: "Manage settings",
		description:
			"Change organization profile, authentication, and policy settings.",
		group: "team",
	},
	"analytics:read": {
		label: "View analytics",
		description: "View organization activity, runs, and usage analytics.",
		group: "team",
	},
	"catalog:manage": {
		label: "Manage catalog",
		description: "Curate the public app catalog and its listings.",
		group: "platform",
	},
	"platform:admin": {
		label: "Administer the platform",
		description:
			"Operate Tedix itself across every tenant. Never granted by a tenant role.",
		group: "platform",
	},
	"os:read": {
		label: "View OS",
		description: "Open Tedix OS and view workspaces, gadgets, and activity.",
		group: "os",
	},
	"os:author": {
		label: "Author in OS",
		description: "Create and edit OS gadgets and workspaces.",
		group: "os",
	},
	"os:run": {
		label: "Run in OS",
		description: "Execute OS gadgets and workflows.",
		group: "os",
	},
	"os:publish": {
		label: "Publish in OS",
		description: "Publish an OS gadget or workspace for others to use.",
		group: "os",
	},
	"os:approve": {
		label: "Approve in OS",
		description: "Resolve approvals a digital worker has escalated.",
		group: "os",
	},
	"os:admin": {
		label: "Administer OS",
		description:
			"Administer OS configuration, sharing, and destructive actions.",
		group: "os",
	},
};

export interface RoleMetadata {
	/** Display label, sentence case. */
	label: string;
	/** One sentence on what the role is for. */
	description: string;
	/** Short noun phrase naming the role's accountability. */
	responsibility: string;
	/**
	 * Whether a tenant administrator may assign this role to a member.
	 *
	 * The non-assignable roles are platform or machine identities:
	 * `platform-admin` and `catalog-operator` are Tedix-internal,
	 * `tedi` is a digital worker, which is authorized by capability scopes and FGA rather
	 * than by this permission model at all.
	 */
	assignable: boolean;
}

export const ROLE_METADATA: Record<Role, RoleMetadata> = {
	owner: {
		label: "Owner",
		description:
			"Full control of the organization, including billing and membership.",
		responsibility: "Accountable owner",
		assignable: true,
	},
	admin: {
		label: "Admin",
		description: "Runs organization operations without billing authority.",
		responsibility: "Organization operator",
		assignable: true,
	},
	member: {
		label: "Member",
		description:
			"Does daily work in OS and with apps without administrative access.",
		responsibility: "Product contributor",
		assignable: true,
	},
	viewer: {
		label: "Viewer",
		description: "Read-only access to organization activity and analytics.",
		responsibility: "Read-only observer",
		assignable: true,
	},
	"platform-admin": {
		label: "Platform admin",
		description: "Operates Tedix itself across every tenant.",
		responsibility: "Tedix operator",
		assignable: false,
	},
	"catalog-operator": {
		label: "Catalog operator",
		description: "Curates the public app catalog.",
		responsibility: "Catalog curator",
		assignable: false,
	},
	tedi: {
		label: "Tedi",
		description:
			"A digital worker. Authorized by capability scopes and FGA, never by tenant permissions.",
		responsibility: "Digital worker",
		assignable: false,
	},
};

/**
 * The roles a tenant administrator may actually assign, in descending
 * authority. Derived from {@link ROLE_METADATA} so a new assignable role cannot
 * be added without appearing in the product's role pickers and matrices.
 */
export const ASSIGNABLE_ROLES = [
	"owner",
	"admin",
	"member",
	"viewer",
] as const satisfies readonly Role[];

/** Permissions a role grants, ordered by group then label for rendering. */
export function describeRolePermissions(
	role: Role,
): Array<PermissionMetadata & { permission: Permission }> {
	return [...(ROLE_PERMISSION_GRANTS[role] ?? [])]
		.map((permission) => ({ permission, ...PERMISSION_METADATA[permission] }))
		.sort(
			(left, right) =>
				PERMISSION_GROUPS.indexOf(left.group) -
					PERMISSION_GROUPS.indexOf(right.group) ||
				left.label.localeCompare(right.label),
		);
}

/**
 * Permissions a tenant administrator may grant to a member as an override.
 *
 * Defined as exactly what the `owner` role already holds, which makes the rule
 * self-maintaining and states the invariant plainly: **an override can never
 * grant more than the most privileged tenant role.** In particular it can never
 * grant `platform:admin` or `catalog:manage`, which belong to Tedix-internal
 * roles — the same escalation hazard that `PLATFORM_ONLY_API_KEY_SCOPES` closes
 * on the API-key side.
 *
 * Overrides are ADDITIVE only. There is no revoking form: a permission the role
 * grants cannot be taken away by an override, because a subtractive rule makes
 * "what can this person do" depend on evaluation order, and every guard in the
 * API asks that question independently.
 */
export const TENANT_GRANTABLE_PERMISSIONS: readonly Permission[] =
	ROLE_PERMISSION_GRANTS.owner;

export function isTenantGrantablePermission(
	value: string,
): value is Permission {
	return (TENANT_GRANTABLE_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permissions Descope defines and uses ITSELF, which Tedix therefore must not
 * treat as unusable.
 *
 * These are not decoration. `User Admin` is load-bearing for the embedded
 * Role Management widget — Descope requires it in addition to whatever
 * permission the widget is configured with, which is why `owner`, `admin`,
 * `admin` and `admin` carry it. `SSO Admin` gates SSO
 * configuration, and `Impersonate`/`Super User` gate Descope's own operations.
 *
 * Listed here so {@link findUnusableDescopePermissions} can tell "Descope needs
 * this" apart from "nothing can ever read this".
 */
export const DESCOPE_BUILT_IN_PERMISSIONS: readonly string[] = [
	"User Admin",
	"SSO Admin",
	"Impersonate",
	"Super User",
];

/**
 * Permissions that exist in Descope but that NOTHING can evaluate.
 *
 * A permission is a name guards are written against. One that is neither in
 * `ALL_PERMISSIONS` nor used by Descope itself is inert: it can be granted to a
 * role, it will be minted into a JWT, and no code path will ever ask for it.
 *
 * This is the opposite direction from the provisioning plan, which is
 * deliberately lacks-only because the sync never removes. That asymmetry hid a
 * It prevents a permission that no guard evaluates from appearing as a real
 * capability in the embedded role editor.
 *
 * It matters more now that tenant admins compose roles in Descope's Role
 * Management widget: an inert permission offered in a picker reads as a
 * capability, and granting it does nothing.
 *
 * Informational, never a failure. Only Descope can hold these, so no sync can
 * resolve them — removing one is a deliberate decision about live authorization
 * state, not something a drift report should imply is broken.
 */
export function findUnusableDescopePermissions(
	livePermissionNames: readonly string[],
): string[] {
	const known = new Set<string>([
		...ALL_PERMISSIONS,
		...DESCOPE_BUILT_IN_PERMISSIONS,
	]);
	return [...new Set(livePermissionNames)]
		.filter((name) => !known.has(name))
		.sort();
}

export function roleImpliesPermission(
	roles: readonly string[],
	permission: Permission,
): boolean {
	return roles.some((role) =>
		(ROLE_PERMISSION_GRANTS[role as Role] ?? []).includes(permission),
	);
}

export function hasPermission(
	user: { permissions?: string[]; roles?: string[] },
	permission: Permission,
): boolean {
	const permissions = user.permissions ?? [];
	const roles = user.roles ?? [];

	// Explicit permission grant
	if (permissions.includes(permission)) return true;
	if (roleImpliesPermission(roles, permission)) return true;
	return false;
}
