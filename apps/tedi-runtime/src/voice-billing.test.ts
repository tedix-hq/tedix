import assert from "node:assert/strict";
import type {
	RuntimeVoiceAdmission,
	RuntimeVoiceCompletion,
} from "@tedix/voice/billing";
import { billStreamingTranscription } from "./voice-billing";

const subject = {
	organizationId: "org-1",
	tediId: "tedi-1",
	userId: "member-1",
};
const admissions: RuntimeVoiceAdmission[] = [];
const completions: RuntimeVoiceCompletion[] = [];
const pending: Promise<void>[] = [];
let denied = false;
const env = {
	TEDIX_BILLING_SETTLEMENT_MODE: "managed",
	AI_GATEWAY_ACCOUNT_ID: "account-1",
	API_SERVICE: {
		async reserveRuntimeVoice(input: RuntimeVoiceAdmission) {
			admissions.push(input);
			return denied
				? {
						refusal: {
							code: "member_monthly_credit_cap_reached",
							message: "Member cap reached",
							scope: "call",
						},
					}
				: { reservationId: `reservation-${admissions.length}` };
		},
		async finishRuntimeVoice(input: RuntimeVoiceCompletion) {
			completions.push(input);
		},
	},
} as unknown as Cloudflare.Env;
const upstreamSocket = new EventTarget();
const upgraded = Object.assign(new Response(null), {
	webSocket: upstreamSocket,
});
let calls = 0;
let fail = false;
const ai = billStreamingTranscription(
	{
		async run() {
			calls++;
			assert.equal(admissions.length, calls);
			if (fail) throw new Error("provider unavailable");
			return upgraded;
		},
	},
	env,
	subject,
	(work) => pending.push(work),
);

const model = "@cf/deepgram/flux";
assert.equal(await ai.run(model, {}, { websocket: true }), upgraded);
assert.deepEqual(admissions[0], {
	...subject,
	attempt: {
		provider: "workers-ai",
		model,
		deploymentScope: '["workers-ai","account-1"]',
		usageKind: "voice_stt",
		unit: "seconds",
		estimatedQuantity: 300,
	},
});
upstreamSocket.dispatchEvent(new Event("close"));
upstreamSocket.dispatchEvent(new Event("close"));
await Promise.all(pending);
assert.deepEqual(completions, [
	{
		organizationId: subject.organizationId,
		reservationId: "reservation-1",
		usage: { quantity: 1, measured: false },
	},
]);

fail = true;
await assert.rejects(ai.run(model, {}), /provider unavailable/);
assert.deepEqual(completions[1], {
	organizationId: subject.organizationId,
	reservationId: "reservation-2",
	reason: "provider_failed",
});

denied = true;
await assert.rejects(ai.run(model, {}), {
	code: "member_monthly_credit_cap_reached",
});
assert.equal(calls, 2);
