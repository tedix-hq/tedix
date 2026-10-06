import { describe, expect, it, vi } from "vite-plus/test";
import type { AggregateTediEntry } from "./aggregate-tedis";
import {
	buildAggregateCompletionHandler,
	buildSkillCompletionHandler,
} from "./completions";

const TEDIS: AggregateTediEntry[] = [
	{
		slug: "cto",
		namespace: "cto",
		sessionKey: "agent:main:main",
		tediId: "11111111-1111-1111-1111-111111111111",
	},
	{
		slug: "cmo",
		namespace: "marketing",
		sessionKey: "agent:main:cmo",
		tediId: "22222222-2222-2222-2222-222222222222",
	},
];

function makeEnv(overrides: Partial<CloudflareEnv> = {}): CloudflareEnv {
	return { ...overrides } as unknown as CloudflareEnv;
}

function req(name: string, value: string) {
	return {
		ref: { type: "ref/prompt" as const, name: "compose" },
		argument: { name, value },
	};
}

describe("buildSkillCompletionHandler (SEP-2640 skill-template variables)", () => {
	const handler = buildSkillCompletionHandler({
		skillNames: ["deploy-widget", "deploy-worker", "review-pr"],
		appSlugs: ["tedix", "acme"],
	});

	it("completes skill_name filtered by the partial value", () => {
		const result = handler(req("skill_name", "deploy"));
		expect(result?.values).toEqual(
			expect.arrayContaining(["deploy-widget", "deploy-worker"]),
		);
		expect(result?.values).not.toContain("review-pr");
	});

	it("completes app_slug", () => {
		const result = handler(req("app_slug", "ac"));
		expect(result?.values).toEqual(["acme"]);
	});

	it("returns null for arguments it does not own (falls through to the aggregate completer)", () => {
		expect(handler(req("tediId", "cto"))).toBeNull();
		expect(handler(req("conversationId", "x"))).toBeNull();
	});
});

describe("buildAggregateCompletionHandler", () => {
	it("completes slug arguments from the aggregate tedis", async () => {
		const handler = buildAggregateCompletionHandler({
			aggregateTedis: TEDIS,
			env: makeEnv(),
		});
		const result = await handler(req("slug", "c"));
		// prefix matches first (cto, cmo), namespace + slug both surfaced
		expect(result.values).toContain("cto");
		expect(result.values).toContain("cmo");
		// "marketing" is a substring match for "" only, not for "c"
		expect(result.values).not.toContain("marketing");
	});

	it("completes namespace arguments and dedupes", async () => {
		const handler = buildAggregateCompletionHandler({
			aggregateTedis: TEDIS,
			env: makeEnv(),
		});
		const result = await handler(req("namespace", ""));
		expect(result.values).toEqual(
			expect.arrayContaining(["cto", "cmo", "marketing"]),
		);
		// cto appears once even though namespace === slug === "cto"
		expect(result.values.filter((v) => v === "cto")).toHaveLength(1);
	});

	it("completes tediId arguments from hydrated ids only", async () => {
		const handler = buildAggregateCompletionHandler({
			aggregateTedis: [...TEDIS, { slug: "unhydrated" }],
			env: makeEnv(),
		});
		const result = await handler(req("tediId", "2222"));
		expect(result.values).toEqual(["22222222-2222-2222-2222-222222222222"]);
	});

	it("completes session_key from static keys without an org (no fetch)", async () => {
		const fetchSpy = vi.fn();
		const handler = buildAggregateCompletionHandler({
			aggregateTedis: TEDIS,
			env: makeEnv({ API_SERVICE: { fetch: fetchSpy } as never }),
		});
		const result = await handler(req("session_key", "agent"));
		expect(result.values).toEqual(
			expect.arrayContaining(["agent:main:main", "agent:main:cmo"]),
		);
		// No org → no conversation fetch.
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("merges conversation ids from one bounded read for conversationId", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						json: {
							conversations: [
								{ id: "conv-abc" },
								{ id: "conv-xyz" },
								{ id: "other" },
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const handler = buildAggregateCompletionHandler({
			aggregateTedis: TEDIS,
			organizationId: "org-1",
			env: makeEnv({ API_SERVICE: { fetch: fetchSpy } as never }),
		});
		const result = await handler(req("conversationId", "conv"));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result.values).toEqual(
			expect.arrayContaining(["conv-abc", "conv-xyz"]),
		);
		expect(result.values).not.toContain("other");
	});

	it("returns no suggestions for unknown argument names", async () => {
		const handler = buildAggregateCompletionHandler({
			aggregateTedis: TEDIS,
			env: makeEnv(),
		});
		const result = await handler(req("temperature", "0."));
		expect(result.values).toEqual([]);
	});

	it("never throws when the conversation read fails", async () => {
		const fetchSpy = vi.fn(async () => {
			throw new Error("upstream down");
		});
		const handler = buildAggregateCompletionHandler({
			aggregateTedis: TEDIS,
			organizationId: "org-1",
			env: makeEnv({ API_SERVICE: { fetch: fetchSpy } as never }),
		});
		const result = await handler(req("conversation_id", ""));
		// Static session keys still come back; the failed fetch contributes nothing.
		expect(result.values).toEqual(
			expect.arrayContaining(["agent:main:main", "agent:main:cmo"]),
		);
	});
});
