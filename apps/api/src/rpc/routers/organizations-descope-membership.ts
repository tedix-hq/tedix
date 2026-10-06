import { getManagementClient } from "@tedix/auth/client";

export type TedixMemberRole = "owner" | "admin" | "member" | "viewer";

const DESCOPE_TENANT_ADMIN_ROLE = "admin";
const DESCOPE_TENANT_ADMIN_ROLES = new Set([
	"Admin",
	DESCOPE_TENANT_ADMIN_ROLE,
]);
const DESCOPE_NEW_TENANT_ASSOCIATION_RETRY_DELAYS_MS = [
	250, 750, 1_500,
] as const;

type DescopeSdkError = {
	errorCode?: string;
	errorDescription?: string;
};

/** Get the Descope management client lazily when configured. */
export function getDescopeManagement(env: CloudflareEnv) {
	if (!env.DESCOPE_MANAGEMENT_KEY) return null;
	return getManagementClient({
		DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
	});
}

export function normalizeMemberRole(role: unknown): TedixMemberRole {
	if (
		role === "owner" ||
		role === "admin" ||
		role === "member" ||
		role === "viewer"
	) {
		return role;
	}
	if (typeof role === "string" && DESCOPE_TENANT_ADMIN_ROLES.has(role)) {
		return "admin";
	}
	return "member";
}

export function memberRoleFromTenantRoles(
	roles: readonly string[] | undefined,
): TedixMemberRole | undefined {
	if (!roles?.length) return undefined;

	for (const preferred of ["owner", "admin"] as const) {
		if (roles.includes(preferred)) return preferred;
	}

	if (roles.some((role) => DESCOPE_TENANT_ADMIN_ROLES.has(role))) {
		return "admin";
	}
	for (const fallback of ["member", "viewer"] as const) {
		if (roles.includes(fallback)) return fallback;
	}
	return undefined;
}

export function descopeTenantRolesForMemberRole(
	role: TedixMemberRole,
): string[] {
	if (role === "owner" || role === "admin") {
		return [role, DESCOPE_TENANT_ADMIN_ROLE];
	}
	return [role];
}

function isAlreadyPresentDescopeError(
	error: DescopeSdkError | null | undefined,
): boolean {
	return (
		error?.errorCode === "E023002" ||
		/already (exist|associat|member|assign|part of)/i.test(
			error?.errorDescription ?? "",
		)
	);
}

const DESCOPE_DUPLICATE_TENANT_ERROR_CODE = "E073307";

function isDuplicateTenantError(
	error: DescopeSdkError | null | undefined,
): boolean {
	return error?.errorCode === DESCOPE_DUPLICATE_TENANT_ERROR_CODE;
}

/**
 * Create the personal tenant by ID. Descope reports a duplicate tenant ID and
 * a duplicate tenant name as the same E073307, and tenant names are unique
 * per project, so fallback names like "Personal Workspace" collide across
 * users. Distinguish the two by reloading: an ID conflict means a concurrent
 * sign-in won the create; a name conflict is retried once with a user-unique
 * suffix. Returns whether this call created the tenant.
 */
async function createPersonalDescopeTenant(
	mgmt: NonNullable<ReturnType<typeof getDescopeManagement>>,
	input: { name: string; tenantId: string; userId: string },
): Promise<boolean> {
	const created = await mgmt.management.tenant.createWithId(
		input.tenantId,
		input.name,
		[],
	);
	if (created.ok) return true;
	if (!isDuplicateTenantError(created.error)) {
		throw descopeFailure(
			"Failed to create personal Descope tenant",
			created.error,
		);
	}
	const reloaded = await mgmt.management.tenant.load(input.tenantId);
	if (reloaded.ok) return false;
	const renamed = await mgmt.management.tenant.createWithId(
		input.tenantId,
		`${input.name} ${input.userId.slice(-8)}`,
		[],
	);
	if (renamed.ok) return true;
	throw descopeFailure(
		"Failed to create personal Descope tenant",
		renamed.error,
	);
}

function isNewTenantPropagationError(
	error: DescopeSdkError | null | undefined,
): boolean {
	return error?.errorCode === "E112201";
}

function descopeFailure(operation: string, error?: DescopeSdkError | null) {
	return new Error(
		`${operation}: ${error?.errorCode ?? "unknown"} ${error?.errorDescription ?? "unknown error"}`,
	);
}

/** Reconcile the identity-plane half of a personal workspace. */
export async function ensurePersonalDescopeTenantMembership(
	mgmt: NonNullable<ReturnType<typeof getDescopeManagement>>,
	input: {
		fallbackLoginId: string;
		name: string;
		tenantId: string;
		userId: string;
	},
): Promise<void> {
	const existingTenant = await mgmt.management.tenant.load(input.tenantId);
	const createdTenant = existingTenant.ok
		? false
		: await createPersonalDescopeTenant(mgmt, input);

	const loadedUser = await mgmt.management.user.loadByUserId(input.userId);
	if (!loadedUser.ok) {
		throw descopeFailure(
			"Failed to load personal Descope user",
			loadedUser.error,
		);
	}
	const loginId = loadedUser.data?.loginIds?.[0] ?? input.fallbackLoginId;
	if (!loginId) throw new Error("Personal Descope user has no login ID");

	const requiredOwnerRoles = descopeTenantRolesForMemberRole("owner");
	const alreadyProvisioned =
		!createdTenant &&
		(loadedUser.data?.userTenants ?? []).some(
			(membership) =>
				membership.tenantId === input.tenantId &&
				requiredOwnerRoles.every((role) =>
					(membership.roleNames ?? []).includes(role),
				),
		);
	if (alreadyProvisioned) return;

	let tenantMembership = await mgmt.management.user.addTenant(
		loginId,
		input.tenantId,
	);
	if (createdTenant && isNewTenantPropagationError(tenantMembership.error)) {
		for (const delayMs of DESCOPE_NEW_TENANT_ASSOCIATION_RETRY_DELAYS_MS) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			tenantMembership = await mgmt.management.user.addTenant(
				loginId,
				input.tenantId,
			);
			if (
				tenantMembership.ok ||
				isAlreadyPresentDescopeError(tenantMembership.error) ||
				!isNewTenantPropagationError(tenantMembership.error)
			) {
				break;
			}
		}
	}
	if (
		!tenantMembership.ok &&
		!isAlreadyPresentDescopeError(tenantMembership.error)
	) {
		throw descopeFailure(
			"Failed to associate personal Descope tenant",
			tenantMembership.error,
		);
	}

	const tenantRoles = await mgmt.management.user.addTenantRoles(
		loginId,
		input.tenantId,
		descopeTenantRolesForMemberRole("owner"),
	);
	if (!tenantRoles.ok && !isAlreadyPresentDescopeError(tenantRoles.error)) {
		throw descopeFailure(
			"Failed to assign personal Descope tenant roles",
			tenantRoles.error,
		);
	}
}
