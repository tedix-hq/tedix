import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import {
	decideAutonomousAction,
	humanReservedActionClasses,
	nativeToolActionContent,
	nativeToolAutonomyRisk,
	type DelegationAutonomyPolicy,
} from "@tedix/api-contract/utils/approval-policy";

/** Native approvals use fresh organization policy; model metadata cannot authorize a call. */
export async function nativeToolAutonomy(input: {
	api: Fetcher;
	organizationId: string;
	tediId: string;
	tool: string;
	args: unknown;
}) {
	const policy = await callRpc<{ autonomy?: DelegationAutonomyPolicy }>(
		"mcpGovernance/resolveAgentTransportPolicy",
		{
			organizationId: input.organizationId,
			tediId: input.tediId,
		},
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(input.api),
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": input.organizationId,
			},
		},
	);
	const content = nativeToolActionContent(input.tool, input.args);
	return {
		...decideAutonomousAction({
			policy: policy.autonomy,
			risk: nativeToolAutonomyRisk(input.tool),
			content,
			classId: `native:${input.tool}`,
		}),
		critical:
			Boolean(policy.autonomy) &&
			(humanReservedActionClasses(content).length > 0 ||
				nativeToolAutonomyRisk(input.tool) === "high"),
	};
}
