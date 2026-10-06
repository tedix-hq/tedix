/**
 * @tedix/auth - Descope RBAC Provisioning Sync
 *
 * Provisions Descope's project-level roles and permissions FROM CODE, so the
 * canonical RBAC model in `./rbac` (`ALL_PERMISSIONS`, `ROLE_PERMISSION_GRANTS`)
 * is the single source of truth instead of hand-maintained Console rows.
 *
 * The model here is a pure, dry-run-first read-modify-write:
 *
 *   1. Read the current Descope permissions + roles (`loadAll`).
 *   2. Diff against the desired state derived from `./rbac`.
 *   3. Produce a PLAN of create/update operations.
 *   4. (Optionally) apply the plan.
 *
 * Two safety properties are load-bearing and are asserted by the unit tests:
 *
 *   - **Superset-safe.** `management.role.update` REPLACES a role's permission
 *     set, so an update always carries the UNION of the existing grants and the
 *     desired grants. The sync never removes a permission from a role and never
 *     deletes a role or permission — anything provisioned by hand in the Console
 *     survives untouched.
 *   - **Idempotent / fixpoint.** Running the plan builder against a state that
 *     already satisfies the model yields an empty plan, so a second run is a
 *     no-op.
 *
 * Descriptions are only ever FILLED IN (when Descope has none), never
 * overwritten, so human-authored descriptions in the Console are preserved.
 *
 * This module is intentionally network-free: it operates on snapshots and a
 * narrow client interface. `packages/auth/scripts/sync-descope-rbac.ts` wires
 * it to a live Descope management client and prints the plan (dry-run by
 * default).
 */

import {
	ALL_PERMISSIONS,
	findUnusableDescopePermissions,
	type Permission,
	type Role,
	ROLE_PERMISSION_GRANTS,
} from "./rbac";

// =============================================================================
// SNAPSHOT + PLAN TYPES
// =============================================================================

/** A permission as returned by `management.permission.loadAll()`. */
export interface DescopePermissionSnapshot {
	name: string;
	description?: string;
}

/** A role as returned by `management.role.loadAll()`. */
export interface DescopeRoleSnapshot {
	name: string;
	description?: string;
	permissionNames: string[];
}

/**
 * Read a Descope role's permission names, tolerating the `permissionsNames`
 * alias the API also returns.
 *
 * This is a SAFETY function, not a convenience. `planRoleSync` guarantees it
 * never removes a permission by emitting the UNION of what Descope already
 * grants and what the model wants — and that guarantee holds only if the
 * snapshot's `permissionNames` is accurate. `management.role.update` REPLACES a
 * role's permission set, so a role whose permissions arrived under the alias
 * would snapshot as EMPTY, make the union equal the desired set alone, and
 * silently drop every Console-added permission the module's contract promises
 * "survives untouched".
 *
 * `apps/api/src/services/descope-aih-drift.ts` already knew about the alias and
 * handled it; the provisioning script did not. Exported here so both read the
 * shape through one function instead of each remembering.
 */
export function readDescopeRolePermissionNames(role: {
	permissionNames?: string[] | null;
	permissionsNames?: string[] | null;
}): string[] {
	return role.permissionNames ?? role.permissionsNames ?? [];
}

export interface DescopeRbacSnapshot {
	permissions: DescopePermissionSnapshot[];
	roles: DescopeRoleSnapshot[];
}

export type PermissionSyncOp =
	| { kind: "create-permission"; name: string; description: string }
	| {
			kind: "describe-permission";
			name: string;
			description: string;
	  };

export type RoleSyncOp =
	| {
			kind: "create-role";
			name: string;
			description: string;
			permissionNames: string[];
	  }
	| {
			kind: "update-role-permissions";
			name: string;
			/** Existing description, preserved through the update. */
			description: string;
			/** Existing grants union the canonical grant set passed to `role.update`. */
			permissionNames: string[];
			/** The subset actually being added (desired \ existing). */
			addedPermissions: string[];
	  };

export interface DescopeRbacPlan {
	permissions: PermissionSyncOp[];
	roles: RoleSyncOp[];
}

// =============================================================================
// DESIRED-STATE DESCRIPTIONS
// =============================================================================

/**
 * Deterministic description generated for a permission Descope does not yet
 * describe. Kept generic on purpose — this only fills a blank, it never
 * overwrites a Console-authored description.
 */
