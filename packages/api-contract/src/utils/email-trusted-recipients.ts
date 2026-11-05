/**
 * Trusted email recipients: the one exception to the human card on a tedi's
 * outbound email. An owner or admin stores exact addresses per tedi; a send
 * or reply from that tedi skips the card only when every recipient is on that
 * tedi's active list and the caller is that tedi. The MCP gateway, the tedi
 * runtime and the API all decide through {@link decideTrustedRecipientSend},
 * so they cannot disagree. The list always comes from storage, never from the
 * caller's arguments.
 */

/** API endpoints and runtime tool names that send email as a tedi. */
const TRUSTED_RECIPIENT_EMAIL_ACTIONS: Record<string, "send" | "reply"> = {
	"tediEmail/sendEmail": "send",
	"tediEmail/replyEmail": "reply",
	email_send: "send",
	reply_to_email: "reply",
};

export function trustedRecipientEmailAction(
	name: string | null | undefined,
): "send" | "reply" | null {
	return (name && TRUSTED_RECIPIENT_EMAIL_ACTIONS[name]) || null;
}

const MAX_ADDRESS_LENGTH = 254;
// Exact mailbox addresses only. `*` and `?` are not allowed anywhere, and a
// bare domain or `@domain` suffix has no local part, so neither can match.
const EXACT_ADDRESS_PATTERN =
	/^[a-z0-9!#$%&'+/=^_`{|}~-]+(?:\.[a-z0-9!#$%&'+/=^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Lowercased exact address, or null for anything else: wildcards, domains,
 * `@domain` suffixes, display names, or malformed input.
 */
export function normalizeTrustedRecipientAddress(value: string): string | null {
	const address = value.trim().toLowerCase();
	if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
	return EXACT_ADDRESS_PATTERN.test(address) ? address : null;
}

export type TrustedRecipientValue = string | { email: string };

export interface TrustedRecipientEntry {
	tediId: string;
	address: string;
	revokedAt?: string | null;
}

export type TrustedRecipientDecision =
	| { trusted: true; reason: "trusted recipient"; addresses: string[] }
	| { trusted: false; reason: string; addresses: string[] };

/**
 * Whether a send from `senderTediId`, made by `actingTediId`, may skip the
 * human card. True only when the caller is the sending tedi and every to, cc
 * and bcc address is on that tedi's active (unrevoked) trusted list. Address
 * comparison is case-insensitive and exact.
 */
export function decideTrustedRecipientSend(input: {
	senderTediId: string | null | undefined;
	actingTediId: string | null | undefined;
	recipients: {
		to?: readonly TrustedRecipientValue[] | null;
		cc?: readonly TrustedRecipientValue[] | null;
		bcc?: readonly TrustedRecipientValue[] | null;
	};
	trusted: readonly TrustedRecipientEntry[];
}): TrustedRecipientDecision {
	const values = [
		...(input.recipients.to ?? []),
		...(input.recipients.cc ?? []),
		...(input.recipients.bcc ?? []),
	];
	const addresses: string[] = [];
	for (const value of values) {
		const raw = typeof value === "string" ? value : value?.email;
		const address =
			typeof raw === "string" ? normalizeTrustedRecipientAddress(raw) : null;
		if (!address)
			return { trusted: false, reason: "invalid recipient", addresses };
		if (!addresses.includes(address)) addresses.push(address);
	}
	if (!input.senderTediId || input.actingTediId !== input.senderTediId)
		return {
			trusted: false,
			reason: "caller is not the sending tedi",
			addresses,
		};
	if (addresses.length === 0)
		return { trusted: false, reason: "no recipients", addresses };
	const active = new Set(
		input.trusted
			.filter(
				(entry) => entry.tediId === input.senderTediId && !entry.revokedAt,
			)
			.map((entry) => normalizeTrustedRecipientAddress(entry.address))
			.filter((address): address is string => address !== null),
	);
	const untrusted = addresses.filter((address) => !active.has(address));
	return untrusted.length === 0
		? { trusted: true, reason: "trusted recipient", addresses }
		: {
				trusted: false,
				reason: `untrusted recipient: ${untrusted.join(", ")}`,
				addresses,
			};
}

/**
 * The card is skipped only for an outbound message (no other reserved class
 * such as money or deletion rides along) whose trusted-recipient decision is
 * positive. Every gate applies the exception through this predicate.
 */
export function trustedRecipientSkipsCard(input: {
	reservedClasses: readonly string[];
	decision: Pick<TrustedRecipientDecision, "trusted"> | null | undefined;
}): boolean {
	return (
		input.decision?.trusted === true &&
		input.reservedClasses.every((id) => id === "external_message")
	);
}
