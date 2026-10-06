import { describe, expect, it, vi } from "vite-plus/test";
import {
	createDataForSeoClient,
	type DataForSeoError,
	type DataForSeoReceipt,
} from "./client";

function providerResponse(task: Record<string, unknown>) {
	return new Response(
		JSON.stringify({
			status_code: 20000,
			status_message: "Ok.",
			tasks: [
				{
					id: "task-123",
					status_code: 20000,
					status_message: "Ok.",
					cost: 0.0015,
					path: ["v3", "example", "live"],
					result: [{ items: [] }],
					...task,
				},
			],
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

describe("DataForSEO client", () => {
	it("uses Basic auth and records provider-reported cost before returning", async () => {
		const receipts: DataForSeoReceipt[] = [];
		const fetchImpl = vi.fn(async () => providerResponse({}));
		const client = createDataForSeoClient({
			credential: "base64-login-password",
			fetchImpl,
			recordReceipt: async (receipt) => {
				receipts.push(receipt);
			},
		});

		const result = await client.post("/v3/example/live", {
			keyword: "durable workers",
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		const [, init] = fetchImpl.mock.calls[0] ?? [];
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Basic base64-login-password",
		);
		expect(new Headers(init?.headers).get("User-Agent")).toBe("Tedix-SEO/1.0");
		expect(init?.body).toBe(JSON.stringify([{ keyword: "durable workers" }]));
		expect(receipts).toEqual([
			{
				providerTaskId: "task-123",
				endpoint: "/v3/example/live",
				path: ["v3", "example", "live"],
				costMicros: 1500,
				statusCode: 20000,
				statusMessage: "Ok.",
			},
		]);
		expect(result.receipt).toEqual(receipts[0]);
	});

	it("records a charged failed task before surfacing the provider error", async () => {
		const recordReceipt = vi.fn(async () => undefined);
		const client = createDataForSeoClient({
			credential: "Basic encoded-credential",
			fetchImpl: vi.fn(async () =>
				providerResponse({
					status_code: 40501,
					status_message: "Invalid Field: 'keyword'.",
					cost: 0.002,
				}),
			),
			recordReceipt,
		});

		await expect(
			client.post("/v3/example/live", { keyword: "" }),
		).rejects.toMatchObject<DataForSeoError>({
			name: "DataForSeoError",
			message: "Invalid Field: 'keyword'.",
			receipt: {
				providerTaskId: "task-123",
				costMicros: 2000,
				statusCode: 40501,
			},
		});
		expect(recordReceipt).toHaveBeenCalledOnce();
	});

	it("does not invent a receipt for an invalid response envelope", async () => {
		const recordReceipt = vi.fn(async () => undefined);
		const client = createDataForSeoClient({
			credential: "encoded-credential",
			fetchImpl: vi.fn(
				async () =>
					new Response(JSON.stringify({ status_code: 20000, tasks: [{}] })),
			),
			recordReceipt,
		});

		await expect(client.post("/v3/example/live", {})).rejects.toThrow(
			"invalid response envelope",
		);
		expect(recordReceipt).not.toHaveBeenCalled();
	});

	it("includes a bounded provider error detail for failed HTTP responses", async () => {
		const client = createDataForSeoClient({
			credential: "encoded-credential",
			fetchImpl: vi.fn(
				async () =>
					new Response("  request blocked by provider policy  ", {
						status: 403,
					}),
			),
			recordReceipt: vi.fn(async () => undefined),
		});

		await expect(client.post("/v3/example/live", {})).rejects.toThrow(
			"HTTP 403: request blocked by provider policy",
		);
	});

	it("surfaces account verification as structured recovery metadata", async () => {
		const client = createDataForSeoClient({
			credential: "encoded-credential",
			fetchImpl: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status_code: 40104,
							status_message:
								"Please verify your account before using the API.",
							cost: 0,
							tasks: null,
						}),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					),
			),
			recordReceipt: vi.fn(async () => undefined),
		});

		await expect(
			client.post("/v3/example/live", {}),
		).rejects.toMatchObject<DataForSeoError>({
			name: "DataForSeoError",
			message:
				"DataForSEO request failed with HTTP 403: Please verify your account before using the API.",
			receipt: null,
			providerStatusCode: 40104,
			recoveryAction: "verify_account",
		});
	});
});
