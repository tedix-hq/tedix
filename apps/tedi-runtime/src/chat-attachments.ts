import type { AudioAttachment } from "@tedix/voice/stt";

/**
 * Validate + normalize inbound chat attachments. Untrusted JSON from the Tedix OS /
 * MCP edge; we keep only well-formed `{content,fileName,mimeType,type}` entries
 * and cap the array so a malformed/oversized body cannot blow the DO budget.
 * The per-attachment byte cap is enforced downstream by `@tedix/voice/stt`.
 */
const MAX_CHAT_ATTACHMENTS = 8;

/**
 * Azure chat deployments known to be multimodal (vision) on this runtime. The
 * isolate body is pinned to a single `AZURE_CHAT_DEPLOYMENT` (GPT-6.1 Sol by default);
 * image attachments only reach the model when that deployment is vision-capable.
 * If the deployment ever changes to a non-vision model, image resolution FAILS
 * SOFT to the filename note (the existing behavior) — this is the runtime
 * vision-capability guard the multimodal turn path checks. Match is by prefix so
 * dated/region-suffixed deployment names still resolve.
 */
const VISION_CHAT_DEPLOYMENT_PREFIXES = [
	"gpt-6.1-sol",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-5.6",
	"gpt-5",
	"gpt-4.1",
	"gpt-4o",
	"gpt-4-vision",
	"gpt-4-turbo",
] as const;

/** True when the pinned Azure chat deployment is vision-capable. Drives the
 * FAIL-SOFT decision to inline image attachments vs. fall back to the note. */
export function isVisionCapableChatDeployment(
	deployment: string | undefined,
): boolean {
	if (!deployment) return false;
	const normalized = deployment.trim().toLowerCase();
	return VISION_CHAT_DEPLOYMENT_PREFIXES.some((prefix) =>
		normalized.startsWith(prefix),
	);
}

export function sanitizeChatAttachments(
	value: unknown,
): AudioAttachment[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const out: AudioAttachment[] = [];
	for (const raw of value.slice(0, MAX_CHAT_ATTACHMENTS)) {
		if (!raw || typeof raw !== "object") continue;
		const a = raw as Record<string, unknown>;
		const content = typeof a.content === "string" ? a.content : "";
		const fileName = typeof a.fileName === "string" ? a.fileName : "";
		const mimeType = typeof a.mimeType === "string" ? a.mimeType : "";
		const type = a.type;
		if (!content) continue;
		if (type !== "audio" && type !== "file" && type !== "image") continue;
		out.push({ content, fileName, mimeType, type });
	}
	return out.length > 0 ? out : undefined;
}
