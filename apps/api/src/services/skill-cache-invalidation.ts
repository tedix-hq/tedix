import { invalidateKernelContextCache } from "../kernel/context-cache";
import { invalidateMcpSkillDiscovery } from "../lib/mcp-subscriptions";

export function invalidateSkillCaches(
	context: {
		env: CloudflareEnv;
		waitUntil?: (promise: Promise<unknown>) => void;
	},
	organizationId: string,
	reason: string,
): void {
	invalidateKernelContextCache(context, organizationId, reason);
	const pending = invalidateMcpSkillDiscovery(context.env, organizationId);
	context.waitUntil?.(pending);
}
