import {
	APP_RUNTIME_ENTRY,
	APP_RUNTIME_SERVER_MODULE,
	type AppRuntimeFiles,
	type AppRuntimeOperation,
	type AppRuntimeRole,
} from "../schemas/os-app-runtime";
import type { OsGadgetManifest } from "../schemas/os-workspaces";

/** True when a manifest describes an app that runs its own code. */
export function isAppRuntimeManifest(
	manifest: Pick<OsGadgetManifest, "entry"> | null | undefined,
): boolean {
	return manifest?.entry.trim() === APP_RUNTIME_ENTRY;
}

export interface AppRuntimeCodeIdParts {
	organizationId: string;
	workspaceId: string;
	gadgetId: string;
	revision: number;
	/** Present for a chat draft; the draft runs under its own id and storage. */
	draftId?: string;
}

/**
 * The identity a loaded program is cached under. The host asks the Worker
 * Loader for this id and the loader keeps one isolate per id, so the id has to
 * change whenever the code can: a new revision or a different draft.
 */
export function appRuntimeCodeId(parts: AppRuntimeCodeIdParts): string {
	const base = `${parts.organizationId}:${parts.workspaceId}:${parts.gadgetId}:r${parts.revision}`;
	return parts.draftId ? `${base}:draft:${parts.draftId}` : base;
}

export const APP_RUNTIME_DEFAULT_COMPATIBILITY_DATE = "2026-10-01";

/**
 * What the host hands to the Worker Loader for one revision. Only `.js` files
 * become modules the program can import; `.json` and `.txt` ride along as text
 * modules the code reads by name. Network access is never inherited.
 */
export function appRuntimeLoaderManifest(
	files: AppRuntimeFiles,
	options: { compatibilityDate?: string } = {},
) {
	return {
		compatibilityDate:
			options.compatibilityDate ?? APP_RUNTIME_DEFAULT_COMPATIBILITY_DATE,
		// Agent-written code must never reach bindings ambiently.
		compatibilityFlags: ["disallow_importable_env"] as readonly string[],
		mainModule: APP_RUNTIME_SERVER_MODULE,
		modules: { ...files } as Record<string, string>,
		// Always null: an app reaches the outside world only through capabilities.
		globalOutbound: null,
	};
}

export type AppRuntimeLoaderManifest = ReturnType<
	typeof appRuntimeLoaderManifest
>;

/**
 * The one table that says what a role may ask the host for. A grant on the
 * manifest (`resourceGrants`) is necessary for anything that touches a
 * resource; the role decides how far that grant reaches. The matrix is data so
 * the UI, the API and the host all read the same answer.
 */
const ROLE_OPERATIONS: Record<AppRuntimeRole, readonly AppRuntimeOperation[]> =
	{
		owner: [
			"app.call",
			"outputs.read",
			"outputs.write",
			"connections.call",
			"skills.run",
		],
		build: [
			"app.call",
			"outputs.read",
			"outputs.write",
			"connections.call",
			"skills.run",
		],
		use: ["app.call", "outputs.read"],
		viewer: [],
	};

/** Operations that need a matching slot grant on the manifest before the role is consulted. */
const GRANT_GATED: ReadonlySet<AppRuntimeOperation> = new Set([
	"outputs.read",
	"outputs.write",
	"connections.call",
	"skills.run",
]);

export interface AppRuntimePermissionInput {
	role: AppRuntimeRole;
	operation: AppRuntimeOperation;
	/** Slots the manifest grants, with the operations each slot allows. */
	grants: ReadonlyArray<{ slot: string; operations: readonly string[] }>;
	/** The slot the call names; required for grant-gated operations. */
	slot?: string;
}

export type AppRuntimePermission =
	| { allowed: true }
	| {
			allowed: false;
			reason: "role" | "no_grant" | "grant_operation" | "slot_required";
	  };

export function appRuntimePermission(
	input: AppRuntimePermissionInput,
): AppRuntimePermission {
	if (!ROLE_OPERATIONS[input.role].includes(input.operation))
		return { allowed: false, reason: "role" };
	if (!GRANT_GATED.has(input.operation)) return { allowed: true };
	if (!input.slot) return { allowed: false, reason: "slot_required" };
	const grant = input.grants.find((candidate) => candidate.slot === input.slot);
	if (!grant) return { allowed: false, reason: "no_grant" };
	if (!grant.operations.includes(input.operation))
		return { allowed: false, reason: "grant_operation" };
	return { allowed: true };
}

/** The operations a role may use at all, for display and for capability minting. */
export function appRuntimeOperationsForRole(
	role: AppRuntimeRole,
): readonly AppRuntimeOperation[] {
	return ROLE_OPERATIONS[role];
}

/** Total length of all files; the stored `code_length`. */
export function appRuntimeCodeLength(files: AppRuntimeFiles): number {
	return Object.values(files).reduce((sum, text) => sum + text.length, 0);
}
