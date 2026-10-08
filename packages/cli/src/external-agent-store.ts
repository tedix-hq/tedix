import { createHash, randomUUID } from "node:crypto";
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
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { beginFileLock, withFileLockSync } from "./local-file-lock";

export interface ExternalAgentStoreOptions {
	configDir?: string;
	homeDir?: string;
}

export interface StoredExternalAgentSession {
	id: string;
	externalSessionKey: string;
	harness: string;
	harnessVersion: string;
	modelProvider: string;
	modelId: string;
	modelVersion: string;
	startedAt: string;
}

export interface StoredExternalAgentProfile {
	organizationId: string;
	principalId: string;
	key: string;
	displayName: string;
	apiKeyId: string;
	/** Secret returned once by the API. Never render this field. */
	rawApiKey: string;
	scopes: string[];
	mcpUrl: string;
	createdAt: string;
	/** Set when the owner chose this name (first setup or `agent rename`). */
	displayNameConfirmedAt?: string;
	sessions: Record<string, StoredExternalAgentSession>;
}

interface CachedAgentCredential {
	binding: string;
	accessToken: string;
	expiresAt: number;
}

interface ExternalAgentStore {
	version: 1;
	credentials?: Record<string, CachedAgentCredential>;
	workspaces: Record<string, StoredExternalAgentProfile>;
}

function resolveStoreDir(options?: ExternalAgentStoreOptions): string {
	return (
		options?.configDir ??
		process.env.TEDIX_CONFIG_DIR ??
		join(options?.homeDir ?? homedir(), ".tedix")
	);
}

function resolveStorePath(options?: ExternalAgentStoreOptions): string {
	return join(resolveStoreDir(options), "external-agents.json");
}

function coerceSession(value: unknown): StoredExternalAgentSession | null {
	if (!isRecord(value)) return null;
	const required = [
		"id",
		"externalSessionKey",
		"harness",
		"harnessVersion",
		"modelProvider",
		"modelId",
		"modelVersion",
		"startedAt",
	] as const;
	if (required.some((field) => typeof value[field] !== "string")) return null;
	return {
		id: value.id as string,
		externalSessionKey: value.externalSessionKey as string,
		harness: value.harness as string,
		harnessVersion: value.harnessVersion as string,
		modelProvider: value.modelProvider as string,
		modelId: value.modelId as string,
		modelVersion: value.modelVersion as string,
		startedAt: value.startedAt as string,
	};
}

function coerceProfile(value: unknown): StoredExternalAgentProfile | null {
	if (!isRecord(value)) return null;
	const required = [
		"organizationId",
		"principalId",
		"key",
		"displayName",
		"apiKeyId",
		"rawApiKey",
		"mcpUrl",
		"createdAt",
	] as const;
	if (required.some((field) => typeof value[field] !== "string")) return null;
	if (
		!Array.isArray(value.scopes) ||
		value.scopes.some((v) => typeof v !== "string")
	) {
		return null;
	}
	const sessions: Record<string, StoredExternalAgentSession> = {};
	if (isRecord(value.sessions)) {
		for (const [sessionKey, candidate] of Object.entries(value.sessions)) {
			const session = coerceSession(candidate);
			if (session && session.externalSessionKey === sessionKey) {
				sessions[sessionKey] = session;
			}
		}
	}
	return {
		organizationId: value.organizationId as string,
		principalId: value.principalId as string,
		key: value.key as string,
		displayName: value.displayName as string,
		apiKeyId: value.apiKeyId as string,
		rawApiKey: value.rawApiKey as string,
		scopes: value.scopes as string[],
		mcpUrl: value.mcpUrl as string,
		createdAt: value.createdAt as string,
		...(typeof value.displayNameConfirmedAt === "string"
			? { displayNameConfirmedAt: value.displayNameConfirmedAt }
			: {}),
		sessions,
	};
}

