/// <reference path="../../worker-configuration.d.ts" />

export async function runMachineScopeDriftTick(
	env: CloudflareEnv,
	runId: string,
	now = new Date(),
): Promise<Record<string, number>> {
	if (!env.DESCOPE_PROJECT_ID || !env.DESCOPE_MANAGEMENT_KEY) return {};

	const { createDbClient } = await import("@tedix/db/client");
	const { getDescopeAihDriftReport } =
		await import("../services/descope-aih-drift");
	const report = await getDescopeAihDriftReport({
		db: createDbClient(env.DB),
		env: {
			DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
			DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
			DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
		},
		now,
	});
	const exactScopeIssues = report.issues.filter((issue) =>
		[
			"tedi_mcp_client_assignment_missing",
			"tedi_mcp_client_scope_overgrant",
			"tedi_mcp_client_scope_missing",
			"tedi_mcp_client_ownership_tag_drift",
		].includes(issue.code),
	);
	const counts = {
		mcpClients: report.summary.mcpClients,
		critical: report.summary.issues.critical,
		warning: report.summary.issues.warning,
		info: report.summary.issues.info,
		exactScopeIssues: exactScopeIssues.length,
	};
	console.log(
		JSON.stringify({
			job: "machine-scope-drift",
			runId,
			checkedAt: report.checkedAt,
			...counts,
			exactScopeIssueCodes: exactScopeIssues.map((issue) => issue.code),
		}),
	);
	return counts;
}
