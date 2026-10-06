import { implement } from "@orpc/server";
import { voiceContract } from "@tedix/api-contract/contracts/voice";
import { getTediById } from "@tedix/db/queries/tedis";
import { synthesizeSpeech, type VoiceTtsEnv } from "@tedix/voice/tts";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const voiceOs = implement(voiceContract).$context<BaseContext>();
const authed = voiceOs.use(withAuth);

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

async function authorizeSpokenReplySubject(
	context: BaseContext,
	subject: { type: "kernel" } | { type: "tedi"; tediId: string },
): Promise<void> {
	if (subject.type === "kernel") {
		if (!context.organizationId) {
			throw createError(
				ErrorCodes.UNAUTHORIZED,
				"Organization context required",
			);
		}
		return;
	}

	const tedi = await getTediById(context.db, subject.tediId);
	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}
	if (context.tediId && context.tediId !== subject.tediId) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}
	if (
		context.organizationId &&
		tedi.organizationId !== context.organizationId
	) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}
	if (!context.organizationId && !context.tediId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}
}

export const voiceContractRouter = voiceOs.router({
	synthesizeSpokenReply: authed.synthesizeSpokenReply
		.use(AUTHZ.tedisRead)
		.handler(async ({ context, input }) => {
			await authorizeSpokenReplySubject(context, input.subject);
			try {
				const speech = await synthesizeSpeech(
					context.env as unknown as VoiceTtsEnv,
					{
						text: input.text,
						voice: input.voice,
					},
				);
				return {
					audioBase64: bytesToBase64(speech.audio),
					mimeType: speech.mimeType,
					provider: speech.provider,
				};
			} catch (error) {
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					error instanceof Error ? error.message : "TTS failed",
				);
			}
		}),
});
