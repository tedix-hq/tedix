import { describe, expect, it, vi } from "vite-plus/test";
import { createWidgetIdentify } from "./identify";
const profile = (user = "one", installation = "shop") => ({
	installationId: installation,
	user: { hostUserId: user, externalTenantId: installation },
	company: { externalTenantId: installation },
});
const response = (body: unknown) => new Response(JSON.stringify(body));
describe("authenticated widget identify", () => {
	it("rejects foreign origins before any request", () => {
		const fetcher = vi.fn();
		expect(() =>
			createWidgetIdentify({
				endpoint: "//evil.example/identify",
				origin: "https://host.example",
				fetch: fetcher,
				onIdentity: vi.fn(),
			}),
		).toThrow("same-origin");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("uses only authenticated POST, detects user and business changes", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(response(profile()))
			.mockResolvedValueOnce(response(profile()))
			.mockResolvedValueOnce(response(profile("two")))
			.mockResolvedValueOnce(response(profile("two", "other")));
		const onIdentity = vi.fn();
		const client = createWidgetIdentify({
			endpoint: "/identify",
			origin: "https://host.example",
			fetch: fetcher,
			onIdentity,
		});
		await client.identify();
		await client.identify();
		await client.identify();
		await client.identify();
		expect(onIdentity.mock.calls.map((call) => call[1])).toEqual([
			false,
			false,
			true,
			true,
		]);
		expect(fetcher.mock.calls[0]).toEqual([
			"https://host.example/identify",
			expect.objectContaining({
				method: "POST",
				credentials: "same-origin",
				redirect: "error",
			}),
		]);
		expect(fetcher.mock.calls[0]![1]).not.toHaveProperty("body");
	});
	it("does not revive a widget after logout even when fetch ignores abort", async () => {
		let resolve!: (value: Response) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((done) => {
					resolve = done;
				}),
		);
		const onIdentity = vi.fn();
		const client = createWidgetIdentify({
			endpoint: "/identify",
			origin: "https://host.example",
			fetch: fetcher,
			onIdentity,
		});
		const pending = client.identify();
		client.shutdown();
		resolve(response(profile()));
		await expect(pending).rejects.toThrow("superseded");
		expect(onIdentity).not.toHaveBeenCalled();
	});
	it("rejects mismatched company attribution and unauthorized responses", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				response({ ...profile(), company: { externalTenantId: "other" } }),
			)
			.mockResolvedValueOnce(new Response(null, { status: 401 }));
		const onIdentity = vi.fn();
		const client = createWidgetIdentify({
			endpoint: "/identify",
			origin: "https://host.example",
			fetch: fetcher,
			onIdentity,
		});
		await expect(client.identify()).rejects.toThrow("Invalid");
		await expect(client.identify()).rejects.toThrow("failed");
		expect(onIdentity).not.toHaveBeenCalled();
	});
});
