import { createDbClient } from "@tedix/db/client";
import { checkSiteVersions } from "../services/site-versions";

export async function runSiteVersionCheckTick(env: CloudflareEnv) {
	const reports = await checkSiteVersions({ db: createDbClient(env.DB), env });
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
