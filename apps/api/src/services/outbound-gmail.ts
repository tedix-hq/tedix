import { fetchPersonalConnectionToken } from "@tedix/auth/connections";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
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
	const instance = await getConnectionInstance(
		context.db,
		{ userId: context.user.sub },
		instanceId,
		providerId,
	);
	if (!instance?.tokenIds.length || !instance.tokenSub)
		throw createError(
			ErrorCodes.CONFLICT,
			"Verify your Gmail account in Connections first",
		);
	if (!context.env.DESCOPE_PROJECT_ID || !context.env.DESCOPE_MANAGEMENT_KEY)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Connections are unavailable",
		);
	const token = await fetchPersonalConnectionToken(
		{
			DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
			DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
			DESCOPE_BASE_URL: context.env.DESCOPE_BASE_URL,
		},
		{
			appId: providerId,
			userId: context.user.sub,
			externalIdentifier: `tedix_${instance.id}`,
			scopes: [
				`https://www.googleapis.com/auth/gmail.${purpose === "compose" ? "compose" : "readonly"}`,
			],
		},
	);
	if (
		!token?.id ||
		!instance.tokenIds.includes(token.id) ||
		token.tokenSub !== instance.tokenSub
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"Reconnect this Gmail account with compose consent",
		);
	if (
		!token.scopes?.some((scope) =>
			[
				`https://www.googleapis.com/auth/gmail.${purpose === "compose" ? "compose" : "readonly"}`,
				"https://www.googleapis.com/auth/gmail.modify",
				"https://mail.google.com/",
			].includes(scope),
		)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Gmail ${purpose} consent is required`,
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

/** Bounded, owner-requested read. Attachments and HTML-only messages are excluded. */
export async function readSentStyleExamples(token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	const response = await fetch(
		"https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=SENT&maxResults=10&fields=messages(id)",
		{ headers },
	);
	if (!response.ok)
		throw createError(
			ErrorCodes.CONFLICT,
			"Gmail sent-mail read consent is required",
		);
	const result = (await response.json()) as { messages?: { id: string }[] };
	const samples: { id: string; body: string }[] = [];
	for (const message of (result.messages ?? []).slice(0, 10)) {
		const read = await fetch(
			`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full&fields=id,payload(mimeType,body(data),parts(mimeType,body(data),parts(mimeType,body(data))))`,
			{ headers },
		);
		if (!read.ok)
			throw createError(
				ErrorCodes.CONFLICT,
				"A sent-mail example could not be read",
			);
		const mail = (await read.json()) as { payload?: GmailPart };
		const body = mail.payload ? sentStyleText(mail.payload) : "";
		if (body.trim()) samples.push({ id: message.id, body });
	}
	return samples;
}
