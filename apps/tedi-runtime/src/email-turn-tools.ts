/**
 * Tool surface for an inbound-email turn, selected by sender trust.
 *
 * The sender of an inbound email is unauthenticated. `email-ingress.ts`
 * stamps the message with `x-tedix-inbound-trust: trusted | untrusted`; a
 * missing or unrecognised header is untrusted. A trusted turn keeps the full
 * facet tool surface (the tedi reads its own mailbox that way). An untrusted
 * turn keeps only `reply_to_email` and the exact-name read-only allowlist —
 * see `turn-trust.ts`, which owns the shared policy for every surface.
 */
import type { Tool, ToolSet } from "ai";
import { INBOUND_TRUST_HEADER } from "./email-sender-policy";
import {
	type SurfaceTrust,
	selectTrustedTurnTools,
	trustedTurnMemoryEffects,
	UNTRUSTED_TURN_BASE_ALLOWLIST,
	untrustedTurnSystemAddendum,
} from "./turn-trust";

export type InboundEmailTrust = SurfaceTrust;

export const REPLY_TO_EMAIL_TOOL = "reply_to_email";

/** Exact tool names an untrusted sender's turn may still see. Read-only. */
export const UNTRUSTED_EMAIL_TOOL_ALLOWLIST: ReadonlySet<string> =
	UNTRUSTED_TURN_BASE_ALLOWLIST;

export function inboundEmailTrust(headers: {
	get(name: string): string | null;
}): InboundEmailTrust {
	return headers.get(INBOUND_TRUST_HEADER)?.trim().toLowerCase() === "trusted"
		? "trusted"
		: "untrusted";
}

export function selectEmailTurnTools(input: {
	trust: InboundEmailTrust;
	full: ToolSet;
	replyTool: Tool;
}): ToolSet {
	return selectTrustedTurnTools({
		trust: input.trust,
		full: input.full,
		allowlist: UNTRUSTED_EMAIL_TOOL_ALLOWLIST,
		extra: { [REPLY_TO_EMAIL_TOOL]: input.replyTool },
	});
}

export function emailTurnSystemAddendum(trust: InboundEmailTrust): string {
	return trust === "trusted" ? "" : untrustedTurnSystemAddendum("email");
}

export const emailTurnMemoryEffects = trustedTurnMemoryEffects;
