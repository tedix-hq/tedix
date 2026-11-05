import type { PlatformClient } from "./brain/platform-client";
import type { FacetWorkflowTurnInput } from "./delegated-work-lease";
import { exceptionTopology } from "@tedix/worker-kit/exception-topology";
import { isEphemeralSessionKey } from "@tedix/api-contract/utils/runtime-identity";

export const WORKFLOW_TURN_HEARTBEAT_MS = 60_000;

/** Filter at the API so a terminal cannot hide behind days of retry rows. */
export async function workflowRunIsTerminal(
	platform: Pick<PlatformClient, "listRuntimeEvents"> | null,
	runId: string,
): Promise<boolean> {
	if (!platform) throw new Error("Workflow runtime ledger unavailable");
	const pages = await Promise.all(
		(["run.completed", "run.failed", "run.canceled"] as const).map((kind) =>
			platform.listRuntimeEvents({ runId, kind, limit: 1 }),
		),
	);
	return pages.some(({ events }) => events.length > 0);
}

/** An isolate timer proves only this invocation is alive; eviction stops it. */
export async function withWorkflowTurnLiveness<T>(
	input: FacetWorkflowTurnInput,
	platform: Pick<PlatformClient, "recordRuntimeEvent">,
	tediId: string,
	run: () => Promise<T>,
): Promise<T> {
	if (isEphemeralSessionKey(input.sessionKey)) return run();
	let stopped = false;
	let pending: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout>;
	const arm = () => {
		timer = setTimeout(() => {
			pending = platform
				.recordRuntimeEvent({
					id: crypto.randomUUID(),
					tediId,
					runId: input.runId,
					conversationId: input.conversationId,
					kind: "message.progress",
					payload: { operation: "workflow_turn_heartbeat" },
					runtime: { backend: "cloudflare-agents" },
					createdAt: new Date().toISOString(),
				})
				.then(
					() => {},
					(error: unknown) => {
						console.warn("[workflow] turn heartbeat failed", {
							exception: exceptionTopology(error),
						});
					},
				)
				.finally(() => {
					if (!stopped) arm();
				});
		}, WORKFLOW_TURN_HEARTBEAT_MS);
	};
	arm();
	try {
		return await run();
	} finally {
		stopped = true;
		clearTimeout(timer!);
		await pending;
	}
}
