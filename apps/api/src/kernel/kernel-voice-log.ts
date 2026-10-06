import { safeExceptionTopology } from "../lib/safe-log-metadata";

type VoiceLogFields = Record<string, string | undefined>;

export function logKernelVoiceFailure(
	event: string,
	error: unknown,
	fields: VoiceLogFields = {},
): void {
	console.error({
		component: "kernel-voice",
		event,
		...fields,
		exception: safeExceptionTopology(error),
	});
}

export function logKernelVoiceEvent(
	event: string,
	fields: VoiceLogFields,
): void {
	console.error({ component: "kernel-voice", event, ...fields });
}
