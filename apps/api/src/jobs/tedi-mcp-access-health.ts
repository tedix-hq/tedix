/// <reference path="../../worker-configuration.d.ts" />
/**
 * Six-hourly Tedi MCP access-health workflow enqueue. Registers the durable
 * workflow on ctx.waitUntil; the caller keeps the
 * env.TEDI_MCP_ACCESS_HEALTH_WORKFLOW gate.
 */

export function queueTediMcpAccessHealthWorkflow(
	env: CloudflareEnv,
	ctx: ExecutionContext,
): void {
	ctx.waitUntil(
		env.TEDI_MCP_ACCESS_HEALTH_WORKFLOW.create({
			params: {
				source: "cron",
				repairInvalid: true,
				dryRun: false,
				includeSkipped: false,
				limit: 50,
			},
		})
			.then((instance) => {
				console.log(
					`[Scheduled] Tedi MCP access health workflow queued: ${instance.id}`,
				);
			})
			.catch((error) => {
				console.warn(
					"[Scheduled] Tedi MCP access health workflow failed to queue:",
					error instanceof Error ? error.message : String(error),
				);
			}),
	);
}
