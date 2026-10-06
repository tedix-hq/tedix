import { encodeBase64Audio, transcribeAudioAttachment } from "@tedix/voice/stt";
import { authenticateKernelEdge } from "./edge-auth";
import { logKernelVoiceFailure } from "./kernel-voice-log";

const MAX_DICTATION_BYTES = 25 * 1024 * 1024;

export async function handleKernelVoiceTranscription(
	request: Request,
	env: CloudflareEnv,
): Promise<Response> {
	const auth = await authenticateKernelEdge(request, env);
	if (!auth.ok) return auth.response;
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return Response.json({ error: "Invalid audio upload" }, { status: 400 });
	}
	const file = form.get("file");
	if (!(file instanceof File) || file.size === 0)
		return Response.json({ error: "Audio file is required" }, { status: 400 });
	if (file.size > MAX_DICTATION_BYTES)
		return Response.json(
			{ error: "Audio recording is too large" },
			{ status: 413 },
		);
	try {
		const result = await transcribeAudioAttachment(
			env as unknown as Parameters<typeof transcribeAudioAttachment>[0],
			{
				type: "audio",
				content: encodeBase64Audio(new Uint8Array(await file.arrayBuffer())),
				fileName: file.name || "dictation.webm",
				mimeType: file.type || "audio/webm",
			},
			{
				gatewayMetadata: {
					channel: "composer-dictation",
					organizationId: auth.identity.organizationId,
				},
			},
		);
		return Response.json(result);
	} catch (error) {
		logKernelVoiceFailure("voice.transcription_failed", error, {
			organizationId: auth.identity.organizationId,
		});
		return Response.json({ error: "Transcription failed" }, { status: 502 });
	}
}
