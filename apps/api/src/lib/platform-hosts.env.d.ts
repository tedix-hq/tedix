/** Optional self-hosting override; unset keeps `{slug}.tedi.tedix.dev`. */
interface CloudflareEnv {
	TEDI_HOST_SUFFIX?: string;
}
