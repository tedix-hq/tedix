import type { FetchLike } from "@modelcontextprotocol/client";
import { acquireCredentialLock } from "./credential-lock";
import {
	readWorkspaceCredentials,
	removeWorkspace,
	type WorkspaceCredential,
} from "./credential-store";

const LOGOUT_REVOCATION_TIMEOUT_MS = 5_000;

export type GrantRevocationOutcome =
	| "revoked"
	| "no-grant"
	| "unsupported"
	| "failed";

/**
 * Deleting local credentials leaves copies of the grant usable. Revoke only at
 * the endpoint recorded at login; never guess where to send a refresh token.
 */
export async function revokeWorkspaceGrant(
	credential: WorkspaceCredential,
	options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<GrantRevocationOutcome> {
	const refreshToken = credential.oauthTokens?.refresh_token;
	// An invalidated family is already dead server-side.
	if (!refreshToken || credential.oauthRefreshInvalidated) return "no-grant";
	const client = credential.oauthClientInformation;
	const metadata = credential.oauthDiscoveryState?.authorizationServerMetadata;
	const endpoint = httpsUrl(
		metadata && "revocation_endpoint" in metadata
			? metadata.revocation_endpoint
			: undefined,
	);
	if (!client?.client_id || !endpoint) return "unsupported";
	const body = new URLSearchParams({
		token: refreshToken,
		token_type_hint: "refresh_token",
		client_id: client.client_id,
	});
	if (client.client_secret) body.set("client_secret", client.client_secret);
	try {
		const response = await (options.fetchFn ?? fetch)(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			redirect: "error",
			signal: AbortSignal.timeout(
				options.timeoutMs ?? LOGOUT_REVOCATION_TIMEOUT_MS,
			),
		});
		// RFC 7009 §2.2: an unknown or already-invalid token also answers 200.
		return response.status === 200 ? "revoked" : "failed";
	} catch {
		return "failed";
	}
}

function httpsUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return new URL(value).protocol === "https:" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Revoke the stored grant, then remove the local login, both under the
 * workspace's refresh lock and from a fresh read: refresh tokens rotate, so a
 * token read before a concurrent renewal finished would revoke a superseded
 * value and leave the live one valid. The local login is removed even when
 * revocation fails; the outcome tells the caller what the server was told.
 */
export async function logoutWorkspace(
	workspace: string,
	options: {
		fetchFn?: FetchLike;
		timeoutMs?: number;
		lockWaitMs?: number;
	} = {},
): Promise<GrantRevocationOutcome> {
	const lock = await acquireCredentialLock(workspace, {
		waitMs: options.lockWaitMs,
	});
	if (!lock)
		throw new Error(
			`Workspace "${workspace}" is busy renewing its sign-in. Retry logout; credentials were kept.`,
		);
	try {
		const credential = readWorkspaceCredentials(workspace);
		if (!credential) return "no-grant";
		return await revokeWorkspaceGrant(credential, options);
	} finally {
		try {
			removeWorkspace(workspace);
		} finally {
			lock.release();
		}
	}
}

export function logoutMessage(
	workspace: string,
	outcome: GrantRevocationOutcome,
): string {
	switch (outcome) {
		case "revoked":
			return `Logged out of workspace "${workspace}" and revoked its sign-in.`;
		case "no-grant":
			return `Logged out of workspace "${workspace}".`;
		case "unsupported":
			return `Warning: removed workspace "${workspace}" locally, but no usable revocation endpoint was recorded; its sign-in may remain valid until it expires.`;
		case "failed":
			return `Warning: removed workspace "${workspace}" locally, but could not revoke its sign-in; it stays valid until it expires.`;
	}
}
