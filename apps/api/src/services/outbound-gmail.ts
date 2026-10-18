import { fetchNamedConnection } from "../rpc/routers/connections/policy-resolution";
import { getConnectionProviderByDescopeAppId } from "@tedix/db/queries/connection-providers";
import type { OutboundDraft } from "@tedix/api-contract/schemas/outbound";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";

/** No tenant/shared token fallback: this account must belong to the clicking human. */
export async function outboundGmailCredential(
	context: BaseContext,
	providerId: string,
	instanceId: string,
	purpose: "compose" | "read" = "compose",
) {
	if (context.authType !== "user" || !context.user?.sub || context.tediId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Sending requires the signed-in account owner",
		);
	const provider = await getConnectionProviderByDescopeAppId(
		context.db,
		providerId,
	);
	if (provider?.id !== "google-gmail")
		throw createError(
			ErrorCodes.CONFLICT,
			"Configure a Gmail provider for this channel",
		);
	const token = await fetchNamedConnection(
		context,
		{ userId: context.user.sub },
		providerId,
		instanceId,
	);
	if (!token?.accessToken)
		throw createError(
			ErrorCodes.CONFLICT,
			"This Gmail account has no usable login. Verify it in Connections.",
		);
	// Read capability is established by Gmail's actual response, not a second
	// scope-name check. The shared resolver pins the selected owner's identity.
	if (
		purpose === "compose" &&
		!token.scopes?.some((scope) =>
			[
				"https://www.googleapis.com/auth/gmail.compose",
				"https://www.googleapis.com/auth/gmail.modify",
				"https://mail.google.com/",
			].includes(scope),
		)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Gmail compose consent is required",
		);
	return token.accessToken;
}

export function outboundMime(draft: OutboundDraft): string {
	if (
		!/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(
			draft.recipient,
		) ||
		/[\r\n]/.test(draft.subject)
	)
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"Confirm one recipient email and a single-line subject before sending",
		);
	const encodedSubject = btoa(
		String.fromCharCode(...new TextEncoder().encode(draft.subject)),
	);
	const message = `To: ${draft.recipient}\r\nSubject: =?UTF-8?B?${encodedSubject}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa(String.fromCharCode(...new TextEncoder().encode(draft.body)))}`;
	return btoa(message)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** The returned id is the provider's sent-message receipt, never just a draft id. */
export async function sendOutboundGmail(
	token: string,
	raw: string,
): Promise<string> {
	const headers = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
	const created = await fetch(
		"https://gmail.googleapis.com/gmail/v1/users/me/drafts",
		{ method: "POST", headers, body: JSON.stringify({ message: { raw } }) },
	);
	if (!created.ok) throw new Error("Gmail draft creation failed");
	const draft = (await created.json()) as { id?: string };
	if (!draft.id) throw new Error("Gmail draft receipt missing");
	const sent = await fetch(
		"https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
		{ method: "POST", headers, body: JSON.stringify({ id: draft.id }) },
	);
	if (!sent.ok) throw new Error("Gmail send result requires reconciliation");
	const receipt = (await sent.json()) as { id?: string };
	if (!receipt.id) throw new Error("Gmail sent-message receipt missing");
	return receipt.id;
}

type GmailPart = {
	mimeType?: string;
	body?: { data?: string };
	parts?: GmailPart[];
};
export function sentStyleText(part: GmailPart): string {
	if (part.mimeType === "text/plain" && part.body?.data) {
		const binary = atob(part.body.data.replace(/-/g, "+").replace(/_/g, "/"));
		return new TextDecoder()
			.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
			.slice(0, 5_000);
	}
	return (part.parts ?? [])
		.slice(0, 20)
		.map(sentStyleText)
		.filter(Boolean)
		.join("\n")
		.slice(0, 5_000);
}

function gmailReadFailure(status: number): string {
	if (status === 401)
		return "Reconnect this Gmail account: Google rejected the expired or revoked login.";
	if (status === 403)
		return "Reconnect this Gmail account with read access: Google denied reading sent mail.";
	return `Gmail could not read sent mail (HTTP ${status}). Try again later.`;
}

/** Bounded, owner-requested read. Attachments and HTML-only messages are excluded. */
export async function readSentStyleExamples(token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	const response = await fetch(
		"https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=SENT&maxResults=10&fields=messages(id)",
		{ headers },
	);
	if (!response.ok)
		throw createError(ErrorCodes.CONFLICT, gmailReadFailure(response.status));
	const result = (await response.json()) as { messages?: { id: string }[] };
	const samples: { id: string; body: string }[] = [];
	for (const message of (result.messages ?? []).slice(0, 10)) {
		const read = await fetch(
			`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full&fields=id,payload(mimeType,body(data),parts(mimeType,body(data),parts(mimeType,body(data))))`,
			{ headers },
		);
		if (!read.ok)
			throw createError(ErrorCodes.CONFLICT, gmailReadFailure(read.status));
		const mail = (await read.json()) as { payload?: GmailPart };
		const body = mail.payload ? sentStyleText(mail.payload) : "";
		if (body.trim()) samples.push({ id: message.id, body });
	}
	return samples;
}

/** Verify an incoming reply in the provider thread; sent follow-ups never count. */
export async function readOutboundReply(
	token: string,
	sentMessageId: string,
): Promise<string | null> {
	const headers = { Authorization: `Bearer ${token}` };
	const sent = await fetch(
		`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(sentMessageId)}?format=metadata&metadataHeaders=Message-ID&fields=id,threadId,internalDate,payload/headers`,
		{ headers, signal: AbortSignal.timeout(5000) },
	);
	if (!sent.ok) throw new Error("Sent message could not be verified");
	const message = (await sent.json()) as {
		id?: string;
		threadId?: string;
		internalDate?: string;
		payload?: { headers?: Array<{ name: string; value: string }> };
	};
	if (
		message.id !== sentMessageId ||
		!message.threadId ||
		!message.internalDate
	)
		throw new Error("Sent receipt is incomplete");
	const sentHeader = message.payload?.headers
		?.find((h) => h.name.toLowerCase() === "message-id")
		?.value.trim();
	if (!sentHeader) throw new Error("Sent message header missing");
	const thread = await fetch(
		`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(message.threadId)}?format=metadata&metadataHeaders=In-Reply-To&fields=id,messages(id,internalDate,labelIds,payload/headers)`,
		{ headers, signal: AbortSignal.timeout(5000) },
	);
	if (!thread.ok) throw new Error("Reply thread could not be verified");
	const body = (await thread.json()) as {
		id?: string;
		messages?: Array<{
			id: string;
			internalDate: string;
			labelIds?: string[];
			payload?: { headers?: Array<{ name: string; value: string }> };
		}>;
	};
	if (body.id !== message.threadId)
		throw new Error("Reply thread does not match");
	return (
		body.messages?.find(
			(m) =>
				m.id !== sentMessageId &&
				Number(m.internalDate) > Number(message.internalDate) &&
				!m.labelIds?.includes("SENT") &&
				!m.labelIds?.includes("DRAFT") &&
				m.payload?.headers?.some(
					(h) =>
						h.name.toLowerCase() === "in-reply-to" &&
						h.value.split(/\s+/).includes(sentHeader),
				),
		)?.id ?? null
	);
}
