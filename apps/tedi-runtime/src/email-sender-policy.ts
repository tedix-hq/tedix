/**
 * Inbound email sender policy (runtime side)
 *
 * Pure helpers around two facts the ingress hands to apps/api and the tedi DO:
 *
 * - `parseAuthenticationResults`: the DKIM / DMARC / SPF verdicts Cloudflare
 *   Email Routing stamps in `Authentication-Results` (authserv-id
 *   `mx.cloudflare.net`). apps/api turns them into the sender trust verdict.
 * - `INBOUND_TRUST_HEADER`: the verdict apps/api returned, injected into the
 *   replayed message so the DO reads it from `headers.get()` and from the raw
 *   MIME bytes alike. Any sender-supplied copy is stripped first.
 */

import type { EmailAuthResults } from "@tedix/api-contract/schemas/tedi-email";

export const INBOUND_TRUST_HEADER = "x-tedix-inbound-trust";
export type InboundTrust = "trusted" | "untrusted";

/** Only verdicts stamped by Cloudflare's own MX count. */
const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

type Verdict = EmailAuthResults["dkim"];

function toVerdict(value: string | undefined): Verdict {
	return value === "pass"
		? "pass"
		: value === "none" || !value
			? "none"
			: "fail";
}

/**
 * Parses the topmost `Authentication-Results` header, which must carry the
 * authserv-id `mx.cloudflare.net`. Cloudflare Email Routing prepends its own
 * header above the sender's; a sender-supplied copy lower down is ignored, and
 * a message whose first header is not Cloudflare's yields no results at all.
 */
export function parseAuthenticationResults(
	values: readonly string[],
): EmailAuthResults | undefined {
	const raw = values[0];
	if (!raw) return undefined;
	const value = raw.replace(/\s+/g, " ").trim();
	const semicolon = value.indexOf(";");
	if (semicolon === -1) return undefined;
	const authservId = value.slice(0, semicolon).trim().split(" ")[0];
	if (authservId?.toLowerCase() !== TRUSTED_AUTHSERV_ID) return undefined;

	const result: EmailAuthResults = { dkim: "none", dmarc: "none", spf: "none" };
	for (const clause of value.slice(semicolon + 1).split(";")) {
		const stripped = clause.replace(/\([^)]*\)/g, " ").trim();
		const match = stripped.match(/^(dkim|dmarc|spf)=([a-z]+)\b(.*)$/i);
		if (!match) continue;
		const method = match[1]!.toLowerCase() as "dkim" | "dmarc" | "spf";
		const verdict = toVerdict(match[2]!.toLowerCase());
		const properties = match[3] ?? "";
		const property = (name: string) =>
			properties
				.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`, "i"))?.[1]
				?.toLowerCase();
		if (method === "dkim") {
			result.dkim = verdict;
			const domain =
				property("header\\.d") ?? property("header\\.i")?.replace(/^.*@/, "");
			if (domain) result.dkimDomain = domain;
		} else if (method === "dmarc") {
			result.dmarc = verdict;
			const domain = property("header\\.from");
			if (domain) result.dmarcDomain = domain;
		} else {
			result.spf = verdict;
			const domain = property("smtp\\.mailfrom")?.replace(/^.*@/, "");
			if (domain) result.spfDomain = domain;
		}
	}
	return result;
}

const HEADER_BODY_SEPARATOR = /\r?\n\r?\n/;

function bytesToLatin1(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 1)
		out += String.fromCharCode(bytes[i]!);
	return out;
}

function latin1ToBytes(value: string): Uint8Array {
	const out = new Uint8Array(value.length);
	for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff;
	return out;
}

/**
 * Returns the raw message with every sender-supplied trust header removed
 * (folded continuation lines included) and ours prepended to the header block.
 */
export function stampInboundTrustOnRawBytes(
	rawBytes: Uint8Array,
	trust: InboundTrust,
): Uint8Array {
	const raw = bytesToLatin1(rawBytes);
	const separator = raw.match(HEADER_BODY_SEPARATOR);
	const headerEnd = separator?.index ?? raw.length;
	const headerBlock = raw.slice(0, headerEnd);
	const rest = raw.slice(headerEnd);
	const forgedHeader = new RegExp(
		`^${INBOUND_TRUST_HEADER}:[^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*(?:\\r?\\n|$)`,
		"gim",
	);
	// A forged header that closed the block leaves a dangling line break.
	const cleaned = headerBlock.replace(forgedHeader, "").replace(/\r?\n$/, "");
	const ours = `${INBOUND_TRUST_HEADER}: ${trust}`;
	return latin1ToBytes(`${cleaned ? `${ours}\r\n${cleaned}` : ours}${rest}`);
}

/** A header map with sender-supplied trust headers dropped and ours set. */
export function stampInboundTrustOnHeaders(
	headers: Pick<Headers, "forEach"> | undefined,
	trust: InboundTrust,
): Headers {
	const stamped = new Headers();
	headers?.forEach((value, name) => {
		if (name.toLowerCase() === INBOUND_TRUST_HEADER) return;
		stamped.append(name, value);
	});
	stamped.set(INBOUND_TRUST_HEADER, trust);
	return stamped;
}
