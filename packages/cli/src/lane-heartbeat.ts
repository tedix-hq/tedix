import { isRecord } from "@tedix/api-contract/utils/is-record";
import { fileDiscoveryCache } from "./discovery-cache";
import { resolveExternalAgentAuth } from "./external-agent";
import { CliReadError } from "./hooks/hook-io";
import { TedixHomeClient, type TedixHomeClientOptions } from "./home-client";
import { fileNativeBootstrapCache } from "./native-bootstrap-cache";
import { recordSessionScope } from "./session-scope";
import { createFileWorkAttemptStore } from "./work-attempt-store";
import { isHeartbeatCredentialRejected } from "./work-lifecycle";
import { boardCall, nativeCommands } from "./work-native";
import type { NativeToolContext } from "./work";

interface LeaseReceipt {
	itemId: string;
	attemptId?: string;
	session?: string;
	executorKey?: string;
}

const heartbeatTimeoutMs = 45_000;

export function createLaneHeartbeat(
	scope: string[],
	deps: {
		auth: typeof resolveExternalAgentAuth;
		attemptStore: ReturnType<typeof createFileWorkAttemptStore>;
		fetch?: TedixHomeClientOptions["fetch"];
	} = {
		auth: resolveExternalAgentAuth,
		attemptStore: createFileWorkAttemptStore(),
	},
) {
	const workspace = scope[scope.indexOf("--workspace") + 1]!;
	const organization = scope[scope.indexOf("--organization") + 1]!;
	const bootstrapCache = fileNativeBootstrapCache();
	const discoveryCache = fileDiscoveryCache();
	const connections = new WeakMap<
		LeaseReceipt,
		Awaited<ReturnType<typeof connect>>
	>();
	const inFlight = new Map<string, Promise<{ expiresAt: string }>>();

	async function connect(sessionKey: string, selector: string) {
		const auth = await deps.auth({
			workspace,
			organization,
			sessionKey,
			selector,
			sessionExchangeTimeoutMs: 15_000,
		});
		if (!auth.mcpUrl) throw new Error("The admitted executor has no gateway");
		const client = new TedixHomeClient({
			url: auth.mcpUrl,
			headers: auth.headers,
			credentialProvider: auth.credentialProvider,
			skipSharedGatewayCooldown: true,
			timeoutMs: heartbeatTimeoutMs,
			discoveryCache,
			fetch: deps.fetch,
		});
		return { auth, client, protocolSequence: {} };
	}

	async function renew(
		receipt: LeaseReceipt,
		attemptId: string,
		session: string,
		executorKey: string,
	) {
		const deadlineAt = Date.now() + heartbeatTimeoutMs;
		const id = receipt.itemId;
		const checkFence = () => {
			const cached = deps.attemptStore.get({
				workspace,
				actor: "credential",
				agentSession: session,
				workItemId: id,
			});
			if (cached !== attemptId)
				throw new CliReadError(
					"Heartbeat stopped: the cached Attempt differs from the dispatcher fence.",
					"STALE_ATTEMPT",
				);
		};
		checkFence();
		let connection = connections.get(receipt);
		if (!connection) {
			connection = await connect(session, executorKey);
			connections.set(receipt, connection);
		}
		const { auth, client, protocolSequence } = connection;
		const ctx: NativeToolContext = {
			client,
			workspace,
			mcpUrl: auth.mcpUrl,
			bootstrapCache,
			nativeCacheScope: JSON.stringify([workspace, auth.source]),
		};
		nativeCommands.set(ctx, { deadlineAt, protocolSequence });
		const touch = () => {
			checkFence();
			return boardCall(ctx, "work.heartbeat_work_item_attempt", {
				id,
				attemptId,
			});
		};
		let result = await touch();
		if (
			result.error &&
			auth.discardCredential &&
			isHeartbeatCredentialRejected(result.error)
		) {
			auth.discardCredential();
			result = await touch();
		}
		if (result.error) {
			connection.protocolSequence = {};
			throw new CliReadError(
				result.error.message,
				result.error.code,
				result.error.status,
			);
		}
		const expiresAt = isRecord(result.value)
			? result.value.expiresAt
			: undefined;
		const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
		if (typeof expiresAt !== "string" || !Number.isFinite(expiry))
			throw new Error("Heartbeat returned no valid lease expiry");
		if (expiry > Date.now())
			recordSessionScope(
				{
					workspace,
					organization,
					workItemId: id,
					heldUntil: expiry,
				},
				{ TEDIX_AGENT_SESSION: session },
			);
		return { expiresAt };
	}

	return (receipt: LeaseReceipt): Promise<{ expiresAt: string }> => {
		const { attemptId, session, executorKey } = receipt;
		if (!attemptId || !session || !executorKey)
			return Promise.reject(
				new Error("Heartbeat requires an admitted Attempt and executor"),
			);
		const pending = inFlight.get(attemptId);
		if (pending) return pending;
		const renewal = renew(receipt, attemptId, session, executorKey).finally(
			() => {
				inFlight.delete(attemptId);
			},
		);
		inFlight.set(attemptId, renewal);
		return renewal;
	};
}
