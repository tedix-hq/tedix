import assert from "node:assert/strict";
import type { Transcriber, TranscriberSessionOptions } from "@cloudflare/voice";
import {
	createInstrumentedVoiceTranscriber,
	filterVoiceUtterance,
	installVoiceWireGuard,
} from "./runtime";

const speech = "private spoken passphrase sk_live_secret";

{
	const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	const result = filterVoiceUtterance(speech, {
		fields: () => ({ conn: "connection" }),
		log: (event, fields) => events.push({ event, fields }),
	});
	assert.equal(result, speech);
	assert.deepEqual(events, [
		{
			event: "utterance",
			fields: { conn: "connection", chars: speech.length },
		},
	]);
}

{
	const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	let options: TranscriberSessionOptions | undefined;
	const base = {
		createSession(input?: TranscriberSessionOptions) {
			options = input;
			return {
				feed: () => undefined,
				close: () => undefined,
				waitUntilReady: () => Promise.resolve(),
			};
		},
	} as Transcriber;
	const transcriber = createInstrumentedVoiceTranscriber({
		base,
		fields: () => ({ conn: "connection" }),
		log: (event, fields) => events.push({ event, fields }),
	});
	assert.ok(transcriber);
	const session = transcriber.createSession({ onUtterance: () => undefined });
	options?.onUtterance?.(speech);
	assert.equal(
		events.some(({ event }) => event === "stt.utterance.raw"),
		true,
	);
	assert.doesNotMatch(JSON.stringify(events), /private spoken|sk_live_secret/);
	session.close();
}

{
	const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	const host: {
		onMessage: (connection: { id: string }, message: unknown) => unknown;
	} = { onMessage: () => undefined };
	installVoiceWireGuard(host, {
		log: (event, fields) => events.push({ event, fields }),
	});
	host.onMessage({ id: "connection" }, JSON.stringify({ type: speech }));
	host.onMessage({ id: "connection" }, { [Symbol.toStringTag]: speech });
	class RejectedBlob extends Blob {
		override arrayBuffer(): Promise<ArrayBuffer> {
			return Promise.reject(new Error(speech));
		}
	}
	await host.onMessage({ id: "connection" }, new RejectedBlob());
	assert.deepEqual(events, [
		{
			event: "wire.json",
			fields: { conn: "connection", parsed: true },
		},
		{
			event: "wire.other",
			fields: { conn: "connection", kind: "object" },
		},
		{
			event: "wire.blob_error",
			fields: { conn: "connection", errorType: "Error" },
		},
	]);
	assert.doesNotMatch(JSON.stringify(events), /private spoken|sk_live_secret/);
}

console.log("voice runtime diagnostics omit speech and raw errors");
