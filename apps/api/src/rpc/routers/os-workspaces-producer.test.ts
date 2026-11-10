import { describe, expect, it } from "vite-plus/test";
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import type { BaseContext } from "../context";
import { resolveCreator, resolveProducer } from "./os-workspaces-shared";

const RUN = "9f1e2d3c-4b5a-4697-8899-aabbccddeeff";

describe("Home receipt creator", () => {
	it("records the verified agent without granting an agent session", () => {
		const context = contextWith({
			"X-Tedix-Kernel": "true",
			"X-Tedix-Actor-Type": "external_agent",
			"X-Tedix-Actor-Id": RUN,
		});
		expect(resolveCreator(context)).toEqual({
			kind: "external_agent",
			id: RUN,
		});
		expect(context.externalAgentPrincipalId).toBeUndefined();
		expect(context.externalAgentSessionId).toBeUndefined();
	});
	it.each([
		{ "X-Service-Binding": "false" },
		{ "X-Tedix-Kernel": "false" },
		{ "X-Tedix-Actor-Type": "user" },
		{ "X-Tedix-Actor-Id": "unknown" },
	])("refuses untrusted or malformed creator claims: %j", (patch) => {
		expect(() =>
			resolveCreator(
				contextWith({
					"X-Tedix-Kernel": "true",
					"X-Tedix-Actor-Type": "external_agent",
					"X-Tedix-Actor-Id": RUN,
					...patch,
				}),
			),
		).toThrow("No accountable principal");
	});
	it("rejects creator headers after public ingress strips the trust marker", () => {
		const request = stripServiceBindingMarker(
			new Request("https://api.example.test/rpc", {
				headers: contextWith({
					"X-Tedix-Kernel": "true",
					"X-Tedix-Actor-Type": "external_agent",
					"X-Tedix-Actor-Id": RUN,
				}).headers,
			}),
		);
		expect(() =>
			resolveCreator({ headers: request.headers } as BaseContext),
		).toThrow("No accountable principal");
	});
});

function contextWith(headers: Record<string, string>): BaseContext {
	return {
		headers: new Headers({ "X-Service-Binding": "true", ...headers }),
	} as unknown as BaseContext;
}

describe("resolveProducer", () => {
	it("captures the lineage the workflow bridge forwards", () => {
		expect(
			resolveProducer(
				contextWith({
					"X-Tedix-Skill-Run-Id": RUN,
					"X-Tedix-Skill-Id": "acme-expert-opinion-video",
				}),
			),
		).toEqual({ skillRunId: RUN, skillId: "acme-expert-opinion-video" });
	});

	it("records no producer when no run header is present", () => {
		expect(resolveProducer(contextWith({}))).toEqual({
			skillRunId: null,
			skillId: null,
		});
	});

	it("drops a skill id that arrives without a run", () => {
		expect(
			resolveProducer(contextWith({ "X-Tedix-Skill-Id": "some-skill" })),
		).toEqual({ skillRunId: null, skillId: null });
	});

	it("rejects a malformed run id rather than persisting it", () => {
		expect(
			resolveProducer(contextWith({ "X-Tedix-Skill-Run-Id": "not-a-uuid" })),
		).toEqual({ skillRunId: null, skillId: null });
	});

	it("rejects a skill id carrying injection-shaped characters", () => {
		expect(
			resolveProducer(
				contextWith({
					"X-Tedix-Skill-Run-Id": RUN,
					"X-Tedix-Skill-Id": "bad id'; drop--",
				}),
			),
		).toEqual({ skillRunId: RUN, skillId: null });
	});

	it("trims surrounding whitespace before validating", () => {
		expect(
			resolveProducer(contextWith({ "X-Tedix-Skill-Run-Id": `  ${RUN}  ` })),
		).toEqual({ skillRunId: RUN, skillId: null });
	});

	it("never infers a producer from a caller principal", () => {
		// Provenance is not authority: an authenticated tedi calling the API
		// directly, with no forwarded run, must record no producing run.
		const context = {
			headers: new Headers(),
			tediId: "tedi-1",
			authType: "user",
		} as unknown as BaseContext;
		expect(resolveProducer(context)).toEqual({
			skillRunId: null,
			skillId: null,
		});
	});

	it("rejects producer headers spoofed on public ingress", () => {
		// Public ingress (the default export) strips the binding marker.
		const publicRequest = stripServiceBindingMarker(
			new Request("https://api.tedix.dev/rpc", {
				headers: {
					"CF-Connecting-IP": "203.0.113.4",
					"X-Service-Binding": "true",
					"X-Tedix-Skill-Run-Id": RUN,
				},
			}),
		);
		expect(() =>
			resolveProducer({
				headers: publicRequest.headers,
			} as unknown as BaseContext),
		).toThrow("trusted service-binding hop");
	});
});
