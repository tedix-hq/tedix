/** Optional until the installation config supplies the dataset binding. */
declare namespace Cloudflare {
	interface Env {
		D1_REQUESTS?: AnalyticsEngineDataset;
	}
}
interface CloudflareEnv {
	D1_REQUESTS?: AnalyticsEngineDataset;
}
