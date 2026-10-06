/**
 * Kernel — conversation-origin classification.
 *
 * 14 of 16 sidebar entries under TODAY were machine traffic ("Count Tedis via
 * MCP", "Remember Number 2685", "ISOLATED_OK", "Work Board Item Count") sharing
 * one namespace with the operator's own chats. Nothing on the conversation
 * record could tell them apart: `kernel_conversations.channel` is hardcoded
 * `"home"` on every kernel write path, and `KernelRuntimeEvent` carries no
 * actor. This module is the missing discriminator.
 *
 * It classifies the REQUEST, not the text. An operator typing in Tedix OS arrives as
 * a Descope User JWT over public HTTPS; an MCP probe, CLI script, cron, tedi,
 * or coding harness arrives as one of the machine principal classes, or as a
 * user credential REPLAYED by the MCP protocol edge. Title text is never
 * consulted — a human is perfectly entitled to name a chat "ISOLATED_OK".
 *
 * Fail-safe direction is fixed and one-way: anything this module cannot place
 * is `human`. An unstamped row is human, an unauthenticated/synthetic context
 * is human, an unrecognised principal class is human. The cost of a false
 * `human` is one noisy sidebar row; the cost of a false `agent` is the
 * operator's own conversation disappearing.
 *
 * Leaf module: type-only imports plus `BaseContext`. Both `run-store.ts` (the
 * event choke point that stamps) and `conversation-index.ts` (the projection
 * that reads the stamp back off the payload) depend on it, so it must not
 * import either.
 */

import type { KernelConversationOrigin } from "@tedix/db/queries/kernel-conversations";
import type { BaseContext } from "../../orpc";

export type { KernelConversationOrigin };

/**
 * Set by `apps/mcp` on EVERY tool execution it forwards to apps/api
 * (`handler.ts`, unconditional). It is the only reliable "this came through
 * the MCP protocol edge" marker: `X-Tedix-Caller-Type: mcp-edge-user` cannot
 * be used, because the browser service-binding transport deliberately reuses
 * that same forwarded-human contract.
 * A browser request never carries this header.
 */
const MCP_EDGE_TOOL_ID_HEADER = "X-Tedix-Mcp-Tool-Id";

/**
 * Payload key carrying the stamp on a `message.received` event. Rides the
 * free-form `RuntimeMetadataSchema` payload (sibling to `role` / `channel` /
 * `content`) so the `KernelRuntimeEvent` envelope stays unchanged and the
 * projection is still rebuildable from the ledger.
 */
export const KERNEL_CONVERSATION_ORIGIN_PAYLOAD_KEY = "origin";

/**
 * Classify the calling principal of a Home turn.
 *
 * `human` ⇐ a Descope User JWT that did NOT arrive through the MCP edge. That
 * is the direct Tedix OS web path.
 *
 * `agent` ⇐ any of:
 * - a machine principal class (`apikey`, `m2m`, `tedi`, `service-binding`) —
 *   see docs/platform/auth.md,
 * - a gateway-verified external coding agent (Claude Code / Codex), which
 *   rides a service binding but carries its own principal id,
 * - a user credential replayed by the MCP protocol edge. `tedix ask`, Code
 *   Mode, and every MCP smoke test land here even when the underlying token
 *   is the operator's own OAuth session: the call is programmatic, and that is
 *   the traffic this stamp exists to separate.
 *
 * Anything else — including an undefined `authType`, which is what synthetic
 * and Durable-Object contexts have — is `human`.
 */
export function resolveKernelConversationOrigin(
	context: Pick<BaseContext, "authType" | "externalAgentPrincipalId"> & {
		headers?: Headers;
	},
): KernelConversationOrigin {
	switch (context.authType) {
		case "apikey":
		case "m2m":
		case "tedi":
		case "service-binding":
			return "agent";
		default:
			break;
	}
	if (context.externalAgentPrincipalId) return "agent";
	if (context.headers?.get(MCP_EDGE_TOOL_ID_HEADER)) return "agent";
	return "human";
}

