/** Optional self-hosting overrides; unset keeps Tedix Cloud's hostnames. */
declare namespace Cloudflare {
	interface Env {
		PLATFORM_DOMAIN?: string;
		PLATFORM_DOMAINS?: string;
		TEDI_HOST_SUFFIX?: string;
	}
}
