import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("@cloudflare/sandbox", () => ({ DirectoryBackupGateway: class {} }));
vi.mock("@tedix/container-runtime/sandbox", () => ({
	NativeContainerSandbox: class {},
}));

vi.mock("./agent/storage", () => ({ getCmsTemplateSelection: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
	DurableObject: class {},
	WorkerEntrypoint: class {},
	WorkflowEntrypoint: class {},
}));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class extends Error {},
}));
vi.mock("./agent/deploy-workflow", () => ({
	DeployWorkflow: class {},
	deployStatusKey: vi.fn(),
}));
vi.mock("./agent/image-generation-workflow", () => ({
	ImageGenerationWorkflow: class {},
	imageGenerationStatusKey: vi.fn(),
}));
vi.mock("./container/site-builder-sandbox", () => ({
	SiteBuilderSandboxRuntime: class {},
}));
vi.mock("./sandbox", () => ({ getSiteBuilderSandbox: vi.fn() }));

const jwt = vi.hoisted(() => ({ validateToken: vi.fn() }));
vi.mock("@tedix/auth/jwt", () => jwt);

import { authenticateRequest } from "./index";

const env = { PLATFORM_SERVICE_TOKEN: "service-secret" } as never;
const tediHeaders = {
	"X-Tedix-Tedi-Id": "cto-1",
	"X-Tedix-Tedi-Scopes": "mcp:content.admin platform:admin",
	"X-Tedix-Actor-Type": "tedi",
	"X-Tedix-Actor-Id": "cto-1",
	"X-Tedix-Connection-Label": "tedix",
};
function request(headers: Record<string, string>) {
	return new Request("https://builder.tedix.dev/mcp", { headers });
}

describe("CMS tedi platform delegation", () => {
	beforeEach(() => {
		jwt.validateToken.mockReset();
		jwt.validateToken.mockRejectedValue(new Error("Invalid token"));
	});

	it("accepts matching tedi profile authority only with the service credential", async () => {
		expect(
			await authenticateRequest(
				request({
					...tediHeaders,
					Authorization: "Bearer service-secret",
				}),
				env,
			),
		).toMatchObject({
			authenticated: true,
			authType: "service-token",
			platformAdmin: true,
			orgSlug: "tedix",
		});
		expect(jwt.validateToken).not.toHaveBeenCalled();
	});

	it.each([
		{ "X-Tedix-Tedi-Scopes": "mcp:content.admin" },
		{ "X-Tedix-Tedi-Id": "" },
		{ "X-Tedix-Actor-Id": "other-tedi" },
		{ "X-Tedix-Actor-Type": "service" },
		{ "X-Tedix-Actor-Type": "kernel" },
		{ "X-Tedix-Tedi-Scopes": "" },
	])(
		"denies platform authority for incomplete or ordinary delegation %j",
		async (override) => {
			expect(
				await authenticateRequest(
					request({
						...tediHeaders,
						...override,
						Authorization: "Bearer service-secret",
					}),
					env,
				),
			).toMatchObject({
				authenticated: true,
				platformAdmin: false,
				orgSlug: "tedix",
			});
		},
	);

	it.each([undefined, "Bearer wrong-secret"])(
		"ignores spoofed delegation without the service credential %s",
		async (authorization) => {
			const headers: Record<string, string> = { ...tediHeaders };
			if (authorization) headers.Authorization = authorization;
			expect(await authenticateRequest(request(headers), env)).toMatchObject({
				authenticated: false,
			});
		},
	);

	it("does not elevate a valid ordinary user token using tedi headers", async () => {
		jwt.validateToken.mockResolvedValue({ sub: "human-1" });
		const headers = { ...tediHeaders, Authorization: "Bearer human-token" };
		delete (headers as Partial<typeof headers>)["X-Tedix-Connection-Label"];
		expect(await authenticateRequest(request(headers), env)).toMatchObject({
			authenticated: true,
			authType: "user",
			platformAdmin: false,
		});
	});

	it("preserves explicitly granted forwarded human platform authority", async () => {
		jwt.validateToken.mockResolvedValue({
			sub: "human-1",
			scope: "platform:admin",
		});
		expect(
			await authenticateRequest(
				request({
					Authorization: "Bearer service-secret",
					"X-Forwarded-Authorization": "Bearer aaa.bbb.ccc",
				}),
				env,
			),
		).toMatchObject({ authenticated: true, platformAdmin: true });
	});
});
