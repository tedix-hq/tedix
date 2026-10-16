import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";
import { sessionKeyFromTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import type { TediApprovalRequest } from "@tedix/db/schema/approvals";

export function isSameBrowserTakeover(
	previous: TediApprovalRequest,
	next: {
		orgId: string;
		tediId: string;
		actionType: string;
		payload: Record<string, unknown>;
	},
): boolean {
	return (
		previous.orgId === next.orgId &&
		previous.tediId === next.tediId &&
		previous.actionType === "browser.live_view_takeover" &&
		next.actionType === previous.actionType &&
		previous.payload?.kind === "browser_live_view_takeover" &&
		next.payload.kind === previous.payload.kind &&
		typeof next.payload.sessionId === "string" &&
		next.payload.sessionId === previous.payload.sessionId
	);
}

export function browserTakeoverWakeRequest(
	approval: TediApprovalRequest,
	tedi: { slug: string; organizationId: string | null },
	domain: string,
): Request | null {
	if (
		approval.actionType !== "browser.live_view_takeover" ||
		approval.status !== "approved"
	)
		return null;
	const payload = approval.payload;
	if (
		payload?.kind !== "browser_live_view_takeover" ||
		tedi.organizationId !== approval.orgId
	)
		throw new Error("Invalid browser takeover owner");
	const sessionKey =
		typeof payload.sessionKey === "string"
			? payload.sessionKey
			: typeof payload.conversationId === "string"
				? sessionKeyFromTediConversationId({
						conversationId: payload.conversationId,
						tediRef: tedi.slug,
					})
				: null;
	if (!sessionKey)
		throw new Error("Browser takeover has no originating session");
	return new Request("https://tedi/hooks/inject", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Tedix-Host": `${tedi.slug}.tedi.${domain}`,
			"X-Service-Binding": "true",
			[CALLER_TRUST_HEADER]: "member",
		},
		body: JSON.stringify({
			session_key: sessionKey,
			client_request_id: `browser-takeover:${approval.id}:approved`,
			async: true,
			metadata: {
				source: "browser_takeover_approval",
				approvalRequestId: approval.id,
				workItemId: payload.workItemId,
			},
			text: `The operator approved browser takeover ${approval.id}. Call get_browser_takeover_status with this approvalRequestId; continue the original task only if continuationReady is true, using the same browser session.`,
		}),
	});
}
