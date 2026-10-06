/**
 * Tedi Email Query Helpers
 */

import type {
	TediEmailMessage,
	TediEmailRecipient,
	TediEmailThread,
} from "../../schema/tedi-email";
import {
	type NormalizedTediEmailMessage,
	type NormalizedTediEmailThread,
	normalizeEmailAddress,
	normalizeEmailRecipient,
	type TediEmailRecipientInput,
} from "./recipients";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
function isStoredRecipient(value: unknown): value is TediEmailRecipient {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		typeof (value as { email?: unknown }).email === "string"
	);
}

function normalizeStoredRecipient(
	value: unknown,
	fallbackEmail?: string | null,
): TediEmailRecipient {
	if (isStoredRecipient(value)) {
		return normalizeEmailRecipient(value);
	}
	if (typeof value === "string") {
		return normalizeEmailRecipient(value);
	}
	return normalizeEmailRecipient(fallbackEmail ?? "");
}

function normalizeStoredRecipientList(
	value: unknown,
	fallbackEmails: string[] = [],
): TediEmailRecipient[] {
	const values = Array.isArray(value) ? value : fallbackEmails;
	return values.map((item) => normalizeStoredRecipient(item)).filter(hasEmail);
}

function hasEmail(value: TediEmailRecipient): boolean {
	return value.email.length > 0;
}

export function uniqueRecipients(
	values: Array<TediEmailRecipientInput | null | undefined>,
): TediEmailRecipient[] {
	const byEmail = new Map<string, TediEmailRecipient>();
	for (const value of values) {
		if (!value) continue;
		const recipient = normalizeEmailRecipient(value);
		if (!recipient.email) continue;
		const existing = byEmail.get(recipient.email);
		if (!existing || (!existing.name && recipient.name)) {
			byEmail.set(recipient.email, recipient);
		}
	}
	return [...byEmail.values()];
}

export function clampLimit(limit: number | null | undefined): number {
	if (!limit) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

export function unique(values: Array<string | null | undefined>): string[] {
	return [
		...new Set(
			values.filter((v): v is string => Boolean(v)).map(normalizeEmailAddress),
		),
	];
}
export function mergeParticipants(
	existing: TediEmailRecipient[] | string[] | null | undefined,
	next: TediEmailRecipientInput[],
): TediEmailRecipient[] {
	return uniqueRecipients([
		...normalizeStoredRecipientList(existing),
		...next.map(normalizeEmailRecipient),
	]);
}

export function normalizeStoredMessage(
	message: TediEmailMessage,
): NormalizedTediEmailMessage {
	return {
		...message,
		from: normalizeStoredRecipient(message.from, message.fromAddr),
		to: normalizeStoredRecipientList(message.to),
		cc: normalizeStoredRecipientList(message.cc),
		bcc: normalizeStoredRecipientList(message.bcc),
		replyTo: message.replyTo ? normalizeStoredRecipient(message.replyTo) : null,
	};
}

export function normalizeStoredThread(
	thread: TediEmailThread,
): NormalizedTediEmailThread {
	return {
		...thread,
		participants: normalizeStoredRecipientList(thread.participants),
	};
}