export function describePermission(name: Permission | string): string {
	return `Tedix RBAC permission ${name}`;
}

/** Deterministic description generated for a role Descope does not yet describe. */
export function describeRole(name: Role | string): string {
	return `Tedix RBAC role ${name}`;
}

// =============================================================================
// PLAN CONSTRUCTION
// =============================================================================

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

/**
 * Diff the canonical permission list (`ALL_PERMISSIONS`) against Descope.
 * Creates permissions Descope is missing; fills in a description only where
 * Descope has none. Never deletes and never overwrites a description.
 */
export function planPermissionSync(
	existing: readonly DescopePermissionSnapshot[],
	desired: readonly string[] = ALL_PERMISSIONS,
): PermissionSyncOp[] {
	const byName = new Map(existing.map((p) => [p.name, p]));
	const ops: PermissionSyncOp[] = [];

	for (const name of sortedUnique(desired)) {
		const current = byName.get(name);
		if (!current) {
			ops.push({
				kind: "create-permission",
				name,
				description: describePermission(name),
			});
			continue;
		}
		if (!current.description || current.description.trim() === "") {
			ops.push({
				kind: "describe-permission",
				name,
				description: describePermission(name),
			});
		}
	}
	return ops;
}

/**
 * Diff the canonical role→permission grants (`ROLE_PERMISSION_GRANTS`) against
 * Descope. Creates missing roles; for existing roles emits a superset-safe
 * update (existing ∪ desired) ONLY when there are permissions to add. Never
 * removes a grant, never deletes a role, never overwrites a description.
 */
export function planRoleSync(
	existing: readonly DescopeRoleSnapshot[],
	desired: Readonly<Record<string, readonly string[]>> = ROLE_PERMISSION_GRANTS,
): RoleSyncOp[] {
	const byName = new Map(existing.map((r) => [r.name, r]));
	const ops: RoleSyncOp[] = [];

	for (const name of Object.keys(desired).sort()) {
		const desiredPermissions = sortedUnique([
			...(desired[name] ?? []),
			...(desired === ROLE_PERMISSION_GRANTS &&
			["owner", "admin"].includes(name)
				? ["User Admin", "SSO Admin"]
				: []),
		]);
		const current = byName.get(name);

		if (!current) {
			ops.push({
				kind: "create-role",
				name,
				description: describeRole(name),
				permissionNames: sortedUnique(desiredPermissions),
			});
			continue;
		}

		const existingSet = new Set(current.permissionNames);
		const addedPermissions = sortedUnique(
			desiredPermissions.filter((p) => !existingSet.has(p)),
		);
		if (addedPermissions.length === 0) continue;

		ops.push({
			kind: "update-role-permissions",
			name,
			description:
				current.description && current.description.trim() !== ""
					? current.description
					: describeRole(name),
			// Superset: union of what Descope already grants and what we want.
			permissionNames: sortedUnique([
				...current.permissionNames,
				...desiredPermissions,
			]),
			addedPermissions,
		});
	}
	return ops;
}

export interface DescopeRbacDriftSummary {
	inSync: boolean;
	missingPermissions: string[];
	excessPermissions: string[];
	unusablePermissions: string[];
	undescribedPermissions: string[];
	missingRoles: string[];
	rolesMissingPermissions: Array<{
		role: string;
		missingPermissions: string[];
	}>;
	rolesWithExcessPermissions: Array<{
		role: string;
		excessPermissions: string[];
	}>;
}

/**
 * Turn a provisioning plan into a drift REPORT.
 *
 * The plan answers "what would I write?"; drift answers "what is wrong?" — and
 * they are not the same question. `describe-permission` ops exist only because
 * the sync fills in missing descriptions, which is cosmetic; counting them as
 * drift would make an otherwise-aligned project permanently red and train
 * everyone to ignore the signal. So they are reported separately and excluded
 * from `inSync`.
 *
 * Everything reported is something Descope is MISSING relative to the model.
 * The planner is superset-safe and never emits a removal, so this can never say
 * "Descope has too much" — a Console-added permission is not drift.
 */
