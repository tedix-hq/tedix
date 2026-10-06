/**
 * Tedi Email Query Helpers
 */

import type {
	TediEmailAttachment,
	TediEmailMessage,
	TediEmailRecipient,
	TediEmailThread,
} from "../../schema/tedi-email";
export type NormalizedTediEmailMessage = Omit<
	TediEmailMessage,
	"from" | "to" | "cc" | "bcc" | "replyTo"
> & {
	from: TediEmailRecipient;
	to: TediEmailRecipient[];
	cc: TediEmailRecipient[];
	bcc: TediEmailRecipient[];
	replyTo: TediEmailRecipient | null;
};

export type NormalizedTediEmailThread = Omit<
	TediEmailThread,
	"participants"
> & {
	participants: TediEmailRecipient[];
};

export type TediEmailMessageWithAttachments = NormalizedTediEmailMessage & {
	attachments: TediEmailAttachment[];
};

export type TediEmailRecipientInput = string | TediEmailRecipient;

export function normalizeEmailAddress(value: string): string {
	return value.trim().toLowerCase();
}

export function normalizeEmailRecipient(
	value: TediEmailRecipientInput,
): TediEmailRecipient {
	if (typeof value === "string") {
		return { email: normalizeEmailAddress(value) };
	}
	const email = normalizeEmailAddress(value.email);
	const name = value.name?.trim();
	return name ? { email, name } : { email };
}

export function normalizeEmailRecipients(
	values: TediEmailRecipientInput[],
): TediEmailRecipient[] {
	return values.map(normalizeEmailRecipient);
}
export function normalizeEmailSubject(value: string): string {
	let subject = value.trim().replace(/\s+/g, " ");
	while (/^(re|fw|fwd)\s*:/i.test(subject)) {
		subject = subject.replace(/^(re|fw|fwd)\s*:\s*/i, "").trim();
	}
	return subject.toLowerCase() || "(no subject)";
}

/**
 * Remove every `<tag ...>...</tag ...>` block in one linear pass, leaving an
 * unclosed block for the generic tag strip. Sender-controlled HTML must not
 * reach a lazy `<tag[\s\S]*?</tag>` regex, which rescans the remainder once
 * per unclosed opener.
 */
function stripHtmlElementBlocks(value: string, tag: string): string {
	const lower = value.toLowerCase();
	const open = `<${tag}`;
	const close = `</${tag}`;
	let output = "";
	let position = 0;
	for (;;) {
		const start = lower.indexOf(open, position);
		if (start === -1) return output + value.slice(position);
		const end = lower.indexOf(close, start + open.length);
		const endTag = end === -1 ? -1 : lower.indexOf(">", end + close.length);
		if (endTag === -1) return output + value.slice(position);
		output += `${value.slice(position, start)} `;
		position = endTag + 1;
	}
}

export function buildEmailPreview(value: string | null | undefined): string {
	return stripHtmlElementBlocks(
		stripHtmlElementBlocks(value ?? "", "style"),
		"script",
	)
		.replace(/<[^<>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}
export function parseAddressParts(address: string): {
	localPart: string;
	domain: string;
} {
	const normalized = normalizeEmailAddress(address);
	const at = normalized.lastIndexOf("@");
	if (at === -1) return { localPart: normalized, domain: "" };
	return {
		localPart: normalized.slice(0, at),
		domain: normalized.slice(at + 1),
	};
}
