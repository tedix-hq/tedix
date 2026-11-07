import {
	hostSetting,
	type PlatformDomainEnv,
	platformDomain,
} from "@tedix/worker-kit/platform-hosts";

/** Vars that place tedi runtimes; unset keeps `{slug}.tedi.<platform domain>`. */
export type TediHostEnv = PlatformDomainEnv & { TEDI_HOST_SUFFIX?: string };

/**
 * Host the tedi runtime routes to the tedi `slug`: `{slug}.<TEDI_HOST_SUFFIX>`,
 * defaulting to `{slug}.tedi.` + the platform domain (`tedi.tedix.dev` in
 * production, `tedi.tedix.tech` on every other lane).
 */
export function tediHost(env: TediHostEnv, slug: string): string {
	return `${slug}.${hostSetting(env.TEDI_HOST_SUFFIX, `tedi.${platformDomain(env)}`)}`;
}
