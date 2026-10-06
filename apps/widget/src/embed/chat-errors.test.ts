import { describe, expect, it } from "vite-plus/test";
import { buildTranslate } from "@tedix/widget-i18n";
import enCatalog from "@tedix/widget-i18n/en.json";
import esCatalog from "@tedix/widget-i18n/es.json";

const en = buildTranslate(enCatalog);
const es = buildTranslate(esCatalog, enCatalog);
import {
	type ChatErrorCode,
	classifyChatError,
	userFacingChatError,
} from "./chat-errors";

const abort = () => new DOMException("stopped", "AbortError");

/**
 * One case per code the embed can emit. These assert on the RUNTIME MESSAGE
 * TEXT each rule matches, which is the point: every rule is a regex over
 * wording the runtime chose, so a reword upstream silently collapses that case
 * to `runtime_error` and takes the telemetry distinction with it. Failing here
 * is how that reword becomes visible.
 */
const CASES: ReadonlyArray<{ code: ChatErrorCode; error: unknown }> = [
	{ code: "aborted", error: abort() },
	{
		code: "inference_capacity_exhausted",
		error: new Error("inference_capacity_exhausted"),
	},
	{
		code: "inference_capacity_exhausted",
		error: new Error("inference blocked by billing policy"),
	},
	...[
		"Inference daily budget exhausted for 2026-09-12 (95904/100000 tokens, 13/100 turns)",
		"Inference daily budget exhausted for 2026-09-12 (1000/100000 tokens, 100/100 turns)",
		"daily inference token budget exhausted mid-turn",
	].map((message) => ({
		code: "inference_capacity_exhausted" as const,
		error: new Error(message),
	})),
	{ code: "session_expired", error: new Error("Session expired") },
	{
		code: "stream_ended_before_completion",
		error: new Error("subscription ended before completion"),
	},
	{ code: "stream_unavailable", error: new Error("stream_unavailable") },
	{ code: "runtime_error", error: new Error("something else entirely") },
	{ code: "runtime_error", error: new Error("Browser daily budget exhausted") },
];

describe("classifyChatError", () => {
	for (const { code, error } of CASES) {
		it(`classifies ${String(error)} as ${code}`, () => {
			expect(classifyChatError(error)).toBe(code);
		});
	}

	it("survives a non-Error throw without claiming a specific cause", () => {
		expect(classifyChatError("stream_unavailable")).toBe("stream_unavailable");
		expect(classifyChatError(null)).toBe("runtime_error");
		expect(classifyChatError(undefined)).toBe("runtime_error");
	});

	it("prefers the more specific rule when a message could match twice", () => {
		expect(
			classifyChatError(new Error("session expired: stream_unavailable")),
		).toBe("session_expired");
	});
});

describe("userFacingChatError", () => {
	it("shows localized capacity guidance for daily limits without leaking usage", () => {
		const error = new Error(
			"Inference daily budget exhausted for 2026-09-12 (95904/100000 tokens, 13/100 turns)",
		);
		// The assistant's name is configuration, so the sentence carries a token
		// rather than a brand: whoever renders it supplies the configured name.
		expect(userFacingChatError(error, es)).toBe(
			"{{assistant}} no tiene capacidad disponible en este momento. Inténtalo de nuevo más tarde.",
		);
		expect(userFacingChatError(error, en)).toBe(
			"{{assistant}} has no capacity available right now. Try again later.",
		);
	});

	it("reads copy from the catalog, in any locale", () => {
		const error = new Error("inference_capacity_exhausted");
		expect(userFacingChatError(error, en)).toContain("no capacity");
		expect(userFacingChatError(error, es)).toContain("capacidad");
		// A locale with no entry falls back to the source catalog rather than
		// rendering a key at the customer.
		expect(userFacingChatError(error, buildTranslate({}, enCatalog))).toContain(
			"no capacity",
		);
	});

	it("tells a stopped request apart from a failure", () => {
		expect(userFacingChatError(abort(), en)).toBe("Request stopped.");
		expect(userFacingChatError(abort(), es)).toBe("Solicitud detenida.");
	});

	/**
	 * The drift this module exists to prevent. The two helpers used to
	 * re-implement the abort and capacity checks independently, so a change to
	 * one could leave the customer reading "try again" while telemetry recorded
	 * a stop — or vice versa. Both now derive from one match, so every case has
	 * to agree by construction.
	 */
	it("never shows the stopped-request copy for a code that is not aborted", () => {
		for (const { code, error } of CASES) {
			const copy = userFacingChatError(error, en);
			const saysStopped = copy === "Request stopped.";
			expect(saysStopped).toBe(code === "aborted");
		}
	});

	it("gives the capacity case its own copy and everything else the generic one", () => {
		for (const { code, error } of CASES) {
			const copy = userFacingChatError(error, en);
			if (code === "aborted") continue;
			expect(copy.includes("no capacity")).toBe(
				code === "inference_capacity_exhausted",
			);
		}
	});
});

it("describes a deployment interruption without claiming completion or replay", () => {
	const error = new Error("Durable Object reset because its code was updated.");
	expect(classifyChatError(error)).toBe("runtime_interrupted");
	expect(userFacingChatError(error, en)).toBe(
		"The connection was interrupted by a service update. The request could not be completed.",
	);
	expect(userFacingChatError(error, es)).toBe(
		"Una actualización del servicio interrumpió la conexión. No se pudo completar la solicitud.",
	);
});
