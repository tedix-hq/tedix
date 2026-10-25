/** Optional Web Push installation credentials; unconfigured installations stay disabled. */
interface CloudflareEnv {
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
}