function readStore(options?: ExternalAgentStoreOptions): ExternalAgentStore {
	const path = resolveStorePath(options);
	if (!existsSync(path)) return { version: 1, workspaces: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			!isRecord(parsed) ||
			parsed.version !== 1 ||
			!isRecord(parsed.workspaces)
		) {
			throw new Error("invalid store shape");
		}
		const workspaces: Record<string, StoredExternalAgentProfile> = {};
		for (const [workspace, candidate] of Object.entries(parsed.workspaces)) {
			const profile = coerceProfile(candidate);
			if (profile) workspaces[workspace] = profile;
		}
		const credentials: Record<string, CachedAgentCredential> = {};
		if (isRecord(parsed.credentials))
			for (const [workspace, value] of Object.entries(parsed.credentials)) {
				if (
					workspaces[workspace] &&
					isRecord(value) &&
					typeof value.binding === "string" &&
					typeof value.accessToken === "string" &&
					value.accessToken.length > 0 &&
					typeof value.expiresAt === "number" &&
					Number.isFinite(value.expiresAt) &&
					value.expiresAt > Date.now()
				) {
					credentials[workspace] = {
						binding: value.binding,
						accessToken: value.accessToken,
						expiresAt: value.expiresAt,
					};
				}
			}
		return { version: 1, workspaces, credentials };
	} catch {
		throw new Error(
			"[tedix] external-agents.json is corrupt or unreadable; repair or remove it before using external-agent auth.",
		);
	}
}

function writeStore(
	store: ExternalAgentStore,
	options?: ExternalAgentStoreOptions,
): void {
	const dir = resolveStoreDir(options);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = resolveStorePath(options);
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(store, null, 2), {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

function mutateStore<T>(
	options: ExternalAgentStoreOptions | undefined,
	operation: (store: ExternalAgentStore) => T,
): T {
	return withFileLockSync(
		join(resolveStoreDir(options), "locks", "external-agent-store"),
		() => {
			const store = readStore(options);
			const result = operation(store);
			writeStore(store, options);
			return result;
		},
	);
}

/** Serialize issuance before reading a workspace profile. The store lock stays
 * short and separate so unrelated workspace calls can continue during network I/O. */
export async function withExternalAgentStartLock<T>(
	workspace: string,
	operation: () => Promise<T>,
	options?: ExternalAgentStoreOptions,
): Promise<T> {
	const key = createHash("sha256").update(workspace).digest("hex");
	const lock = beginFileLock(
		join(resolveStoreDir(options), "locks", `external-agent-start-${key}`),
	);
	const deadline = Date.now() + 60_000;
	try {
		while (!lock.ready()) {
			if (Date.now() >= deadline)
				throw new Error(
					"Another agent start is using this workspace. Retry after it finishes; no credentials were issued by this waiting command.",
				);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return await operation();
	} finally {
		lock.release();
	}
}

function sameProfileIdentity(
	a: StoredExternalAgentProfile,
	b: StoredExternalAgentProfile,
): boolean {
	return (
		[
			"organizationId",
			"principalId",
			"key",
			"apiKeyId",
			"rawApiKey",
			"mcpUrl",
		].every(
			(key) =>
				a[key as keyof StoredExternalAgentProfile] ===
				b[key as keyof StoredExternalAgentProfile],
		) && [...a.scopes].sort().join("\0") === [...b.scopes].sort().join("\0")
	);
}

function assertProfileIdentity(
	current: StoredExternalAgentProfile | undefined,
	profile: StoredExternalAgentProfile,
): void {
	if (current && !sameProfileIdentity(current, profile))
		throw new Error(
			"The external-agent workspace profile changed concurrently; the existing principal and sessions were preserved. Inspect tedix agent status before retrying.",
		);
}

export function readExternalAgentProfile(
	workspace: string,
	options?: ExternalAgentStoreOptions,
): StoredExternalAgentProfile | null {
	return readStore(options).workspaces[workspace] ?? null;
}

export function writeExternalAgentProfile(
	workspace: string,
	profile: StoredExternalAgentProfile,
	options?: ExternalAgentStoreOptions,
): void {
	mutateStore(options, (store) => {
		const current = store.workspaces[workspace];
		assertProfileIdentity(current, profile);
		store.workspaces[workspace] = {
			...profile,
			sessions: { ...current?.sessions, ...profile.sessions },
		};
	});
}

/** Commit only the issued session; never replay a stale snapshot of peer sessions. */
export function writeExternalAgentSession(
	workspace: string,
	profile: StoredExternalAgentProfile,
	session: StoredExternalAgentSession,
	options?: ExternalAgentStoreOptions,
): StoredExternalAgentProfile {
	return mutateStore(options, (store) => {
		const current = store.workspaces[workspace];
		if (!current)
			throw new Error(
				"External-agent profile disappeared during session issuance; inspect agent status before retrying.",
			);
		assertProfileIdentity(current, profile);
		const updated = {
			...current,
			sessions: { ...current.sessions, [session.externalSessionKey]: session },
		};
		store.workspaces[workspace] = updated;
		return updated;
	});
}

/**
 * Every workspace whose stored profile records this Agent-Session.
 *
 * Sessions are nested per workspace, so the same key can legitimately exist
 * under several. `sessionWorkspaceDrift` uses this to tell "the shared
 * workspace selection moved underneath me" apart from "this session genuinely
 * belongs to the workspace I resolved".
 *
 * Matching mirrors `findStoredSession`: an exact key, or — for a bare id with
 * no harness prefix — a unique suffix match. Diverging from it would let the
 * guard disagree with the resolution it is meant to protect.
 */
export function externalAgentSessionWorkspaces(
	externalSessionKey: string,
	options?: ExternalAgentStoreOptions,
): string[] {
	const key = externalSessionKey.trim();
	if (!key) return [];
	const bare = !key.includes(":");
	const found: string[] = [];
	for (const [workspace, profile] of Object.entries(
		readStore(options).workspaces,
	)) {
		const match =
			key in profile.sessions ||
			(bare &&
				Object.values(profile.sessions).some(
					(session) => session.externalSessionKey.split(":").at(-1) === key,
				));
		if (match) found.push(workspace);
	}
	return found;
}

export function removeExternalAgentSession(
	workspace: string,
	externalSessionKey: string,
	options?: ExternalAgentStoreOptions,
): void {
	mutateStore(options, (store) => {
		const profile = store.workspaces[workspace];
		if (!profile || !(externalSessionKey in profile.sessions)) return;
		delete profile.sessions[externalSessionKey];
		if (store.credentials) delete store.credentials[workspace];
	});
}

// Credential secrets stay outside profile/session objects exposed by status commands.
function credentialBinding(
	profile: StoredExternalAgentProfile,
	session: StoredExternalAgentSession,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				profile.organizationId,
				profile.principalId,
				profile.apiKeyId,
				profile.rawApiKey,
				profile.mcpUrl,
				[...profile.scopes].sort(),
				session,
			]),
		)
		.digest("hex");
}

