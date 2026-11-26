import { checkCmsTemplateUpstream } from "../services/cms-template-upstream";
import { coreDb } from "@tedix/db/core-store/scope";

export async function runCmsTemplateUpstreamCheckTick(env: CloudflareEnv) {
	const reports = await checkCmsTemplateUpstream({ db: coreDb(env), env });
	return {
		projects: reports.length,
		behind: reports.reduce(
			(total, report) =>
				total +
				report.projects.reduce(
					(sum, project) =>
						sum + project.starters.filter((entry) => entry.behind).length,
					0,
				),
			0,
		),
		missing: reports.reduce(
			(total, report) =>
				total +
				report.projects.reduce(
					(sum, project) => sum + project.missing.length,
					0,
				),
			0,
		),
		filed: reports.reduce(
			(total, report) =>
				total +
				report.projects.reduce((sum, project) => sum + project.filed.length, 0),
			0,
		),
	};
}
