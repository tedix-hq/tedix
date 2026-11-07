/** Optional self-hosting overrides; unset keeps Tedix Cloud's hostnames. */
interface CloudflareEnv {
	PLATFORM_DOMAIN?: string;
	TEDI_HOST_SUFFIX?: string;
}
