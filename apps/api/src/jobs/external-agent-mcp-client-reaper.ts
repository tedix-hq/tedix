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
 * deletes/day.
 *
 * This job deletes the Descope client of every credential row that expired or
 * was revoked without its deletion finishing. It only deletes clients a
 * credential row names, so tedi clients, M2M binding clients and clients no
 * row recorded (Claude Code, ChatGPT, the Tedix CLI) are never touched; the
 * candidate query also excludes M2M binding ids. Unexpired active credentials
 * stay untouched. A cleanup timestamp is recorded only after deletion succeeds
 * or Descope says the client is already gone. A failed delete is marked so the
 * row moves to the back of the queue and the rest keeps draining.
 *
 * Descope allows about 100 management calls per 60 s across the project, and
 * credential issuance shares that budget, so each run spends at most
 * {@link MAX_CALLS_PER_TICK} calls, one per {@link CALL_INTERVAL_MS}.
 */

const MAX_REAP_PER_TICK = 2_000;
const DELETE_CHUNK = 100;
const MAX_CALLS_PER_TICK = 60;
const CALL_INTERVAL_MS = 1_000;

/** Status and a bounded slice of the provider's answer; never request data. */
function describeDescopeError(error: unknown): {
	status: number | null;
	detail: string;
} {
	const message = error instanceof Error ? error.message : String(error);
	const status = /\[(\d{3})\b/.exec(message)?.[1];
	return {
		status: status ? Number(status) : null,
		detail: message.slice(0, 500),
	};
}

function isDescopeNotFound(error: unknown): boolean {
	const { status, detail } = describeDescopeError(error);
	return status === 404 || /not[\s_-]?found/i.test(detail);
}

export async function runExternalAgentMcpClientReaperTick(
	env: CloudflareEnv,
	runId: string,
	options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<Record<string, number>> {
	// Local without Descope management creds: nothing to reap remotely.
	if (!env.DESCOPE_PROJECT_ID || !env.DESCOPE_MANAGEMENT_KEY) return {};

	const { createDbClient } = await import("@tedix/db/client");
	const { requireAihEnv } = await import("../rpc/routers/descope-aih-env");
	const { deleteDescopeMcpServerClient, deleteDescopeMcpServerClients } =
		await import("@tedix/auth/aih-client");
	const {
		listReapableExternalAgentMcpCredentials,
		markExternalAgentMcpCredentialCleanupAttempted,
		markExternalAgentMcpCredentialsReaped,
	} = await import("@tedix/db/queries/external-agent-identity/mcp-credentials");

	const db = createDbClient(env.DB);
	const aihEnv = requireAihEnv(env);
	const nowIso = new Date().toISOString();
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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

	// Descope's batch delete is per-server, so group the ids by server.
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

	let calls = 0;
	const call = async <T>(operation: () => Promise<T>): Promise<T> => {
		if (calls > 0) await sleep(CALL_INTERVAL_MS);
		calls++;
		return operation();
	};
	const deletedClientRecordIds: string[] = [];
	const failedClientRecordIds: string[] = [];
	let batchFailures = 0;
	let alreadyGone = 0;
	let deferred = 0;
	for (const [mcpServerId, ids] of idsByServer) {
		for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
			const chunk = ids.slice(i, i + DELETE_CHUNK);
			if (calls >= MAX_CALLS_PER_TICK) {
				deferred += chunk.length;
				continue;
			}
			try {
				await call(() =>
					deleteDescopeMcpServerClients(aihEnv, { ids: chunk, mcpServerId }),
				);
				deletedClientRecordIds.push(...chunk);
				continue;
			} catch (error) {
				batchFailures++;
				console.error(
					JSON.stringify({
						job: "external-agent-mcp-client-reaper",
						runId,
						event: "batch_delete_failed",
						mcpServerId,
						ids: chunk.length,
						...describeDescopeError(error),
					}),
				);
			}
			// One bad id must not hold back the other 99: delete one by one.
			for (const id of chunk) {
				if (calls >= MAX_CALLS_PER_TICK) {
					deferred++;
					continue;
				}
				try {
					await call(() =>
						deleteDescopeMcpServerClient(aihEnv, { id, mcpServerId }),
					);
					deletedClientRecordIds.push(id);
				} catch (error) {
					if (isDescopeNotFound(error)) {
						alreadyGone++;
						deletedClientRecordIds.push(id);
						continue;
					}
					failedClientRecordIds.push(id);
					console.error(
						JSON.stringify({
							job: "external-agent-mcp-client-reaper",
							runId,
							event: "client_delete_failed",
							mcpServerId,
							clientRecordId: id,
							...describeDescopeError(error),
						}),
					);
				}
			}
		}
	}

	const revoked = await markExternalAgentMcpCredentialsReaped(db, {
		clientRecordIds: [...deletedClientRecordIds, ...expiredFederatedIds],
		revokedAt: nowIso,
	});
	if (failedClientRecordIds.length)
		await markExternalAgentMcpCredentialCleanupAttempted(db, {
			clientRecordIds: failedClientRecordIds,
			attemptedAt: nowIso,
		});

	const counts = {
		candidates: reapable.length,
		deleted: deletedClientRecordIds.length,
		alreadyGone,
		deleteFailures: failedClientRecordIds.length,
		batchFailures,
		deferred,
		managementCalls: calls,
		revoked,
	};
	console.log(
		JSON.stringify({
			job: "external-agent-mcp-client-reaper",
			runId,
			asOf: nowIso,
			...counts,
		}),
	);
	return counts;
}
