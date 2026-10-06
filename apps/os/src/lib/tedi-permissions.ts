import type { Permission } from "@tedix/auth/rbac";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

function useHasPermission(permission: Permission): boolean {
	const context = useOsOperationalContext();
	return (context.data?.authority.permissions ?? []).includes(permission);
}

export function useCanReadTediSecrets(): boolean {
	const context = useOsOperationalContext();
	const permissions: readonly string[] =
		context.data?.authority.permissions ?? [];
	return (
		permissions.includes("secrets:manage") || permissions.includes("tools:read")
	);
}

export function useCanManageTediSecrets(): boolean {
	const context = useOsOperationalContext();
	const permissions: readonly string[] =
		context.data?.authority.permissions ?? [];
	return (
		permissions.includes("secrets:manage") ||
		permissions.includes("tools:write")
	);
}

/** Mirrors the human permission plane on the server's `tedis.create`. */
export function useCanCreateTedis(): boolean {
	return useHasPermission("tedis:create");
}

export function useCanManageTedis(): boolean {
	return useHasPermission("tedis:update");
}

export function useCanDeleteTedis(): boolean {
	return useHasPermission("tedis:delete");
}

export const TEDIS_CREATE_DENIED_REASON =
	"Launching a digital worker requires the Create tedis permission.";
export const TEDIS_MANAGE_DENIED_REASON =
	"Changing digital-worker settings requires the Update tedis permission.";
export const TEDIS_DELETE_DENIED_REASON =
	"Retiring a digital worker requires the Delete tedis permission.";
export const TEDI_SECRETS_UNKNOWN_REASON =
	"Credential presence is unknown for this identity; reading secrets requires Manage secrets or Read tools permission.";
export const TEDI_SECRETS_MANAGE_DENIED_REASON =
	"Changing encrypted credentials requires Manage secrets or Write tools permission.";
