import { randomUUID } from "node:crypto";
import { withFileLockSync } from "./local-file-lock";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";

export interface CredentialStoreOpts {
	configDir?: string;
	homeDir?: string;
}

export interface WorkspaceCredential {
	loginId: string;
	accessTokenExpiresAtSeconds?: number;
	// Optional per-resource OAuth metadata (used to target + refresh the right
	// `*-unified` MCP gateway). Present only when the login flow captured them.
	mcpUrl?: string;
	oauthResourceUrl?: string;
	org?: string;
	oauthScopeProfile?: "read" | "member" | "admin" | "platform-admin";
	oauthTokens?: StoredOAuthTokens;
	oauthClientInformation?: StoredOAuthClientInformation;
	oauthDiscoveryState?: OAuthDiscoveryState;
}

export const DEFAULT_WORKSPACE = "default";

interface CredentialStore {
	version: 2;
	current: string | null;
	workspaces: Record<string, WorkspaceCredential>;
}

function resolveCredDir(opts?: CredentialStoreOpts): string {
	return (
		opts?.configDir ??
		process.env.TEDIX_CONFIG_DIR ??
		join(opts?.homeDir ?? homedir(), ".tedix")
	);
}

/**
 * Directory holding this machine's Tedix credential state. Exported so the
 * refresh lock can live beside the credentials it serialises access to,
 * including under TEDIX_CONFIG_DIR in tests.
 */
export function credentialDirectory(opts?: CredentialStoreOpts): string {
	return resolveCredDir(opts);
}

function resolveCredPath(opts?: CredentialStoreOpts): string {
	return join(resolveCredDir(opts), "credentials.json");
}

function emptyStore(): CredentialStore {
	return { version: 2, current: null, workspaces: {} };
}

// Read only canonical grant state. Unknown properties never supply authority.
function coerceWorkspace(value: unknown): WorkspaceCredential | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.loginId !== "string") return null;
	const cred: WorkspaceCredential = { loginId: v.loginId };
	if (
		typeof v.accessTokenExpiresAtSeconds === "number" &&
		Number.isFinite(v.accessTokenExpiresAtSeconds)
	) {
		cred.accessTokenExpiresAtSeconds = v.accessTokenExpiresAtSeconds;
	}
	if (typeof v.mcpUrl === "string") cred.mcpUrl = v.mcpUrl;
	if (typeof v.oauthResourceUrl === "string") {
		cred.oauthResourceUrl = v.oauthResourceUrl;
	}
	if (typeof v.org === "string") cred.org = v.org;
	if (
		v.oauthScopeProfile === "read" ||
		v.oauthScopeProfile === "member" ||
		v.oauthScopeProfile === "admin" ||
		v.oauthScopeProfile === "platform-admin"
	)
		cred.oauthScopeProfile = v.oauthScopeProfile;
	if (v.oauthTokens !== undefined) {
		const tokens = v.oauthTokens;
		if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens))
			return null;
		const record = tokens as Record<string, unknown>;
		if (
			typeof record.access_token !== "string" ||
			typeof record.token_type !== "string" ||
			["refresh_token", "scope", "id_token", "issuer"].some(
				(key) => record[key] !== undefined && typeof record[key] !== "string",
			)
		)
			return null;
		const { expires_in, ...grant } = record;
		// Invalid duration is unknown, not a reason to discard a usable grant.
		cred.oauthTokens = {
			...grant,
			...(typeof expires_in === "number" &&
			Number.isFinite(expires_in) &&
			expires_in >= 0
				? { expires_in }
				: {}),
		} as StoredOAuthTokens;
	}
	if (v.oauthClientInformation !== undefined) {
		const client = v.oauthClientInformation;
		if (typeof client !== "object" || client === null || Array.isArray(client))
			return null;
		const record = client as Record<string, unknown>;
		if (
			typeof record.client_id !== "string" ||
			["client_secret", "issuer", "token_endpoint_auth_method"].some(
				(key) => record[key] !== undefined && typeof record[key] !== "string",
			)
		)
			return null;
		cred.oauthClientInformation = client as StoredOAuthClientInformation;
	}

	if (
		typeof v.oauthDiscoveryState === "object" &&
		v.oauthDiscoveryState !== null
	) {
		cred.oauthDiscoveryState = v.oauthDiscoveryState as OAuthDiscoveryState;
	}
	return cred;
}

// Effective current workspace for an already-loaded store: the explicit pointer
// when it names a live workspace, else the sole workspace when exactly one
// exists, else null.
function currentOf(store: CredentialStore): string | null {
	const names = Object.keys(store.workspaces);
	if (store.current && store.current in store.workspaces) return store.current;
	if (names.length === 1) return names[0] ?? null;
	return null;
}

