import { safeExceptionTopology } from "../lib/safe-log-metadata";
/// <reference path="../../worker-configuration.d.ts" />
/**
 * External-agent MCP client reaper.
 *
 * Every `tedix agent start` / credential refresh registers a pre-registered
 * Descope MCP server client (a TPA) and records an `external_agent_mcp_credentials`
 * row. Credential *reuse* is meant to keep one client per (org, principal,
 * session, server), but when reuse does not engage a fresh client is minted on
 * every refresh — production has seen ~1 client per 60s per active session,
 * thousands of live TPAs on a single server, and ~1,800 creates/day against ~14
 * deletes/day. Nothing drained them: the issuance path deletes a client only on
 * its own error, and `revokeMcpCredential` fires only on explicit revocation.
 *
 * This job deletes expired active clients and retries unfinished deletions for
 * disabled principals. Local revocation denies disabled credentials before any
 * provider call. Unexpired credentials on active principals stay untouched.
 * Provider deletion is idempotent; a cleanup timestamp is recorded only after
 * deletion succeeds, so failed deletes or ledger writes retry on a later tick.
 */

const MAX_REAP_PER_TICK = 500;
const DELETE_CHUNK = 100;

export async function runExternalAgentMcpClientReaperTick(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	// Local without Descope management creds: nothing to reap remotely.
	if (!env.DESCOPE_PROJECT_ID || !env.DESCOPE_MANAGEMENT_KEY) return {};

	const { createDbClient } = await import("@tedix/db/client");
	const { requireAihEnv } = await import("../rpc/routers/descope-aih-env");
	const { deleteDescopeMcpServerClients } =
		await import("@tedix/auth/aih-client");
	const {
		listReapableExternalAgentMcpCredentials,
		markExternalAgentMcpCredentialsReaped,
	} = await import("@tedix/db/queries/external-agent-identity/mcp-credentials");

	const db = createDbClient(env.DB);
	const aihEnv = requireAihEnv(env);
	const nowIso = new Date().toISOString();

	const reapable = await listReapableExternalAgentMcpCredentials(db, {
		expiredBefore: nowIso,
		limit: MAX_REAP_PER_TICK,
	});
	if (reapable.length === 0) {
		console.log(
			JSON.stringify({
				job: "external-agent-mcp-client-reaper",
				runId,
				asOf: nowIso,
				candidates: 0,
				deleted: 0,
				revoked: 0,
			}),
		);
		return { candidates: 0, deleted: 0, revoked: 0 };
	}

	// Descope's batch delete is per-server, so group the expired ids by server.
	const idsByServer = new Map<string, string[]>();
	const expiredFederatedIds: string[] = [];
	for (const row of reapable) {
		// Federated credentials own no remote client; only expire the local ledger.
		if (row.clientRecordId.startsWith("wif:")) {
			expiredFederatedIds.push(row.clientRecordId);
			continue;
		}
		const ids = idsByServer.get(row.mcpServerId) ?? [];
		ids.push(row.clientRecordId);
		idsByServer.set(row.mcpServerId, ids);
	}

	const deletedClientRecordIds: string[] = [];
	let deleteFailures = 0;
	for (const [mcpServerId, ids] of idsByServer) {
		for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
			const chunk = ids.slice(i, i + DELETE_CHUNK);
			try {
				await deleteDescopeMcpServerClients(aihEnv, {
					ids: chunk,
					mcpServerId,
				});
				deletedClientRecordIds.push(...chunk);
			} catch (error) {
				// Leave cleanup unfinished so a later tick retries these clients.
				deleteFailures += chunk.length;
				console.error(
					`[external-agent-mcp-client-reaper] batch delete failed for server ${mcpServerId} (${chunk.length} ids)`,
					{ exception: safeExceptionTopology(error) },
				);
			}
		}
	}

	const revoked = await markExternalAgentMcpCredentialsReaped(db, {
		clientRecordIds: [...deletedClientRecordIds, ...expiredFederatedIds],
		revokedAt: nowIso,
	});

	console.log(
		JSON.stringify({
			job: "external-agent-mcp-client-reaper",
			runId,
			asOf: nowIso,
			candidates: reapable.length,
			deleted: deletedClientRecordIds.length,
			deleteFailures,
			revoked,
		}),
	);
	return {
		candidates: reapable.length,
		deleted: deletedClientRecordIds.length,
		deleteFailures,
		revoked,
	};
}
