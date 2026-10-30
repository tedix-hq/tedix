import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	credentialDirectory,
	readWorkspaceCredentials,
	type WorkspaceCredential,
} from "./credential-store";
import { acquireCredentialLock } from "./credential-lock";
import { TedixHomeClient } from "./home-client";
import { listAvailableWorkspaces } from "./account";
import { isExpiredSessionError } from "./home-payload";

export type LoginVerification = "usable" | "rejected" | "unknown";
interface RecoveryState {
	status: LoginVerification;
	checkedAt: number;
	notifyAfter?: number;
	decision?: {
		session: string;
		executorKey: string;
		workItemId: string;
		requestId?: string;
	};
}

/** Bound to the exact grant and resource; a new login automatically releases the hold. */
export function loginRecoveryKey(
	workspace: string,
	credential: WorkspaceCredential,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				workspace,
				credential.loginId,
				credential.mcpUrl,
				credential.org,
				credential.oauthTokens?.access_token,
				credential.oauthTokens?.refresh_token,
			]),
		)
		.digest("hex");
}

function statePath(key: string) {
	return join(credentialDirectory(), "login-recovery", `${key}.json`);
}

export function readLoginRecovery(key: string): RecoveryState | undefined {
	try {
		return JSON.parse(readFileSync(statePath(key), "utf8"));
	} catch {
		return undefined;
	}
}

export function saveLoginRecovery(key: string, state: RecoveryState): void {
	mkdirSync(join(credentialDirectory(), "login-recovery"), {
		recursive: true,
		mode: 0o700,
	});
	const path = statePath(key);
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
	renameSync(temp, path);
}

/** An authenticated API read, with no OAuth provider and therefore no refresh or consent. */
export async function verifyStoredAccess(
	credential: WorkspaceCredential,
): Promise<LoginVerification> {
	const token = credential.oauthTokens?.access_token;
	if (!token || !credential.mcpUrl) return "rejected";
	let rejected = false;
	const signal = AbortSignal.timeout(5_000);
	const client = new TedixHomeClient({
		url: credential.mcpUrl,
		headers: {
			Authorization: `Bearer ${token}`,
			...(credential.org ? { "X-Tedix-Organization": credential.org } : {}),
		},
		timeoutMs: 5_000,
		fetch: async (input, init) => {
			const response = await fetch(input, { ...init, signal });
			if (response.status === 401) rejected = true;
			return response;
		},
	});
	try {
		const rows = await listAvailableWorkspaces({ client });
		return rows.length > 0 ? "usable" : "unknown";
	} catch (error) {
		return rejected || isExpiredSessionError(error) ? "rejected" : "unknown";
	} finally {
		await client.close();
	}
}

export async function confirmStoredAccess(
	workspace: string,
	credential: WorkspaceCredential,
	verify = verifyStoredAccess,
): Promise<LoginVerification> {
	const key = loginRecoveryKey(workspace, credential);
	const lock = await acquireCredentialLock(workspace);
	if (!lock) return "unknown";
	try {
		const current = readWorkspaceCredentials(workspace);
		if (current && loginRecoveryKey(workspace, current) !== key)
			return "unknown";
		const state = readLoginRecovery(key);
		const now = Date.now();
		const usableUntil = Math.min(
			(state?.checkedAt ?? 0) + 30_000,
			credential.accessTokenExpiresAtSeconds
				? credential.accessTokenExpiresAtSeconds * 1000
				: Infinity,
		);
		if (
			state &&
			(state.status === "rejected" ||
				(state.status === "usable"
					? now < usableUntil
					: now - state.checkedAt < 60_000))
		)
			return state.status;
		const status = await verify(credential);
		saveLoginRecovery(key, { ...state, status, checkedAt: Date.now() });
		return status;
	} finally {
		lock.release();
	}
}
