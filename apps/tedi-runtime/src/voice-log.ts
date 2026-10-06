import { exceptionTopology } from "./exception-topology";

type VoiceComponent = "voice-call" | "voice-input";
type VoiceLogFields = {
	connectionId?: string;
	retryable?: boolean;
};

export function logTediVoiceFailure(
	component: VoiceComponent,
	event: string,
	error: unknown,
	fields: VoiceLogFields = {},
): void {
	console.error({
		component,
		event,
		...fields,
		exception: exceptionTopology(error),
	});
}

export function logTediVoiceEvent(
	component: VoiceComponent,
	event: string,
	fields: VoiceLogFields = {},
): void {
	console.error({ component, event, ...fields });
}

const HIDDEN_VOICE_FIELDS = new Set([
	"preview",
	"transcript",
	"error",
	"message",
	"text",
	"content",
]);

export function logTediVoiceTelemetry(
	component: VoiceComponent,
	event: string,
	fields?: Record<string, unknown>,
): void {
	const safe = fields
		? Object.fromEntries(
				Object.entries(fields).filter(([key]) => !HIDDEN_VOICE_FIELDS.has(key)),
			)
		: undefined;
	const label = component === "voice-call" ? "VoiceCallDO" : "VoiceInputDO";
	console.log(`[${label}] ${event}`, safe ? JSON.stringify(safe) : "");
}

export function voiceErrorRetryable(error: unknown): boolean {
	try {
		return (
			error !== null &&
			typeof error === "object" &&
			(error as { retryable?: unknown }).retryable === true
		);
	} catch {
		return false;
	}
}
