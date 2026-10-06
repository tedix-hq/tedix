import { describe, expect, test } from "bun:test";
import {
	createLocalInferenceHandler,
	LOCAL_AI_GATEWAY_ID,
	resolveLocalGatewayAccountId,
	resolveLocalGatewayId,
} from "./proxy";

const TEST_ACCOUNT_ID = "0".repeat(32);

describe("local inference bridge", () => {
	test("injects the Gateway credential only on the exact Azure Gateway path", async () => {
		const requests: Request[] = [];
		const handler = createLocalInferenceHandler({
			token: "secret-token",
			accountId: TEST_ACCOUNT_ID,
			fetchImpl: async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json({ ok: true });
			},
		});
		const path = `/v1/${TEST_ACCOUNT_ID}/${LOCAL_AI_GATEWAY_ID}/azure-openai/tedix-resource/gpt-5.6-luna/chat/completions`;
		const response = await handler(
			new Request(`http://127.0.0.1:8791${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messages: [] }),
			}),
		);

		expect(response.status).toBe(200);
		expect(requests[0]?.url).toBe(`https://gateway.ai.cloudflare.com${path}`);
		expect(requests[0]?.headers.get("cf-aig-authorization")).toBe(
			"Bearer secret-token",
		);
		expect(requests[0]?.redirect).toBe("error");
	});

	test("uses a neutral default and explicit Gateway overrides", () => {
		expect(resolveLocalGatewayId({})).toBe("local-development");
		expect(resolveLocalGatewayId({ CF_AI_GATEWAY_ID: " my-gateway " })).toBe(
			"my-gateway",
		);
		expect(
			resolveLocalGatewayId({
				CF_AI_GATEWAY_ID: "other-gateway",
				TEDIX_LOCAL_AI_GATEWAY_ID: "local-gateway",
			}),
		).toBe("local-gateway");
		for (const gatewayId of [
			"../gateway",
			"gateway/azure-openai",
			"gateway?query",
			"gateway#fragment",
		]) {
			expect(() =>
				resolveLocalGatewayId({ CF_AI_GATEWAY_ID: gatewayId }),
			).toThrow("Gateway id");
		}
	});

	test("custom Gateway paths still restrict the account, gateway, and provider", async () => {
		const requests: Request[] = [];
		const handler = createLocalInferenceHandler({
			token: "secret-token",
			accountId: TEST_ACCOUNT_ID,
			gatewayId: "my-gateway",
			fetchImpl: async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json({ ok: true });
			},
		});
		for (const path of [
			`/v1/${"1".repeat(32)}/my-gateway/azure-openai/x`,
			`/v1/${TEST_ACCOUNT_ID}/my-gateway-other/azure-openai/x`,
			`/v1/${TEST_ACCOUNT_ID}/my-gateway/openai/x`,
			`/v1/${TEST_ACCOUNT_ID}/${LOCAL_AI_GATEWAY_ID}/azure-openai/x`,
		]) {
			expect(
				(
					await handler(
						new Request(`http://127.0.0.1:8791${path}`, { method: "POST" }),
					)
				).status,
			).toBe(404);
		}
		expect(requests).toHaveLength(0);
		const path = `/v1/${TEST_ACCOUNT_ID}/my-gateway/azure-openai/x`;
		expect(
			(
				await handler(
					new Request(`http://127.0.0.1:8791${path}`, { method: "POST" }),
				)
			).status,
		).toBe(200);
		expect(requests[0]?.url).toBe(`https://gateway.ai.cloudflare.com${path}`);
		expect(requests[0]?.redirect).toBe("error");
	});

	test("never forwards unknown paths or methods", async () => {
		let calls = 0;
		const handler = createLocalInferenceHandler({
			token: "secret-token",
			accountId: TEST_ACCOUNT_ID,
			fetchImpl: async () => {
				calls += 1;
				return new Response();
			},
		});
		expect(
			(
				await handler(
					new Request(
						"http://127.0.0.1:8791/v1/foreign/gateway/azure-openai/x",
						{
							method: "POST",
						},
					),
				)
			).status,
		).toBe(404);
		expect(calls).toBe(0);
	});

	test("refuses an empty resolved credential", () => {
		expect(() =>
			createLocalInferenceHandler({
				token: " ",
				accountId: TEST_ACCOUNT_ID,
			}),
		).toThrow("CF_AI_GATEWAY_TOKEN resolved empty");
	});

	test("resolves the Gateway account from the environment, never a literal", () => {
		expect(
			resolveLocalGatewayAccountId({
				TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID: ` ${TEST_ACCOUNT_ID} `,
			}),
		).toBe(TEST_ACCOUNT_ID);
		expect(
			resolveLocalGatewayAccountId({ CF_ACCOUNT_ID: TEST_ACCOUNT_ID }),
		).toBe(TEST_ACCOUNT_ID);
		expect(() => resolveLocalGatewayAccountId({})).toThrow(
			"TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID",
		);
		expect(() =>
			resolveLocalGatewayAccountId({ CF_ACCOUNT_ID: "too-short" }),
		).toThrow("32-character");
	});
});
