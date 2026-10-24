import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { signMediaUrl } from "../lib/skill-media-url";
import { registerSkillMediaRoutes } from "./skill-media-routes";

const { getRunArtifact } = vi.hoisted(() => ({ getRunArtifact: vi.fn() }));
vi.mock("@tedix/db/queries/skill-run-artifacts", () => ({ getRunArtifact }));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));

const env = {
	SECRETS_MASTER_KEY: "test-media-signing-key",
} as CloudflareEnv;
const app = new Hono<{ Bindings: CloudflareEnv }>();
registerSkillMediaRoutes(app);

describe("signed skill-media paths", () => {
	beforeEach(() => {
		getRunArtifact.mockReset().mockResolvedValue({
			mimeType: "application/json",
			contentInline: JSON.stringify({
				value: { imageBase64: "SGVsbG8=", mimeType: "image/png" },
			}),
			contentR2Key: null,
		});
	});

	it.each([
		"outputs/chart#1.json",
		"outputs/chart?size=2.json",
		"outputs/chart%2F1.json",
		"outputs/chart%invalid.json",
		"outputs/chart 1.json",
		"outputs/日本語.json",
		"outputs/chart\\1.json",
	])("serves the exact artifact path %s", async (path) => {
		const { url } = await signMediaUrl({
			baseUrl: "https://media.example.test",
			secret: env.SECRETS_MASTER_KEY,
			runId: "run-1",
			path,
			nowMs: Date.now(),
		});
		const response = await app.request(url, undefined, env);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("Hello");
		expect(getRunArtifact).toHaveBeenCalledExactlyOnceWith({}, "run-1", path);
	});

	it("rejects a changed filename before reading an artifact", async () => {
		const { url } = await signMediaUrl({
			baseUrl: "https://media.example.test",
			secret: env.SECRETS_MASTER_KEY,
			runId: "run-1",
			path: "outputs/chart#1.json",
			nowMs: Date.now(),
		});
		const swapped = new URL(url);
		swapped.pathname = "/skill-media/run-1/outputs/chart%232.json";
		const response = await app.request(swapped, undefined, env);
		expect(response.status).toBe(403);
		expect(getRunArtifact).not.toHaveBeenCalled();
	});
});

describe("malformed stored MIME metadata", () => {
	const sign = (path: string) =>
		signMediaUrl({
			baseUrl: "https://media.example.test",
			secret: env.SECRETS_MASTER_KEY,
			runId: "run-1",
			path,
			nowMs: Date.now(),
		});

	it("answers 415, not a thrown response, when the media JSON mimeType breaks headers", async () => {
		getRunArtifact.mockResolvedValue({
			mimeType: "application/json",
			contentInline: JSON.stringify({
				value: {
					imageBase64: "SGVsbG8=",
					mimeType: "image/png\r\nSet-Cookie: session=evil",
				},
			}),
			contentR2Key: null,
		});
		const { url } = await sign("outputs/a.json");
		const response = await app.request(url, undefined, env);
		expect(response.status).toBe(415);
	});

	it("answers 415 when the media JSON mimeType is not a string", async () => {
		getRunArtifact.mockResolvedValue({
			mimeType: "application/json",
			contentInline: JSON.stringify({
				value: { imageBase64: "SGVsbG8=", mimeType: 123 },
			}),
			contentR2Key: null,
		});
		const { url } = await sign("outputs/a.json");
		const response = await app.request(url, undefined, env);
		expect(response.status).toBe(415);
	});

	it("answers 415 when the stored R2 artifact mimeType breaks headers", async () => {
		getRunArtifact.mockResolvedValue({
			mimeType: "image/png\r\nSet-Cookie: session=evil",
			contentInline: null,
			contentR2Key: "run-1/outputs/generate-image.media",
		});
		const { url } = await sign("outputs/generate-image.media");
		const response = await app.request(url, undefined, {
			...env,
			SKILL_ARTIFACTS: {
				get: async () => new Response("image bytes"),
			},
		} as CloudflareEnv);
		expect(response.status).toBe(415);
	});
});