export function summarizeDescopeRbacDrift(
	plan: DescopeRbacPlan,
	snapshot?: DescopeRbacSnapshot,
): DescopeRbacDriftSummary {
	const missingPermissions = plan.permissions
		.filter((op) => op.kind === "create-permission")
		.map((op) => op.name)
		.sort();
	const undescribedPermissions = plan.permissions
		.filter((op) => op.kind === "describe-permission")
		.map((op) => op.name)
		.sort();
	const excessPermissions: string[] = [];
	const missingRoles = plan.roles
		.filter((op) => op.kind === "create-role")
		.map((op) => op.name)
		.sort();
	const rolesMissingPermissions = plan.roles
		.filter((op) => op.kind === "update-role-permissions")
		.map((op) => ({
			role: op.name,
			missingPermissions: [...op.addedPermissions].sort(),
		}))
		.sort((left, right) => left.role.localeCompare(right.role));
	const rolesWithExcessPermissions: Array<{
		role: string;
		excessPermissions: string[];
	}> = [];

	return {
		// `unusablePermissions` is deliberately NOT part of this. No sync can
		// resolve them, so counting them would make the report permanently red
		// about something it cannot ask anyone to fix.
		inSync:
			missingPermissions.length === 0 &&
			excessPermissions.length === 0 &&
			missingRoles.length === 0 &&
			rolesMissingPermissions.length === 0 &&
			rolesWithExcessPermissions.length === 0,
		missingPermissions,
		excessPermissions,
		unusablePermissions: findUnusableDescopePermissions(
			(snapshot?.permissions ?? []).map((permission) => permission.name),
		),
		undescribedPermissions,
		missingRoles,
		rolesMissingPermissions,
		rolesWithExcessPermissions,
	};
}

/**
 * Read the live Descope RBAC state into a snapshot the planner can diff.
 *
 * Lives here rather than in the CLI script because the script is no longer the
 * only caller: reporting drift IN-PRODUCT needs the same read, and a second
 * hand-rolled copy is how the `permissionsNames` alias bug happened — the
 * script had its own reader and missed a spelling the drift service already
 * handled.
 *
 * Read-only. It calls `permission.loadAll()` and `role.loadAll()` and nothing
 * else, so it is safe to expose behind a read guard.
 *
 * THROWS on a failed call rather than returning an empty snapshot. An empty
 * snapshot is indistinguishable from "Descope has no roles", which the planner
 * would read as "provision everything" — a plan that looks like catastrophic
 * drift when the truth is that we could not look. Same failure the FGA drift
 * audit had.
 */
export interface DescopeRbacReadResponse<T> {
	ok: boolean;
	code?: number;
	data?: T;
	error?: { errorMessage?: string; errorDescription?: string };
}

/**
 * The read half of the management surface, kept separate from
 * {@link DescopeRbacManagementClient} so a caller that only reports drift never
 * has to satisfy — or be handed — the create/update methods that mutate the
 * live project.
 */
export interface DescopeRbacReadClient {
	management: {
		permission: {
			loadAll(): Promise<
				DescopeRbacReadResponse<Array<{ name: string; description?: string }>>
			>;
		};
		role: {
			loadAll(): Promise<
				DescopeRbacReadResponse<
					Array<{
						name: string;
						description?: string;
						permissionNames?: string[] | null;
						permissionsNames?: string[] | null;
					}>
				>
			>;
		};
	};
}

export async function readDescopeRbacSnapshot(
	client: DescopeRbacReadClient,
): Promise<DescopeRbacSnapshot> {
	const [permissionsResponse, rolesResponse] = await Promise.all([
		client.management.permission.loadAll(),
		client.management.role.loadAll(),
	]);

	const unwrap = <T>(
		response: DescopeRbacReadResponse<T>,
		label: string,
	): T => {
		if (!response.ok || response.data === undefined) {
			const detail =
				response.error?.errorMessage ??
				response.error?.errorDescription ??
				"(no data)";
			throw new Error(
				`Descope ${label} failed${response.code ? ` [${response.code}]` : ""}: ${detail}`,
			);
		}
		return response.data;
	};

	const permissions = unwrap(permissionsResponse, "permission.loadAll");
	const roles = unwrap(rolesResponse, "role.loadAll");

	return {
		permissions: permissions.map((permission) => ({
			name: permission.name,
			description: permission.description,
		})),
		roles: roles.map((role) => ({
			name: role.name,
			description: role.description,
			permissionNames: readDescopeRolePermissionNames(role),
		})),
	};
}

