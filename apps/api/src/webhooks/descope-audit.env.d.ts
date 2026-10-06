/**
 * Optional env augmentation for the Descope audit webhook.
 *
 * DESCOPE_WEBHOOK_SECRET is the HMAC signing key Descope shares when its audit
 * webhook is configured. That feature is not available on every account, so the
 * secret must NOT be added to wrangler `secrets.required`: doing so types it as
 * always-present while it is in fact absent, and makes an unavailable
 * integration indistinguishable from a broken one at deploy time.
 *
 * The handler treats absent and empty identically and rejects the request, so
 * an unconfigured webhook fails closed rather than accepting unverified events.
 * Populate `DESCOPE/DESCOPE_WEBHOOK_SECRET` in the secret provider to enable it; no
 * code change is needed.
 */
interface CloudflareEnv {
	DESCOPE_WEBHOOK_SECRET?: string;
}
