/**
 * Pure voice helpers — extracted so tests can import without pulling in
 * @cloudflare/voice or agents (which use cloudflare: protocol imports).
 */

import type { KernelTurnWorkResult } from "../rpc/routers/kernel/turn-work";

/**
 * Voice-shape a KernelTurnWorkResult into a short spoken sentence.
 * - requires_approval → brief approval notice
 * - empty content → queued/no-content ack
 * - otherwise → assistantMessage.content (already short for delegation/plain)
 */
export function voiceShapeResult(result: KernelTurnWorkResult): string {
	if (result.status === "requires_approval") {
		return "That change needs your approval — the request is in your Home feed.";
	}
	const content = result.assistantMessage.content.trim();
	if (!content) {
		return "I'm still working on that — the result will land in your Home feed.";
	}
	return content;
}
