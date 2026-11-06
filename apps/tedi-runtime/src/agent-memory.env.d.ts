/** Optional Agent Memory binding; accounts without the product run with memory projection off. */
declare namespace Cloudflare {
	interface Env {
		AGENT_MEMORY?: AgentMemoryNamespace;
	}
}
