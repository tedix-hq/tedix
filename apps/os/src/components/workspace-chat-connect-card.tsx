import { Plugs } from "@phosphor-icons/react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import type { ChatConnectionRequest } from "@/lib/workspace-chat-state";

/**
 * Where a missing account is connected: a person's own accounts, or the
 * organization's connections. `connect` opens that service's connect step.
 */
export function connectionRequestHref(
	request: Pick<ChatConnectionRequest, "providerId" | "connectionScope">,
): string {
	const page =
		request.connectionScope === "personal"
			? "/account/connections"
			: "/admin/connections";
	return `${page}?${new URLSearchParams({ connect: request.providerId })}`;
}

/**
 * The agent's ask for an account a workspace source needs. The source is
 * named beside the title, the agent's reason sits under it, and one action
 * leads to the page where that account is connected.
 */
export function ConnectionRequestCard({
	request,
}: {
	request: ChatConnectionRequest;
}) {
	const personal = request.connectionScope === "personal";
	return (
		<div
			className="workspace-chat-connect"
			data-testid="workspace-chat-connect"
			data-scope={request.connectionScope}
		>
			<div className="workspace-chat-connect-head">
				<Plugs aria-hidden />
				<Text as="strong" role="label">
					Connect {request.service}
				</Text>
				<Badge variant="secondary">{request.resourceName}</Badge>
			</div>
			{request.reason ? <Text role="body">{request.reason}</Text> : null}
			<Text role="caption" tone="secondary">
				{personal
					? `${request.resourceName} is read through each person's own ${request.service} account. Connect yours to use it here.`
					: `${request.resourceName} uses a ${request.service} account your organization shares. An organization admin connects it.`}
			</Text>
			<div className="workspace-chat-connect-actions">
				<Button
					size="sm"
					render={<a href={connectionRequestHref(request)} />}
					data-testid="workspace-chat-connect-link"
				>
					{personal ? "Connect account" : "Open connections"}
				</Button>
			</div>
		</div>
	);
}
