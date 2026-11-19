vi.mock("@tedix/db/queries/data-residency", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/data-residency")>()),
	getOrganizationResidencyPolicy: vi.fn().mockResolvedValue(null),
}));
import { DatabaseSync } from "node:sqlite";
import {
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { suspendBrowserAgentSeat } from "@tedix/db/queries/organization-members";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { handleKernelVoiceTranscription } from "./voice-transcription-route";
import { mintKernelWsToken } from "./ws-token";
const transcribe = vi.hoisted(() => vi.fn());
vi.mock("@tedix/voice/stt", () => ({
	encodeBase64Audio: () => "audio-bytes",
	transcribeAudioAttachment: transcribe,
}));
const ORG = "11111111-2222-3333-4444-555555555555",
	KEY = "test-key";
let env: CloudflareEnv;
let sqlite: DatabaseSync;
const URL = "https://api.tedix.dev/kernel/voice/transcribe";
beforeEach(async () => {
	vi.resetAllMocks();
	transcribe.mockResolvedValue({ text: "dictated text" });
	sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec(schemaDdl(organizations, organizationMembers));
	// Empty governed-rate table: no voice rate is published.
	sqlite.exec(
		`CREATE TABLE provider_model_rate_versions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model_id TEXT NOT NULL, deployment_scope TEXT NOT NULL, input_token_min INTEGER NOT NULL DEFAULT 0, input_token_max INTEGER, effective_from TEXT NOT NULL, input_microusd_per_million INTEGER NOT NULL, output_microusd_per_million INTEGER NOT NULL, cache_read_microusd_per_million INTEGER NOT NULL, cache_write_microusd_per_million INTEGER NOT NULL, currency TEXT NOT NULL, evidence_uri TEXT NOT NULL, evidence_digest TEXT NOT NULL, verified_at TEXT NOT NULL, published_at TEXT NOT NULL, published_by TEXT NOT NULL, change_reason TEXT NOT NULL, supersedes_rate_version_id TEXT)`,
	);
	env = {
		DB: createD1Facade(sqlite),
		PLATFORM_SERVICE_TOKEN: KEY,
		TEDIX_BILLING_SETTLEMENT_MODE: "external",
	} as CloudflareEnv;
	const db = createDbClient(env.DB);
	await db.insert(organizations).values({
		id: ORG,
		name: "Fictional team",
		slug: "fictional-team",
	});
	await db.insert(organizationMembers).values([
		{
			id: "seat",
			organizationId: ORG,
			userId: "seat-user",
			descopeUserId: "user",
			email: "seat@example.test",
			kind: "browser_agent",
			representedUserId: "owner-user",
			role: "member",
			status: "active",
		},
		{
			id: "owner",
			organizationId: ORG,
			userId: "owner-user",
			descopeUserId: "owner-provider",
			email: "owner@example.test",
			kind: "human",
			role: "owner",
			status: "active",
		},
	]);
});
async function upload(file?: File) {
	const { token } = await mintKernelWsToken({
		organizationId: ORG,
		descopeUserId: "user",
		platformServiceToken: KEY,
	});
	const form = new FormData();
	if (file) form.set("file", file);
	return new Request(URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"X-Kernel-Organization-Id": "spoofed",
		},
		body: form,
	});
}
describe("voice transcription", () => {
	it("denies a token minted before seat suspension before parsing audio", async () => {
		const request = await upload(new File(["audio"], "clip.webm"));
		const parse = vi.spyOn(request, "formData");
		await suspendBrowserAgentSeat(createDbClient(env.DB), {
			organizationId: ORG,
			memberId: "seat",
			actorUserId: "owner-user",
		});
		expect((await handleKernelVoiceTranscription(request, env)).status).toBe(
			403,
		);
		expect(parse).not.toHaveBeenCalled();
		expect(transcribe).not.toHaveBeenCalled();
	});
	it.each([
		"DELETE FROM organization_members WHERE id = 'seat'",
		"UPDATE organization_members SET status = 'deactivated' WHERE id = 'owner'",
		"DROP TABLE organization_members",
	])("denies unavailable membership authority: %s", async (change) => {
		const request = await upload(new File(["audio"], "clip.webm"));
		const parse = vi.spyOn(request, "formData");
		sqlite.exec(change);
		expect((await handleKernelVoiceTranscription(request, env)).status).toBe(
			403,
		);
		expect(parse).not.toHaveBeenCalled();
		expect(transcribe).not.toHaveBeenCalled();
	});
	it("authenticates before parsing or forwarding audio", async () => {
		expect(
			(
				await handleKernelVoiceTranscription(
					new Request(URL, { method: "POST", body: "invalid" }),
					env,
				)
			).status,
		).toBe(401);
		expect(transcribe).not.toHaveBeenCalled();
	});
	it("uses canonical authenticated organization for gateway metadata", async () => {
		const response = await handleKernelVoiceTranscription(
			await upload(new File(["audio"], "clip.webm", { type: "audio/webm" })),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: "dictated text" });
		expect(transcribe).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				type: "audio",
				fileName: "clip.webm",
				mimeType: "audio/webm",
			}),
			{
				gatewayMetadata: { orgId: ORG, source: "composer-dictation" },
				billing: undefined,
			},
		);
	});
	it("admits managed dictation against the organization's credits", async () => {
		env.TEDIX_BILLING_SETTLEMENT_MODE = "managed";
		transcribe.mockImplementationOnce(async (_env, _audio, options) => {
			// No governed voice rate is published in this database.
			await options.billing.admit({
				provider: "workers-ai",
				model: "@cf/openai/whisper",
				deploymentScope: '["workers-ai","acct"]',
				usageKind: "voice_stt",
				unit: "seconds",
				estimatedQuantity: 4,
			});
			return { text: "unreachable" };
		});
		const response = await handleKernelVoiceTranscription(
			await upload(new File(["audio"], "clip.webm")),
			env,
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Inference blocked by billing policy: pricing_unavailable",
			code: "pricing_unavailable",
		});
	});
	it("rejects absent, empty and oversized audio", async () => {
		for (const file of [
			undefined,
			new File([], "empty.webm"),
			new File([new Uint8Array(25 * 1024 * 1024 + 1)], "large.webm"),
		]) {
			const response = await handleKernelVoiceTranscription(
				await upload(file),
				env,
			);
			expect(response.status).toBe(file?.size ? 413 : 400);
		}
		expect(transcribe).not.toHaveBeenCalled();
	});
	it("rejects malformed uploads after authentication", async () => {
		const request = await upload();
		request.headers.set("Content-Type", "text/plain");
		expect((await handleKernelVoiceTranscription(request, env)).status).toBe(
			400,
		);
		expect(transcribe).not.toHaveBeenCalled();
	});
	it("returns a bounded provider failure", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		transcribe.mockRejectedValueOnce(
			new Error("spoken content sk_live_secret", {
				cause: new TypeError("provider DSR=secret"),
			}),
		);
		expect(
			(
				await handleKernelVoiceTranscription(
					await upload(new File(["audio"], "clip.webm")),
					env,
				)
			).status,
		).toBe(502);
		expect(log).toHaveBeenCalledWith({
			component: "kernel-voice",
			event: "voice.transcription_failed",
			organizationId: ORG,
			exception: { type: "Error", cause: { type: "TypeError" } },
		});
		expect(JSON.stringify(log.mock.calls)).not.toMatch(
			/spoken content|sk_live_secret|DSR=secret|stack/,
		);
	});
});
