/**
 * Client-side visibility gates for the /apps/$appId management surface.
 *
 * These mirror the SERVER guards — they never replace them. The permission
 * names are the user-plane arguments of the API's `withAuthorization` gates:
 *
 *   - `apps:update`  — apps.update, appTools/appAdapters enable/disable,
 *                      content mutations (AUTHZ.appsWrite / AUTHZ.toolsWrite)
 *   - `secrets:manage` — appSecrets.delete (AUTHZ.secretsWrite)
 *
 * `apps.delete` additionally demands a step-up (`su`) token; see the settings
 * page's danger zone.
 */

import type { Permission } from "@tedix/auth/rbac";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

function useHasPermission(permission: Permission): boolean {
	const context = useOsOperationalContext();
	const permissions: readonly string[] =
		context.data?.authority.permissions ?? [];
	return permissions.includes(permission);
}

export function useCanManageApps(): boolean {
	return useHasPermission("apps:update");
}

export function useCanManageSecrets(): boolean {
	return useHasPermission("secrets:manage");
}

export const APPS_MANAGE_DENIED_REASON =
	"Changing app configuration requires the Update apps permission.";

export const SECRETS_MANAGE_DENIED_REASON =
	"Deleting secrets requires the Manage secrets permission.";