/**
 * Build the full provisioning plan from the canonical RBAC model against a
 * Descope snapshot. An empty plan means Descope already satisfies the model.
 */
export function buildDescopeRbacPlan(
	snapshot: DescopeRbacSnapshot,
): DescopeRbacPlan {
	return {
		permissions: planPermissionSync(snapshot.permissions),
		roles: planRoleSync(snapshot.roles),
	};
}

export function planIsEmpty(plan: DescopeRbacPlan): boolean {
	return plan.permissions.length === 0 && plan.roles.length === 0;
}

/** Human-readable, deterministic rendering of a plan for dry-run output. */
export function formatDescopeRbacPlan(plan: DescopeRbacPlan): string {
	if (planIsEmpty(plan)) {
		return "Descope RBAC is in sync with @tedix/auth/rbac — no changes.";
	}

	const lines: string[] = [];
	lines.push(
		`Descope RBAC plan: ${plan.permissions.length} permission op(s), ${plan.roles.length} role op(s).`,
	);

	for (const op of plan.permissions) {
		if (op.kind === "create-permission")
			lines.push(`  + create permission ${op.name}`);
		else lines.push(`  ~ describe permission ${op.name}`);
	}
	for (const op of plan.roles) {
		if (op.kind === "create-role") {
			lines.push(
				`  + create role ${op.name} (${op.permissionNames.length} permission(s))`,
			);
		} else {
			lines.push(
				`  ~ extend role ${op.name} grants (add [${op.addedPermissions.join(", ")}])`,
			);
		}
	}

	return lines.join("\n");
}

// =============================================================================
// PLAN APPLICATION
// =============================================================================

/** Result shape shared by Descope management SDK calls. */
export interface DescopeSdkResult {
	ok: boolean;
	code?: number;
	error?: { errorMessage?: string; errorDescription?: string };
}

/**
 * Narrow structural view of the Descope management client this sync needs.
 * Matches `@descope/node-sdk`'s `management.permission` / `management.role`
 * surface but keeps this module free of an SDK import so it stays testable.
 */
export interface DescopeRbacManagementClient {
	management: {
		permission: {
			create(name: string, description?: string): Promise<DescopeSdkResult>;
			update(
				name: string,
				newName: string,
				description?: string,
			): Promise<DescopeSdkResult>;
		};
		role: {
			create(
				name: string,
				description?: string,
				permissionNames?: string[],
			): Promise<DescopeSdkResult>;
			update(
				name: string,
				newName: string,
				description?: string,
				permissionNames?: string[],
			): Promise<DescopeSdkResult>;
		};
	};
}

export interface ApplyDescopeRbacResult {
	appliedPermissionOps: number;
	appliedRoleOps: number;
}

function assertOk(result: DescopeSdkResult, label: string): void {
	if (!result.ok) {
		const detail =
			result.error?.errorMessage ??
			result.error?.errorDescription ??
			"(no error detail)";
		throw new Error(
			`Descope RBAC sync failed [${label}${result.code ? ` ${result.code}` : ""}]: ${detail}`,
		);
	}
}

/**
 * Execute a plan against a live Descope management client. This performs real
 * mutations and must only run when the caller has explicitly opted out of
 * dry-run. Operations are superset-safe by construction (see `planRoleSync`).
 */
export async function applyDescopeRbacPlan(
	client: DescopeRbacManagementClient,
	plan: DescopeRbacPlan,
): Promise<ApplyDescopeRbacResult> {
	for (const op of plan.permissions) {
		if (op.kind === "create-permission") {
			assertOk(
				await client.management.permission.create(op.name, op.description),
				`permission.create ${op.name}`,
			);
		} else {
			assertOk(
				await client.management.permission.update(
					op.name,
					op.name,
					op.description,
				),
				`permission.update ${op.name}`,
			);
		}
	}

	for (const op of plan.roles) {
		if (op.kind === "create-role") {
			assertOk(
				await client.management.role.create(
					op.name,
					op.description,
					op.permissionNames,
				),
				`role.create ${op.name}`,
			);
		} else {
			assertOk(
				await client.management.role.update(
					op.name,
					op.name,
					op.description,
					op.permissionNames,
				),
				`role.update ${op.name}`,
			);
		}
	}

	return {
		appliedPermissionOps: plan.permissions.length,
		appliedRoleOps: plan.roles.length,
	};
}
