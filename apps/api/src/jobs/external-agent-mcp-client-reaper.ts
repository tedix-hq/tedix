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
 * stay untouched.
 *
 * Descope fails a whole batch delete when one id no longer exists (400
 * E113118), so each run first lists each server's clients once. Candidates
 * missing from that list are recorded as cleaned without a Descope call; only
 * the rest are batch-deleted. An empty list is trusted only when the
 * project's MCP server list (loaded once a run) no longer has that server;
 * then every candidate of the server is recorded as cleaned. A batch that still fails is retried one client
 * at a time. Rows left unresolved, or deferred by the call budget, are marked
 * so they move to the back of the queue and the rest keeps draining. A
 * cleanup timestamp is recorded only after deletion succeeds or Descope shows
 * the client is gone.
 *
 * Descope allows about 100 management calls per 60 s across the project, and
 * credential issuance shares that budget, so each run spends at most
 * {@link MAX_CALLS_PER_TICK} calls, one per {@link CALL_INTERVAL_MS}.
 */

const MAX_REAP_PER_TICK = 2_000;
const DELETE_CHUNK = 100;
const MAX_CALLS_PER_TICK = 60;
const CALL_INTERVAL_MS = 1_000;
/** One attempt: the Tedix Unified list is ~17.5 MB and takes ~3 s. */
const LIST_TIMEOUT_MS = 15_000;
const WRITE_CHUNK = 50;
const WRITE_INTERVAL_MS = 50;

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
	return status === 404 || /E113118|not[\s_-]?found/i.test(detail);
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
	const {
		deleteDescopeMcpServerClient,
		deleteDescopeMcpServerClients,
		loadAllDescopeMcpServers,
		searchDescopeMcpServerClients,
	} = await import("@tedix/auth/aih-client");
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
	const log = (fields: Record<string, unknown>) =>
		JSON.stringify({
			job: "external-agent-mcp-client-reaper",
			runId,
			...fields,
		});

	const reapable = await listReapableExternalAgentMcpCredentials(db, {
		expiredBefore: nowIso,
		limit: MAX_REAP_PER_TICK,
	});
	if (reapable.length === 0) {
		console.log(log({ asOf: nowIso, candidates: 0, deleted: 0, revoked: 0 }));
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
	// Each server gets an equal share of what is left of the call budget, so
	// one server's backlog cannot starve the others.
	let budget = MAX_CALLS_PER_TICK;
	const call = async <T>(operation: () => Promise<T>): Promise<T> => {
		if (calls > 0) await sleep(CALL_INTERVAL_MS);
		calls++;
		return operation();
	};
	const deletedClientRecordIds: string[] = [];
	const missingClientRecordIds: string[] = [];
	const unresolvedClientRecordIds: string[] = [];
	let listed = 0;
	let listFailures = 0;
	let serverGoneMarkedDone = 0;
	// Loaded at most once a run, and only when a client list comes back empty.
	let liveServerIds: Promise<Set<string> | null> | undefined;
	const serverStillExists = async (
		mcpServerId: string,
	): Promise<boolean | null> => {
		liveServerIds ??= call(() => loadAllDescopeMcpServers(aihEnv)).then(
			(servers) => {
				const ids = new Set(servers.map((server) => server.id));
				// An empty answer is not trusted to mean every server is gone.
				return ids.size ? ids : null;
			},
			(error) => {
				console.error(
					log({ event: "server_list_failed", ...describeDescopeError(error) }),
				);
				return null;
			},
		);
		const ids = await liveServerIds;
		return ids ? ids.has(mcpServerId) : null;
	};
	let batchFailures = 0;
	let alreadyGone = 0;
	let deleteFailures = 0;
	let deferred = 0;
	let serversLeft = idsByServer.size;
	for (const [mcpServerId, ids] of idsByServer) {
		budget = Math.min(
			MAX_CALLS_PER_TICK,
			calls +
				Math.max(1, Math.floor((MAX_CALLS_PER_TICK - calls) / serversLeft--)),
		);
		let pending = ids;
		if (calls < budget) {
			try {
				const existing = new Set(
					(
						await call(() =>
							searchDescopeMcpServerClients(
								aihEnv,
								{ mcpServerId },
								{
									deadline: Date.now() + LIST_TIMEOUT_MS,
									timeoutMs: LIST_TIMEOUT_MS,
								},
							),
						)
					).map((client) => client.id),
				);
				if (existing.size === 0) {
					// No clients at all: either the server is gone, and so are all
					// its clients, or the answer is not trusted.
					if ((await serverStillExists(mcpServerId)) === false) {
						serverGoneMarkedDone += ids.length;
						missingClientRecordIds.push(...ids);
						continue;
					}
					throw new Error("MCP server client list came back empty");
				}
				listed += existing.size;
				pending = ids.filter((id) => existing.has(id));
				missingClientRecordIds.push(...ids.filter((id) => !existing.has(id)));
			} catch (error) {
				// Without the list, delete as before and resolve misses one by one.
				listFailures++;
				console.error(
					log({
						event: "client_list_failed",
						mcpServerId,
						...describeDescopeError(error),
					}),
				);
			}
		}
		for (let i = 0; i < pending.length; i += DELETE_CHUNK) {
			const chunk = pending.slice(i, i + DELETE_CHUNK);
			if (calls >= budget) {
				deferred += chunk.length;
				unresolvedClientRecordIds.push(...chunk);
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
					log({
						event: "batch_delete_failed",
						mcpServerId,
						ids: chunk.length,
						...describeDescopeError(error),
					}),
				);
			}
			// One bad id must not hold back the others: delete one by one.
			for (const id of chunk) {
				if (calls >= budget) {
					deferred++;
					unresolvedClientRecordIds.push(id);
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
					deleteFailures++;
					unresolvedClientRecordIds.push(id);
					console.error(
						log({
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

	// At most MAX_REAP_PER_TICK rows, written 50 at a time with a short pause.
	let writes = 0;
	const paced = async (
		ids: string[],
		write: (chunk: string[]) => Promise<unknown>,
	) => {
		for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
			if (writes++ > 0) await sleep(WRITE_INTERVAL_MS);
			await write(ids.slice(i, i + WRITE_CHUNK));
		}
	};
	let revoked = 0;
	await paced(
		[
			...deletedClientRecordIds,
			...missingClientRecordIds,
			...expiredFederatedIds,
		],
		async (chunk) => {
			revoked += await markExternalAgentMcpCredentialsReaped(db, {
				clientRecordIds: chunk,
				revokedAt: nowIso,
			});
		},
	);
	await paced(unresolvedClientRecordIds, (chunk) =>
		markExternalAgentMcpCredentialCleanupAttempted(db, {
			clientRecordIds: chunk,
			attemptedAt: nowIso,
		}),
	);

	const counts = {
		candidates: reapable.length,
		listed,
		listFailures,
		serverGoneMarkedDone,
		missingMarkedDone: missingClientRecordIds.length,
		deleted: deletedClientRecordIds.length,
		alreadyGone,
		deleteFailures,
		batchFailures,
		deferred,
		markedAttempted: unresolvedClientRecordIds.length,
		managementCalls: calls,
		revoked,
	};
	console.log(log({ asOf: nowIso, ...counts }));
	return counts;
}
