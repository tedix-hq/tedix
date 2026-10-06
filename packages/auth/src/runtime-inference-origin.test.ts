import { describe, expect, it } from "vite-plus/test";
import {
	signRuntimeInferenceOrigin,
	verifyRuntimeInferenceOrigin,
} from "./runtime-inference-origin";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";
const secret = "local assertion test secret";
const nowMs = Date.UTC(2026, 9, 5, 12);
const owner = { orgId: "org", tediId: "tedi", objectId: "a".repeat(64) };
const origin = {
	kind: "unselected_native",
	root: {
		owner,
		objectName: "root",
		className: "AgentTediDO",
		path: [],
		generation: 0,
	},
	selected: {
		owner,
		identityName: "root",
		className: "AgentTediDO",
		facetName: null,
		path: [],
		generation: 0,
	},
	configurationHash: "b".repeat(64),
};
const request = {
	organizationId: "org",
	tediId: "tedi",
	settlementMode: "external",
	source: "observer",
	execution: {
		provider: "workers-ai",
		requestModel: "@cf/test",
		gatewayAccountId: "account",
		gatewayId: "gateway",
		transportKind: "workers-ai-binding",
		apiKind: "workers-ai-chat",
		providerResource: null,
		providerOrigin: null,
		deployment: null,
	},
	workItemId: null,
	estimatedInputTokens: 10,
	estimatedOutputTokens: 20,
	runId: null,
	traceId: null,
	idempotencyKey: "original-request",
	metadata: { source: "observer:test" },
};
async function resign(
	token: string,
	change: (payload: Record<string, unknown>) => void,
	purpose = "tedix.runtime-inference-origin.v1",
) {
	const payload = JSON.parse(
		Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
	);
	change(payload);
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const bytes = await hmacSha256(
		await deriveHkdfHmacKey(secret, purpose),
		encoded,
	);
	return `${encoded}.${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
describe("runtime application origin assertion", () => {
	it("round-trips truthful gen0 without an accepted claim, independently of object key order", async () => {
		const token = await signRuntimeInferenceOrigin({
			secret,
			request,
			origin,
			nowMs,
		});
		const reversed = Object.fromEntries(Object.entries(request).reverse());
		expect(
			await verifyRuntimeInferenceOrigin({
				secret,
				request: reversed,
				token,
				nowMs,
			}),
		).toEqual(origin);
		expect(
			JSON.stringify(
				JSON.parse(
					Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
				),
			),
		).not.toContain("observer:test");
	});
	it.each([
		"organizationId",
		"tediId",
		"source",
		"runId",
		"idempotencyKey",
		"estimatedInputTokens",
	])("binds request %s", async (key) => {
		const token = await signRuntimeInferenceOrigin({
			secret,
			request,
			origin,
			nowMs,
		});
		await expect(
			verifyRuntimeInferenceOrigin({
				secret,
				request: {
					...request,
					[key]: key === "estimatedInputTokens" ? 99 : "changed",
				},
				token,
				nowMs,
			}),
		).rejects.toThrow();
	});
	it("binds provider identity and rejects signature/secret tampering", async () => {
		const token = await signRuntimeInferenceOrigin({
			secret,
			request,
			origin,
			nowMs,
		});
		await expect(
			verifyRuntimeInferenceOrigin({
				secret,
				request: {
					...request,
					execution: { ...request.execution, requestModel: "@cf/other" },
				},
				token,
				nowMs,
			}),
		).rejects.toThrow();
		await expect(
			verifyRuntimeInferenceOrigin({ secret: "other", request, token, nowMs }),
		).rejects.toThrow();
		await expect(
			verifyRuntimeInferenceOrigin({
				secret,
				request,
				token: token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"),
				nowMs,
			}),
		).rejects.toThrow();
	});
	it.each(["purpose", "issuer", "audience", "nonce"])(
		"rejects even correctly signed wrong %s",
		async (key) => {
			const token = await signRuntimeInferenceOrigin({
				secret,
				request,
				origin,
				nowMs,
			});
			await expect(
				verifyRuntimeInferenceOrigin({
					secret,
					request,
					token: await resign(token, (p) => {
						p[key] = "wrong";
					}),
					nowMs,
				}),
			).rejects.toThrow();
		},
	);
	it("rejects purpose-derived key substitution, expiry, future issuance and extended TTL", async () => {
		const token = await signRuntimeInferenceOrigin({
			secret,
			request,
			origin,
			nowMs,
		});
		await expect(
			verifyRuntimeInferenceOrigin({
				secret,
				request,
				token: await resign(token, () => {}, "other-purpose"),
				nowMs,
			}),
		).rejects.toThrow();
		await expect(
			verifyRuntimeInferenceOrigin({
				secret,
				request,
				token,
				nowMs: nowMs + 60_000,
			}),
		).rejects.toThrow();
		await expect(
			verifyRuntimeInferenceOrigin({
				secret,
				request,
				token,
				nowMs: nowMs - 6_000,
			}),
		).rejects.toThrow();
		await expect(
			verifyRuntimeInferenceOrigin({
				secret,
				request,
				token: await resign(token, (p) => {
					p.expiresAt = Number(p.issuedAt) + 61;
				}),
				nowMs,
			}),
		).rejects.toThrow();
	});
	it("rejects missing owner, fabricated gen0 accepted claim, excess fields and oversized data", async () => {
		await expect(
			signRuntimeInferenceOrigin({
				secret,
				request: { ...request, tediId: null },
				origin,
				nowMs,
			}),
		).rejects.toThrow();
		await expect(
			signRuntimeInferenceOrigin({
				secret,
				request,
				origin: { ...origin, root: { ...origin.root, accepted: {} } },
				nowMs,
			}),
		).rejects.toThrow();
		await expect(
			signRuntimeInferenceOrigin({
				secret,
				request: { ...request, originToken: "cannot hash itself" },
				origin,
				nowMs,
			}),
		).rejects.toThrow();
		await expect(
			signRuntimeInferenceOrigin({
				secret,
				request: { ...request, metadata: { huge: "x".repeat(40_000) } },
				origin,
				nowMs,
			}),
		).rejects.toThrow();
		await expect(
			verifyRuntimeInferenceOrigin({
				secret,
				request,
				token: "x".repeat(20_000),
				nowMs,
			}),
		).rejects.toThrow();
	});
	it("binds the accepted original root run and retains only full-input hashes", async () => {
		const accepted = {
			owner,
			runId: "original",
			sessionKey: "session",
			principalId: "principal",
			generation: 2,
			inputHash: "c".repeat(64),
			requestHash: "d".repeat(64),
		};
		const selected = { ...origin.selected, generation: 2, accepted };
		const admitted = {
			kind: "accepted_native",
			root: { ...origin.root, generation: 2, accepted },
			selected,
			operation: null,
			configurationHash: null,
		};
		const token = await signRuntimeInferenceOrigin({
			secret,
			request: { ...request, runId: "original" },
			origin: admitted,
			nowMs,
		});
		expect(
			await verifyRuntimeInferenceOrigin({
				secret,
				request: { ...request, runId: "original" },
				token,
				nowMs,
			}),
		).toEqual(admitted);
		await expect(
			signRuntimeInferenceOrigin({
				secret,
				request: { ...request, runId: "wrong" },
				origin: admitted,
				nowMs,
			}),
		).rejects.toThrow();
	});
});

it("normalizes omitted optional attribution to null without signing its signature", async () => {
	const { runId: _run, traceId: _trace, ...omitted } = request;
	const token = await signRuntimeInferenceOrigin({
		secret,
		request: omitted,
		origin,
		nowMs,
	});
	expect(
		await verifyRuntimeInferenceOrigin({ secret, request, token, nowMs }),
	).toEqual(origin);
	await expect(
		verifyRuntimeInferenceOrigin({ secret, request, token, nowMs: NaN }),
	).rejects.toThrow();
});