// Single read path. Fail-soft: corrupt/unreadable files surface a diagnostic and
// resolve to an empty store; invalid entries are dropped with a per-workspace
// diagnostic while valid siblings survive.
function loadStore(opts?: CredentialStoreOpts): CredentialStore {
	const path = resolveCredPath(opts);
	if (!existsSync(path)) return emptyStore();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return emptyStore();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// The credentials file exists but is not valid JSON — surface a clear
		// diagnostic so the user knows to re-authenticate.
		console.error(
			"[tedix] credentials.json is corrupt or unreadable — run `tedix login` to re-authenticate.",
		);
		return emptyStore();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		console.error(
			"[tedix] credentials.json is corrupt or unreadable — run `tedix login` to re-authenticate.",
		);
		return emptyStore();
	}
	const obj = parsed as Record<string, unknown>;

	if (obj.version !== 2) {
		console.error(
			"[tedix] credentials.json has an unsupported format — run `tedix login` to create a current workspace store.",
		);
		return emptyStore();
	}

	const workspaces: Record<string, WorkspaceCredential> = {};
	const workspacesRaw = obj.workspaces;
	if (typeof workspacesRaw === "object" && workspacesRaw !== null) {
		for (const [name, entry] of Object.entries(
			workspacesRaw as Record<string, unknown>,
		)) {
			const cred = coerceWorkspace(entry);
			if (!cred) {
				console.error(
					`[tedix] credentials.json workspace "${name}" is missing required fields — run \`tedix login --workspace ${name}\`.`,
				);
				continue;
			}
			workspaces[name] = cred;
		}
	}
	let current: string | null =
		typeof obj.current === "string" ? obj.current : null;
	// A pointer to a dropped/absent workspace is treated as unset.
	if (current !== null && !(current in workspaces)) current = null;
	return { version: 2, current, workspaces };
}

// Single write path. Preserves the perms hardening of the original store.
function saveStore(store: CredentialStore, opts?: CredentialStoreOpts): void {
	const dir = resolveCredDir(opts);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = resolveCredPath(opts);
	// Persist only the canonical credential fields.
	const workspaces = Object.fromEntries(
		Object.entries(store.workspaces).map(([name, credential]) => [
			name,
			coerceWorkspace(credential),
		]),
	);
	const temporary = join(
		dir,
		`.credentials-${process.pid}-${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(
			temporary,
			JSON.stringify({ ...store, version: 2, workspaces }, null, 2),
			{ mode: 0o600, flag: "wx" },
		);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function readWorkspaceCredentials(
	workspace: string,
	opts?: CredentialStoreOpts,
): WorkspaceCredential | null {
	const store = loadStore(opts);
	// Absence is normal (no diagnostic).
	return store.workspaces[workspace] ?? null;
}

export class CredentialWriteConflictError extends Error {
	constructor() {
		super(
			"Credentials changed during renewal; retry using the current workspace login.",
		);
		this.name = "CredentialWriteConflictError";
	}
}

export function writeWorkspaceCredentials(
	workspace: string,
	cred: WorkspaceCredential,
	opts?: CredentialStoreOpts,
	expectedCredential?: WorkspaceCredential,
): void {
	return withFileLockSync(join(resolveCredDir(opts), "locks", "store"), () => {
		const store = loadStore(opts);
		if (expectedCredential) {
			const current = store.workspaces[workspace];
			if (
				!current ||
				current.oauthTokens?.access_token !==
					expectedCredential.oauthTokens?.access_token ||
				current.oauthTokens?.refresh_token !==
					expectedCredential.oauthTokens?.refresh_token
			) {
				throw new CredentialWriteConflictError();
			}
		}
		store.workspaces[workspace] = cred;
		// Upsert only — the current pointer is left as-is.
		saveStore(store, opts);
	});
}

export function getCurrentWorkspace(opts?: CredentialStoreOpts): string | null {
	return currentOf(loadStore(opts));
}

export function setCurrentWorkspace(
	workspace: string,
	opts?: CredentialStoreOpts,
): void {
	return withFileLockSync(join(resolveCredDir(opts), "locks", "store"), () => {
		const store = loadStore(opts);
		if (!(workspace in store.workspaces)) {
			throw new Error(
				`[tedix] workspace "${workspace}" is not present — run \`tedix login --workspace ${workspace}\` first.`,
			);
		}
		store.current = workspace;
		saveStore(store, opts);
	});
}

export interface WorkspaceSummary {
	name: string;
	mcpUrl?: string;
	org?: string;
	loginId: string;
	accessTokenExpiresAtSeconds?: number;
	current: boolean;
}

export function listWorkspaces(opts?: CredentialStoreOpts): WorkspaceSummary[] {
	const store = loadStore(opts);
	const current = currentOf(store);
	return Object.entries(store.workspaces)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, cred]) => ({
			name,
			mcpUrl: cred.mcpUrl,
			org: cred.org,
			loginId: cred.loginId,
			accessTokenExpiresAtSeconds: cred.accessTokenExpiresAtSeconds,
			current: name === current,
		}));
}

export function removeWorkspace(
	workspace: string,
	opts?: CredentialStoreOpts,
): void {
	return withFileLockSync(join(resolveCredDir(opts), "locks", "store"), () => {
		const store = loadStore(opts);
		if (!(workspace in store.workspaces)) return;
		const wasCurrent = currentOf(store) === workspace;
		delete store.workspaces[workspace];
		if (wasCurrent) {
			const remaining = Object.keys(store.workspaces).sort();
			store.current = remaining[0] ?? null;
		}
		saveStore(store, opts);
	});
}

export function clearAllCredentials(opts?: CredentialStoreOpts): void {
	withFileLockSync(join(resolveCredDir(opts), "locks", "store"), () => {
		rmSync(resolveCredPath(opts), { force: true });
	});
}
