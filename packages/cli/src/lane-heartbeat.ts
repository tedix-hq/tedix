import { isRecord } from "@tedix/api-contract/utils/is-record";
import { fileDiscoveryCache } from "./discovery-cache";
import { resolveExternalAgentAuth } from "./external-agent";
import { CliReadError } from "./hooks/hook-io";
import { TedixHomeClient, type TedixHomeClientOptions } from "./home-client";
import { fileNativeBootstrapCache } from "./native-bootstrap-cache";
import { recordSessionScope } from "./session-scope";
import { createFileWorkAttemptStore } from "./work-attempt-store";
import { RunStepsUnavailableError } from "./lane-steps";
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

type LaneGatewayDeps = {
	auth: typeof resolveExternalAgentAuth;
	attemptStore: ReturnType<typeof createFileWorkAttemptStore>;
	fetch?: TedixHomeClientOptions["fetch"];
};

/** One in-process gateway connection per admitted run, under its own identity. */
function laneGateway(scope: string[], deps: LaneGatewayDeps) {
	const workspace = scope[scope.indexOf("--workspace") + 1]!;
	const organization = scope[scope.indexOf("--organization") + 1]!;
	const bootstrapCache = fileNativeBootstrapCache();
	const discoveryCache = fileDiscoveryCache();
	const connections = new WeakMap<
		LeaseReceipt,
		Awaited<ReturnType<typeof connect>>
	>();

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

	/** The run's connection and a call context that ends at `deadlineAt`. */
	async function open(
		receipt: LeaseReceipt,
		session: string,
		executorKey: string,
		deadlineAt: number,
	) {
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
		return { connection, ctx };
	}

	/** Refuses once the cached Attempt differs from the one the run holds. */
	function checkFence(
		receipt: LeaseReceipt,
		attemptId: string,
		session: string,
		what: string,
	) {
		const cached = deps.attemptStore.get({
			workspace,
			actor: "credential",
			agentSession: session,
			workItemId: receipt.itemId,
		});
		if (cached !== attemptId)
			throw new CliReadError(
				`${what} stopped: the cached Attempt differs from the dispatcher fence.`,
				"STALE_ATTEMPT",
			);
	}

	return { workspace, organization, open, checkFence };
}

const defaultGatewayDeps = (): LaneGatewayDeps => ({
	auth: resolveExternalAgentAuth,
	attemptStore: createFileWorkAttemptStore(),
});

export function createLaneHeartbeat(
	scope: string[],
	deps: LaneGatewayDeps = defaultGatewayDeps(),
) {
	const gateway = laneGateway(scope, deps);
	const { workspace, organization } = gateway;
	const inFlight = new Map<string, Promise<{ expiresAt: string }>>();

	async function renew(
		receipt: LeaseReceipt,
		attemptId: string,
		session: string,
		executorKey: string,
	) {
		const deadlineAt = Date.now() + heartbeatTimeoutMs;
		const id = receipt.itemId;
		const checkFence = () =>
			gateway.checkFence(receipt, attemptId, session, "Heartbeat");
		checkFence();
		const { connection, ctx } = await gateway.open(
			receipt,
			session,
			executorKey,
			deadlineAt,
		);
		const { auth } = connection;
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

const stepTimeoutMs = 20_000;

/**
 * Sends a run's steps under the Attempt the run holds and returns the server's
 * answer, which carries the messages people sent to the run. A server without
 * the step tool is reported as RunStepsUnavailableError; anything else is a
 * failure the caller may retry.
 */
export function createLaneStepSender(
	scope: string[],
	deps: LaneGatewayDeps = defaultGatewayDeps(),
) {
	const gateway = laneGateway(scope, deps);
	return async (
		receipt: LeaseReceipt,
		steps: Array<{
			seq: number;
			at: number;
			kind: string;
			text: string;
			choices?: string[];
		}>,
		appliedMessageIds: string[],
	): Promise<unknown> => {
		const { attemptId, session, executorKey } = receipt;
		if (!attemptId || !session || !executorKey)
			throw new Error("Run steps require an admitted Attempt and executor");
		gateway.checkFence(receipt, attemptId, session, "Run steps");
		const { connection, ctx } = await gateway.open(
			receipt,
			session,
			executorKey,
			Date.now() + stepTimeoutMs,
		);
		const result = await boardCall(ctx, "work.append_work_attempt_steps", {
			id: receipt.itemId,
			attemptId,
			steps,
			...(appliedMessageIds.length ? { appliedMessageIds } : {}),
		});
		if (!result.error) return result.value;
		connection.protocolSequence = {};
		if (runStepToolMissing(result.error.message))
			throw new RunStepsUnavailableError(result.error.message.slice(0, 300));
		throw new CliReadError(
			result.error.message,
			result.error.code,
			result.error.status,
		);
	};
}

/** Whether a refusal says the server has no usable step tool for this login. */
export function runStepToolMissing(message: string): boolean {
	return /^(?:Error: )?(?:Unknown typed Work endpoint|Native Work (?:callable|endpoint|catalog description|descriptor|schema provenance)|Work native descriptor)/.test(
		message,
	);
}
