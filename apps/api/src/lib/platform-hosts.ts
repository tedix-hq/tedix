import { hostSetting } from "@tedix/worker-kit/platform-hosts";

/**
 * Host the tedi runtime routes to the tedi `slug`: `{slug}.<TEDI_HOST_SUFFIX>`,
 * defaulting to Tedix Cloud's `{slug}.tedi.tedix.dev`.
 */
export function tediHost(
	env: { TEDI_HOST_SUFFIX?: string },
	slug: string,
): string {
	return `${slug}.${hostSetting(env.TEDI_HOST_SUFFIX, "tedi.tedix.dev")}`;
}
