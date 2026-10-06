/**
 * The Durable Object's embedded-session internal routes.
 *
 * `do.ts` is the least reviewable file in the repository, so these handlers live
 * here and the kernel keeps only the dispatch. They are request/response
 * plumbing over methods the DO owns — no state of their own.
 *
 * ── Schema warm ───────────────────────────────────────────────────────────
 * Resolve an embedded session's tool schemas before the person asks anything.
 *
 * A cold isolate paid 3.8-13.4s of `tedix_mcp_code` describe in front of the
 * first word of the first answer, measured from `tedi_runtime_events` on live
 * staging turns. It recurs after every deploy and every Durable Object
 * hibernation, so it lands on most FIRST questions — the ones a person judges
 * the product by. The panel authorizes several seconds before anything is
 * typed, and this spends that gap instead of the user's.
 *
 * Best effort by construction. It populates the same module-scope cache the
 * turn path reads and returns nothing; if it is slow, cancelled, or fails, the
 * next turn describes inline exactly as it did before. Nothing here starts a
 * run, writes a message, or carries a platform client, so a warm cannot land in
 * the ledger.
 *
 */

import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import type { AgentMcpRuntime } from "./mcp-client-runtime";
import { preparedTedixMcpAITools } from "./ai-sdk-adapter";

/** The tenant binding a signed embedded session carries, as sent by the edge. */
export interface EmbeddedWarmPayload {
	session_key?: string;
	tool_argument_constraints?: Record<string, string>;
	tool_namespace_prefix?: string;
	tool_allowed_callables?: string[];
	embedded_session_token?: string;
}

export interface EmbeddedWarmDeps {
	/** The bound runtime, or `null` when this tedi has no MCP surface. */
	getMcpRuntime: () => Promise<AgentMcpRuntime | null | undefined>;
	/**
	 * Slug or id of this tedi. It becomes the owner half of the conversation
	 * id, which is the tenant boundary in the schema cache key — so the warm
	 * must derive it exactly as the turn does.
	 */
	tediRef: string;
	defaultSessionKey: string;
}

/**
 * Build the binding the turn path builds and ask for the same prepared tool
 * set. The describe is the side effect; the ToolSet is discarded.
 */
export async function warmEmbeddedToolSchemas(
	payload: EmbeddedWarmPayload,
	deps: EmbeddedWarmDeps,
): Promise<void> {
	try {
		const mcpRuntime = await deps.getMcpRuntime();
		if (!mcpRuntime || !payload.tool_argument_constraints) return;
		const warmId = `warm:${crypto.randomUUID()}`;
		await preparedTedixMcpAITools(mcpRuntime, {
			conversationId: buildTediConversationId({
				tediRef: deps.tediRef,
				sessionKey: payload.session_key || deps.defaultSessionKey,
			}),
			runId: warmId,
			traceId: warmId,
			toolArgumentConstraints: payload.tool_argument_constraints,
			toolNamespacePrefix: payload.tool_namespace_prefix,
			toolAllowedCallables: payload.tool_allowed_callables,
			embeddedSessionToken: payload.embedded_session_token,
		});
	} catch (error) {
		// A failed warm is not a failed session: the next turn describes inline.
		console.warn(
			"[embedded.warm] tool schema warm failed:",
			error instanceof Error ? error.message : error,
		);
	}
}

/**
 * `POST /__internal/chat/warm`. Always 204 — the caller does not await this and
 * has nothing to do with a failure.
 */
export async function handleEmbeddedWarmRequest(
	request: Request,
	deps: EmbeddedWarmDeps,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	const payload = (await request
		.json()
		.catch(() => ({}))) as EmbeddedWarmPayload;
	// Only a tenant-bound embedded session has schemas worth resolving.
	if (payload.tool_argument_constraints) {
		await warmEmbeddedToolSchemas(payload, deps);
	}
	return new Response(null, { status: 204 });
}

/** What `/__internal/messages/read` needs from the Durable Object. */
export interface EmbeddedTranscriptDeps {
	ensureIdentity: () => Promise<unknown>;
	readMessagesForSession: (
		sessionKey: string,
		limit?: number,
	) => Promise<unknown>;
	defaultSessionKey: string;
}

/**
 * `POST /__internal/messages/read` — the transcript the widget restores into
 * its panel on open. Unparseable input is a 400 rather than a default read, so
 * a malformed client never silently receives someone's default session.
 */
export async function handleEmbeddedTranscriptRequest(
	request: Request,
	deps: EmbeddedTranscriptDeps,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	await deps.ensureIdentity();
	let payload: { session_key?: string; limit?: number };
	try {
		payload = (await request.json()) as {
			session_key?: string;
			limit?: number;
		};
	} catch {
		return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
	}
	return Response.json(
		await deps.readMessagesForSession(
			payload.session_key || deps.defaultSessionKey,
			typeof payload.limit === "number" ? payload.limit : undefined,
		),
	);
}
