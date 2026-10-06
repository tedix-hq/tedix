import type { BaseContext } from "../rpc/context";

type MiningPhase =
	| "auth.forwarded"
	| "auth.user"
	| "auth.organization"
	| "auth.membership"
	| "mining.episodes"
	| "mining.tool_resolution"
	| "mining.dedupe"
	| "mining.total";

/**
 * Targeted diagnostics for the mining RPC's 15-second cancellation boundary.
 * Cloudflare attaches request/trace IDs to these events: never copy headers,
 * query parameters, SQL, results, or exception messages into the log payload.
 * A start without a finish identifies an unfinished phase, not its root cause.
 */
export async function measureMiningPhase<T>(
	context: Pick<BaseContext, "url">,
	phase: MiningPhase,
	operation: () => Promise<T>,
): Promise<T> {
	if (context.url?.pathname !== "/rpc/skills/mineCandidates") {
		return operation();
	}
	const startedAt = Date.now();
	const emit = (status: "started" | "succeeded" | "failed") => {
		try {
			const event = {
				event: "mining_rpc_phase",
				phase,
				status,
				elapsedMs: Date.now() - startedAt,
			};
			if (status === "failed") console.error(event);
			else console.info(event);
		} catch {
			// Diagnostics must not replace the operation's result or exception.
		}
	};
	emit("started");
	try {
		const result = await operation();
		emit("succeeded");
		return result;
	} catch (error) {
		emit("failed");
		throw error;
	}
}
