// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";
import { handleTediConsole } from "./tedi-console";
const snapshot = {
	tediId: "atlas",
	name: "Atlas <script>",
	readOnly: true,
	workspaces: [
		{
			id: "research",
			name: "Research <img>",
			description: "<script>untrusted</script>",
		},
	],
	outputs: [{ id: "report", title: "Report <script>", kind: "document" }],
};
function api() {
	return {
		fetch: vi.fn(async (request: Request) => {
			expect(request.headers.get("Authorization")).toBe("Bearer tcs_fictional");
			expect(request.headers.get("X-Tedix-Tenant-Id")).toBe("tenant-acme");
			expect(request.headers.get("Cookie")).toBeNull();
			expect(request.headers.get("X-Service-Binding")).toBeNull();
			return Response.json({ json: snapshot });
		}),
	};
}
describe("tedi console browser identity", () => {
	it("does not consume a human console cookie", async () => {
		const binding = api();
		const response = await handleTediConsole(
			new Request("https://acme.os.example/tedi-console", {
				headers: { Cookie: "__Host-tedix-os-session=human" },
			}),
			binding,
			"tenant-acme",
		);
		expect(response.status).toBe(401);
		expect(binding.fetch).not.toHaveBeenCalled();
	});
	it("installs only an explicit restricted credential as a separate HttpOnly host cookie", async () => {
		const response = await handleTediConsole(
			new Request("https://acme.os.example/tedi-console/session", {
				method: "POST",
				headers: {
					Authorization: "Bearer tcs_fictional",
					Cookie: "__Host-tedix-os-session=human",
					"X-Service-Binding": "true",
				},
			}),
			api(),
			"tenant-acme",
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("Set-Cookie")).toBe(
			"__Host-tedix-tedi-console=tcs_fictional; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300",
		);
		expect(response.headers.get("Location")).toBe("/tedi-console");
	});
	it("renders escaped read-only data and revalidates the credential at the API", async () => {
		const binding = api();
		const response = await handleTediConsole(
			new Request("https://acme.os.example/tedi-console?workspace=research", {
				headers: {
					Cookie:
						"__Host-tedix-tedi-console=tcs_fictional; __Host-tedix-os-session=human",
				},
			}),
			binding,
			"tenant-acme",
		);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Read-only");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(binding.fetch).toHaveBeenCalledTimes(1);
	});
	it("fails closed on tenant refusal and rejects write methods", async () => {
		const binding = {
			fetch: vi.fn(async () =>
				Response.json({ json: { code: "FORBIDDEN" } }, { status: 403 }),
			),
		};
		expect(
			(
				await handleTediConsole(
					new Request("https://other.os.example/tedi-console", {
						headers: { Cookie: "__Host-tedix-tedi-console=tcs_fictional" },
					}),
					binding,
					"tenant-other",
				)
			).status,
		).toBe(403);
		expect(
			(
				await handleTediConsole(
					new Request("https://acme.os.example/tedi-console", {
						method: "POST",
					}),
					binding,
					"tenant-acme",
				)
			).status,
		).toBe(405);
	});
});
