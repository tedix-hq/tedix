/**
 * The public origin the catalog workflows publish R2 objects under.
 *
 * `ASSETS_URL` is a Wrangler `vars` entry (`apps/api/wrangler.jsonc`,
 * `env.production.vars`). Every installation has its own public bucket, so
 * there is no default that is correct anywhere but one installation; an unset
 * value is a configuration error, never a silent fall-through to someone
 * else's bucket.
 */
export function assetsBaseUrl(env: { ASSETS_URL?: string }): string {
	const configured = env.ASSETS_URL?.trim();
	if (!configured) {
		throw new Error(
			"ASSETS_URL is not configured: set the public assets origin in wrangler.jsonc vars",
		);
	}
	return configured.replace(/\/$/, "");
}
