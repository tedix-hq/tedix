import { ShieldCheck } from "@phosphor-icons/react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { ChatCard } from "@/components/workspace-chat-card";
import type { ChatTediApproval } from "@/lib/workspace-chat-state";

/** Tedix's own approval list, for a request that came without a link. */
const APPROVALS_PAGE = "/work/approvals";

/** The request's page in Tedix's approvals; only a web or in-app address. */
export function tediApprovalHref(url: string | null): string {
	if (!url) return APPROVALS_PAGE;
	if (url.startsWith("/") && !url.startsWith("//")) return url;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? parsed.href
			: APPROVALS_PAGE;
	} catch {
		return APPROVALS_PAGE;
	}
}

/**
 * A tedi's tool call that waits for a person. It is decided in Tedix's
 * approvals, not in the chat: approving there runs that exact call once,
 * and its result does not come back into this conversation.
 */
export function TediApprovalCard({ request }: { request: ChatTediApproval }) {
	return (
		<ChatCard
			attention
			data-testid="workspace-chat-tedi-approval"
			icon={<ShieldCheck />}
			title="Waiting for approval"
			status={<Badge variant="secondary">{request.tool}</Badge>}
			actions={
				<Button
					size="sm"
					render={<a href={tediApprovalHref(request.url)} />}
					data-testid="workspace-chat-tedi-approval-link"
				>
					Open approval
				</Button>
			}
		>
			<Text role="body">{request.description}</Text>
			<Text role="caption" tone="secondary">
				A person decides this in Tedix approvals. The result does not come back
				into this chat.
			</Text>
		</ChatCard>
	);
}
