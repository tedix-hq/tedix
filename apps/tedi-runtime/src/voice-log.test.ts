import assert from "node:assert/strict";
import {
	logTediVoiceEvent,
	logTediVoiceFailure,
	logTediVoiceTelemetry,
	voiceErrorRetryable,
} from "./voice-log";

const originalError = console.error;
const originalLog = console.log;
const failures: unknown[][] = [];
const telemetry: unknown[][] = [];

try {
	console.error = (...args: unknown[]) => {
		failures.push(args);
	};
	console.log = (...args: unknown[]) => {
		telemetry.push(args);
	};

	const error = new Error("spoken content sk_live_secret", {
		cause: new TypeError("provider DSR=refresh-secret"),
	});
	error.name = "private-error-name";
	logTediVoiceFailure("voice-call", "voice.on_error", error, {
		connectionId: "connection-1",
		retryable: true,
	});
	logTediVoiceEvent("voice-input", "voice.input_usage_org_missing");
	assert.deepEqual(failures, [
		[
			{
				component: "voice-call",
				event: "voice.on_error",
				connectionId: "connection-1",
				retryable: true,
				exception: {
					type: "UnknownThrown",
					cause: { type: "TypeError" },
				},
			},
		],
		[
			{
				component: "voice-input",
				event: "voice.input_usage_org_missing",
			},
		],
	]);
	assert.doesNotMatch(
		JSON.stringify(failures),
		/spoken content|sk_live_secret|DSR=refresh-secret|private-error-name|stack/,
	);

	for (const component of ["voice-call", "voice-input"] as const) {
		logTediVoiceTelemetry(component, "turn.start", {
			chars: 42,
			ms: 7,
			preview: "spoken content",
			transcript: "sk_live_secret",
			error: error,
			message: "DSR=refresh-secret",
			text: "private text",
			content: "private content",
		});
	}
	assert.equal(telemetry.length, 2);
	for (const line of telemetry) {
		assert.deepEqual(JSON.parse(line[1] as string), { chars: 42, ms: 7 });
	}
	assert.doesNotMatch(
		JSON.stringify(telemetry),
		/spoken content|sk_live_secret|DSR=refresh-secret|private text|private content/,
	);

	assert.equal(voiceErrorRetryable({ retryable: true }), true);
	assert.equal(
		voiceErrorRetryable({
			get retryable() {
				throw new Error("private getter text");
			},
		}),
		false,
	);
} finally {
	console.error = originalError;
	console.log = originalLog;
}

console.log("tedi voice logs keep bounded topology without speech content");