export function readExternalAgentCredential(
	workspace: string,
	profile: StoredExternalAgentProfile,
	session: StoredExternalAgentSession,
	options?: ExternalAgentStoreOptions,
): string | undefined {
	const store = readStore(options);
	const cached = store.credentials?.[workspace];
	const current = store.workspaces[workspace];
	const currentSession = current?.sessions[session.externalSessionKey];
	return cached &&
		current &&
		currentSession &&
		credentialBinding(current, currentSession) ===
			credentialBinding(profile, session) &&
		cached.expiresAt > Date.now() &&
		cached.binding === credentialBinding(profile, session)
		? cached.accessToken
		: undefined;
}

export function writeExternalAgentCredential(
	workspace: string,
	profile: StoredExternalAgentProfile,
	session: StoredExternalAgentSession,
	accessToken: string,
	expiresAt: number,
	options?: ExternalAgentStoreOptions,
): void {
	mutateStore(options, (store) => {
		// Do not cache against a profile or session changed during the exchange.
		const current = store.workspaces[workspace];
		const currentSession = current?.sessions[session.externalSessionKey];
		if (
			!current ||
			!currentSession ||
			credentialBinding(current, currentSession) !==
				credentialBinding(profile, session)
		)
			return;
		store.credentials = {
			...store.credentials,
			[workspace]: {
				binding: credentialBinding(profile, session),
				accessToken,
				expiresAt,
			},
		};
	});
}
