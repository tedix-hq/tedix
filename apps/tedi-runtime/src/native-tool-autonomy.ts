import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import {
	decideAutonomousAction,
	humanReservedActionClasses,
	nativeToolActionContent,
	nativeToolAutonomyRisk,
	type DelegationAutonomyPolicy,
} from "@tedix/api-contract/utils/approval-policy";
import type { ResolveTrustedRecipientSendOutput } from "@tedix/api-contract/schemas/tedi-email";
import {
	trustedRecipientEmailAction,
	trustedRecipientSkipsCard,
} from "@tedix/api-contract/utils/email-trusted-recipients";

/** Native approvals use fresh organization policy; model metadata cannot authorize a call. */
export async function nativeToolAutonomy(input: {
	api: Fetcher;
	organizationId: string;
	tediId: string;
	tool: string;
	args: unknown;
	/**
	 * Who a native email tool sends to, from the runtime's own turn state (the
	 * inbound sender for `reply_to_email`), never from the model's arguments.
	 */
	emailRecipients?: { to: string[] };
}) {
	const rpcOptions = {
		apiUrl: "https://api",
		fetch: serviceBindingFetch(input.api),
		headers: {
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": input.organizationId,
		},
	};
	const emailAction = trustedRecipientEmailAction(input.tool);
	const [policy, trustedRecipientSend] = await Promise.all([
		callRpc<{ autonomy?: DelegationAutonomyPolicy }>(
			"mcpGovernance/resolveAgentTransportPolicy",
			{
				organizationId: input.organizationId,
				tediId: input.tediId,
			},
			rpcOptions,
		),
		emailAction && input.emailRecipients?.to.length
			? callRpc<ResolveTrustedRecipientSendOutput>(
					"tediEmail/resolveTrustedRecipientSend",
					{
						tediId: input.tediId,
						actingTediId: input.tediId,
						kind: emailAction,
						to: input.emailRecipients.to,
					},
					rpcOptions,
				)
			: Promise.resolve(null),
	]);
	const content = nativeToolActionContent(input.tool, input.args);
	const reserved = humanReservedActionClasses(content);
	const decision = decideAutonomousAction({
		policy: policy.autonomy,
		risk: nativeToolAutonomyRisk(input.tool),
		content,
		classId: `native:${input.tool}`,
		trustedRecipientSend,
	});
	return {
		...decision,
		critical:
			Boolean(policy.autonomy) &&
			!(
				decision.autoApprove &&
				trustedRecipientSkipsCard({
					reservedClasses: reserved,
					decision: trustedRecipientSend,
				})
			) &&
			(reserved.length > 0 || nativeToolAutonomyRisk(input.tool) === "high"),
	};
}
