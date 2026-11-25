import { checkSiteVersions } from "../services/site-versions";
import { coreDb } from "@tedix/db/core-store/scope";

export async function runSiteVersionCheckTick(env: CloudflareEnv) {
	const reports = await checkSiteVersions({ db: coreDb(env), env });
	return {
		projects: reports.length,
		sites: reports.reduce((total, report) => total + report.sites.length, 0),
		upgrades: reports.reduce(
			(total, report) => total + report.alerts.length,
			0,
		),
		unknown: reports.reduce(
			(total, report) =>
				total +
				report.sites.filter(
					(site) =>
						site.errors.length > 0 ||
						site.packages.some((pkg) => pkg.behind === null),
				).length,
			0,
		),
	};
}
