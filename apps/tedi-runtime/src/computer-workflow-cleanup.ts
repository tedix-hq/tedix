import type { ComputerWorkspaceScope } from "./computer-workspace-scope";
import type {
	ComputerEnvironmentController,
	ComputerEnvironment,
} from "./computer-environment";
import type { WorkflowDispatchContext } from "./workflow-start-watchdog";

/**
 * Release retries this cleanup may spend before it retires the dispatch context.
 *
 * Releasing a computer DESTROYS its container, so retrying a release that can
 * never succeed is not eventual consistency — it is a demolition loop. Ten
 * terminal CHAT_TURN_WORKFLOWs whose release keeps returning a non-destroyed
 * adapter each re-arm a 60s deferral, which between them destroy a tedi's
 * workstation every couple of seconds. Nothing the tedi runs survives long
 * enough to write its exit-code receipt, so every command expires its whole
 * wait budget and comes back "still running".
 *
 * A lease left behind expires on its own. A container destroyed on a two-second
 * cadence never recovers, so the bounded budget is the safer failure.
 */
const MAX_COMPUTER_CLEANUP_ATTEMPTS = 5;

/** Workflow completion owns cleanup; paused code retains its exact filesystem. */
export async function cleanupComputerWorkflow(
	storage: Pick<DurableObjectStorage, "get" | "put" | "delete">,
	workflowInstanceId: string,
	deps: {
		scope(context: WorkflowDispatchContext): ComputerWorkspaceScope;
		computer(scope: ComputerWorkspaceScope): ComputerEnvironmentController;
		hasActiveCode(
			scope: ComputerWorkspaceScope,
			environment: ComputerEnvironment,
		): Promise<boolean>;
		defer(): Promise<unknown>;
	},
): Promise<void> {
	const key = `wfctx:${workflowInstanceId}`;
	const context = await storage.get<WorkflowDispatchContext>(key);
	if (context?.workItemId) {
		const scope = deps.scope(context);
		const computer = deps.computer(scope);
		const environment = await computer.selected();
		if (environment && (await deps.hasActiveCode(scope, environment))) {
			await deps.defer();
			return;
		}
		const receipt = (await computer.finish(context.runId)) as { ok?: boolean };
		if (receipt.ok !== true) {
			const attempts = (context.computerCleanupAttempts ?? 0) + 1;
			console.error({
				component: "tedi-runtime-computer",
				event: "tedi.computer.cleanup_incomplete",
				attempt: attempts,
				limit: MAX_COMPUTER_CLEANUP_ATTEMPTS,
			});
			if (attempts < MAX_COMPUTER_CLEANUP_ATTEMPTS) {
				await storage.put<WorkflowDispatchContext>(key, {
					...context,
					computerCleanupAttempts: attempts,
				});
				await deps.defer();
				return;
			}
			console.error({
				component: "tedi-runtime-computer",
				event: "tedi.computer.cleanup_abandoned",
				attempt: attempts,
				limit: MAX_COMPUTER_CLEANUP_ATTEMPTS,
			});
		}
	}
	await storage.delete(key);
}