/** The org's durable main Home thread — the operator's own conversation. */
export const MAIN_HOME_CONVERSATION_ID = "home:main";

/**
 * Namespace for a machine caller's OWN default Home thread.
 *
 * Reads as "the agent surface", matching the existing `home:<surface>:<scope>`
 * keys (`home:cli:<cwd>`, `home:cli:thread:<name>`) and the `origin` column's
 * human/agent vocabulary. It is NOT the per-tedi runtime namespace: a tedi
 * conversation is `agent:main:*`, with no `home:` prefix, and the prefix alone
 * still discriminates the store that owns the transcript.
 */
const AGENT_HOME_CONVERSATION_PREFIX = "home:agent:";

/** Keep a scope segment printable and stable inside a conversation key. */
function conversationKeyScope(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.slice(0, 80);
}

/**
 * Which Home conversation an ABSENT `conversationId` means for this caller.
 *
 * `home:main` is the operator's durable thread — the one a human reads in Tedix OS.
 * Before this resolver every machine caller that omitted `conversationId`
 * inherited it, so a `ask` Code Mode probe wrote its turn INTO the
 * operator's transcript.
 *
 * Classify the REQUEST, never the text — the same rule this module's origin
 * stamp follows, and it is load-bearing here. An earlier revision of this
 * comment cited "5 of 7 user turns were probe strings" based on `LIVE_*`-looking
 * message text; four of those five turns were in fact the OPERATOR's own,
 * `source=os.home` with their email attached, typed while hand-running
 * validation. Any cleanup keyed on marker text would have deleted their words.
 *
 * So an agent caller's default is its OWN thread instead, scoped by the
 * narrowest stable identity available. Deliberately NOT applied to reads: a
 * probe writing into the operator's thread is the defect, whereas an agent
 * READING `home:main` is both harmless and often the point (checking what the
 * operator asked). Reads keep the `home:main` default; a caller that wants its
 * own thread back passes the key `ask` returned.
 *
 * Fail-safe direction is inherited from `resolveKernelConversationOrigin`:
 * anything unclassifiable is `human`, so an unknown caller still lands on
 * `home:main` rather than having its turn hidden from the operator.
 */
export function defaultHomeConversationIdForCaller(
	context: Pick<
		BaseContext,
		"authType" | "externalAgentPrincipalId" | "tediId"
	> & { headers?: Headers },
): string {
	if (resolveKernelConversationOrigin(context) === "human") {
		return MAIN_HOME_CONVERSATION_ID;
	}
	// Narrowest stable identity first: one thread per coding-agent principal or
	// per tedi, so an agent's own follow-up turns stay coherent. A bare
	// principal class is next — it buckets all of that class's traffic together,
	// which is still strictly better than the operator's thread. Only a MACHINE
	// class may name a scope: an `authType` of "user" that reached here was
	// classified agent by the MCP-edge header alone, so it belongs to `mcp` (the
	// Code Mode / smoke-probe case) and must not mint a `home:agent:user` key
	// that reads as if the operator owned it.
	const machineClass =
		context.authType && context.authType !== "user" ? context.authType : null;
	const scope =
		context.externalAgentPrincipalId ??
		(context.tediId ? `tedi-${context.tediId}` : null) ??
		machineClass ??
		"mcp";
	return `${AGENT_HOME_CONVERSATION_PREFIX}${conversationKeyScope(scope)}`;
}

/**
 * Read the stamp back off an event payload. Returns `null` (not `"human"`)
 * when the key is absent or unrecognised, so the projection can tell "no
 * stamp on this event" from "explicitly human" and leave the column alone
 * rather than writing a default over a real value.
 */
export function kernelConversationOriginFromPayload(
	payload: Record<string, unknown> | undefined,
): KernelConversationOrigin | null {
	const value = payload?.[KERNEL_CONVERSATION_ORIGIN_PAYLOAD_KEY];
	return value === "human" || value === "agent" ? value : null;
}
