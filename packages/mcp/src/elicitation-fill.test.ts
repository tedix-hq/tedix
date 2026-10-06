/**
 * Deterministic MRTR input-request resolver — pure-function unit tests.
 * Used by the apps/mcp upstream proxy to answer an upstream's input_required.
 */
import type { InputResponses } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vite-plus/test";
import {
	deterministicElicitationContent,
	resolveInputRequestsDeterministic,
} from "./elicitation-fill";

describe("deterministicElicitationContent", () => {
	it("honors per-type defaults (SEP-1034)", () => {
		expect(
			deterministicElicitationContent({
				type: "object",
				properties: {
					stage: { type: "string", default: "Discovery" },
					count: { type: "integer", default: 3 },
					flag: { type: "boolean", default: true },
				},
			}),
		).toEqual({ stage: "Discovery", count: 3, flag: true });
	});

	it("fails closed: a required boolean confirm with no default → false", () => {
		expect(
			deterministicElicitationContent({
				type: "object",
				properties: { confirm: { type: "boolean" } },
				required: ["confirm"],
			}),
		).toEqual({ confirm: false });
	});

	it("picks the first scalar enum member", () => {
		expect(
			deterministicElicitationContent({
				type: "object",
				properties: { fare: { type: "string", enum: ["economy", "business"] } },
				required: ["fare"],
			}),
		).toEqual({ fare: "economy" });
	});

	it("multi-select array honors minItems", () => {
		expect(
			deterministicElicitationContent({
				type: "object",
				properties: {
					tags: {
						type: "array",
						items: { enum: ["a", "b", "c"] },
						minItems: 2,
					},
				},
			}),
		).toEqual({ tags: ["a", "b"] });
	});

	it("omits optional props with no default/enum; backfills required scalars", () => {
		expect(
			deterministicElicitationContent({
				type: "object",
				properties: {
					opt: { type: "string" },
					reason: { type: "string" },
				},
				required: ["reason"],
			}),
		).toEqual({ reason: "" });
	});
});

describe("resolveInputRequestsDeterministic", () => {
	it("returns null for empty requests", () => {
		expect(resolveInputRequestsDeterministic({})).toBeNull();
	});

	it("resolves an elicitation/create request as ElicitResult {action, content}", () => {
		const out = resolveInputRequestsDeterministic({
			approval: {
				method: "elicitation/create",
				params: {
					message: "Confirm?",
					requestedSchema: {
						type: "object",
						properties: { reason: { type: "string", default: "auto" } },
						required: ["reason"],
					},
				},
			},
		});
		expect(out).toEqual({
			approval: { action: "accept", content: { reason: "auto" } },
		});
	});

	it("defaults an untyped request to elicitation (spec default)", () => {
		const out = resolveInputRequestsDeterministic({
			q: { params: { requestedSchema: { type: "object", properties: {} } } },
		});
		expect(out).toEqual({ q: { action: "accept", content: {} } });
	});

	it("rejects removed Roots requests", () => {
		expect(
			resolveInputRequestsDeterministic({
				r: { method: "roots/list", params: {} },
			}),
		).toBeNull();
	});

	it("declines the whole resolution when any request needs a model (sampling)", () => {
		expect(
			resolveInputRequestsDeterministic({
				ok: {
					method: "elicitation/create",
					params: { requestedSchema: { type: "object", properties: {} } },
				},
				needsModel: { method: "sampling/createMessage", params: {} },
			}),
		).toBeNull();
	});

	it("emits the exact wire shape the SDK InputResponses contract requires", () => {
		const out = resolveInputRequestsDeterministic({
			approval: {
				method: "elicitation/create",
				params: {
					requestedSchema: {
						type: "object",
						properties: { reason: { type: "string", default: "x" } },
					},
				},
			},
		});
		// Runtime: an elicitation → ElicitResult {action,content}.
		expect(out?.approval).toEqual({
			action: "accept",
			content: { reason: "x" },
		});

		// Compile-time lock: the exact structures the resolver emits are
		// assignable to the SDK's `InputResponses` (InputResponse =
		// CreateMessageResult | ListRootsResult | ElicitResult) — the authoritative
		// type every conformant upstream validates the retry against. An SDK
		// contract change to that union breaks this build, not a live upstream.
		const _conformsToSdkContract: InputResponses = {
			approval: { action: "accept", content: { reason: "x" } },
			roots: { roots: [] },
		};
		expect(Object.keys(_conformsToSdkContract)).toHaveLength(2);
	});
});
