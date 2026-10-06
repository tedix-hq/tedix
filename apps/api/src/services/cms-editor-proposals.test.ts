import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { proposeCmsEditorDraft } from "./cms-editor-proposals";
const mocks = vi.hoisted(() => ({ generate: vi.fn(), model: vi.fn() }));
vi.mock("../lib/traced-ai", () => ({
	tracedAi: { generateObject: mocks.generate },
	objectSpanTelemetry: () => ({ functionId: "cms.editor_proposal" }),
}));
vi.mock("../rpc/routers/kernel/llm", () => ({ kernelModel: mocks.model }));
const input = {
	siteId: "11111111-1111-4111-8111-111111111111",
	action: "rewrite" as const,
	draft: {
		collection: "posts",
		entryId: "entry",
		locale: "en",
		baseRevision: "rev",
		invocationId: "invocation-123456",
		fields: {
			title: "Old title",
			content: [
				{
					_type: "block",
					_key: "block1",
					children: [
						{
							_type: "span",
							_key: "span1",
							marks: ["link1"],
							text: "Old body",
						},
					],
					markDefs: [
						{ _key: "link1", _type: "link", href: "https://example.com" },
					],
				},
			],
		},
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.model.mockReturnValue({ model: {} });
	mocks.generate.mockResolvedValue({
		object: {
			segments: [
				{ id: "0", text: "New title" },
				{ id: "1", text: "New body" },
			],
		},
	});
});
describe("bounded CMS editor inference", () => {
	it("runs one tool-free bounded call billed to the owner and preserves Portable Text structure", async () => {
		const result = await proposeCmsEditorDraft({}, "owner-org", input);
		expect(mocks.model).toHaveBeenCalledWith(
			{},
			undefined,
			expect.objectContaining({
				organizationId: "owner-org",
				source: "cms_editor_proposal",
			}),
		);
		const call = mocks.generate.mock.calls[0]![0];
		expect(call).not.toHaveProperty("tools");
		expect(call.maxRetries).toBe(0);
		expect(call.maxOutputTokens).toBe(4096);
		expect(call.abortSignal).toBeInstanceOf(AbortSignal);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		expect(result.values).toEqual({
			title: "New title",
			content: [
				{
					...input.draft.fields.content[0],
					children: [
						{ ...input.draft.fields.content[0]!.children[0], text: "New body" },
					],
				},
			],
		});
		expect(input.draft.fields.title).toBe("Old title");
	});
	it.each([
		[{ id: "0", text: "A" }],
		[
			{ id: "0", text: "A" },
			{ id: "0", text: "B" },
		],
		[
			{ id: "0", text: "A" },
			{ id: "outside", text: "B" },
		],
	])(
		"rejects the entire proposal when segment identity changes",
		async (...segments) => {
			mocks.generate.mockResolvedValue({ object: { segments } });
			await expect(
				proposeCmsEditorDraft({}, "owner-org", input),
			).rejects.toThrow();
		},
	);
	it("rejects unsupported selected fields before inference", async () => {
		await expect(
			proposeCmsEditorDraft({}, "owner-org", {
				...input,
				draft: { ...input.draft, fields: { image: { id: "media" } } },
			}),
		).rejects.toThrow("text field");
		expect(mocks.generate).not.toHaveBeenCalled();
	});
	it("returns SEO suggestions without field patches", async () => {
		const seo = { title: "SEO title", description: "SEO description" };
		mocks.generate.mockResolvedValue({
			object: seo,
		});
		const result = await proposeCmsEditorDraft({}, "owner-org", {
			...input,
			action: "seo",
		});
		expect(result.values).toEqual({});
		expect(result.seo).toEqual(seo);
		expect(result).toMatchObject({
			invocationId: input.draft.invocationId,
			entryId: input.draft.entryId,
			locale: input.draft.locale,
			baseRevision: input.draft.baseRevision,
		});
		const call = mocks.generate.mock.calls[0]![0];
		expect(call.schema.parse(seo)).toEqual(seo);
		expect(call.schema.safeParse({}).success).toBe(false);
		expect(call.schema.safeParse({ title: "Only a title" }).success).toBe(
			false,
		);
		expect(
			call.schema.safeParse({ ...seo, title: "x".repeat(161) }).success,
		).toBe(false);
		expect(
			call.schema.safeParse({ ...seo, description: "x".repeat(321) }).success,
		).toBe(false);
		expect(call.schema.safeParse({ ...seo, segments: [] }).success).toBe(false);
		expect(call).not.toHaveProperty("tools");
		expect(call.maxRetries).toBe(0);
		expect(call.maxOutputTokens).toBe(4096);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		expect(input.draft.fields.title).toBe("Old title");
	});
	it("rejects a missing SEO result instead of returning an empty suggestion", async () => {
		mocks.generate.mockResolvedValue({ object: {} });
		await expect(
			proposeCmsEditorDraft({}, "owner-org", { ...input, action: "seo" }),
		).rejects.toThrow();
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});
	it("keeps translation on the strict segment transformation schema", async () => {
		const result = await proposeCmsEditorDraft({}, "owner-org", {
			...input,
			action: "translate",
			targetLocale: "de",
		});
		expect(result.values.title).toBe("New title");
		expect(result).not.toHaveProperty("seo");
		const call = mocks.generate.mock.calls[0]![0];
		expect(
			call.schema.safeParse({ title: "SEO title", description: "Description" })
				.success,
		).toBe(false);
		expect(JSON.parse(call.prompt)).toMatchObject({
			action: "translate",
			targetLocale: "de",
		});
		expect(call).not.toHaveProperty("tools");
		expect(call.maxRetries).toBe(0);
	});
	it("requires a target locale for translation", async () => {
		await expect(
			proposeCmsEditorDraft({}, "owner-org", { ...input, action: "translate" }),
		).rejects.toThrow("target locale");
		expect(mocks.generate).not.toHaveBeenCalled();
	});
	it("propagates denied inference without retrying", async () => {
		mocks.generate.mockRejectedValue(
			new Error("Inference blocked by billing policy"),
		);
		await expect(proposeCmsEditorDraft({}, "owner-org", input)).rejects.toThrow(
			"billing policy",
		);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});
	it("bounds input before inference", async () => {
		await expect(
			proposeCmsEditorDraft({}, "owner-org", {
				...input,
				draft: { ...input.draft, fields: { title: "x".repeat(50000) } },
			}),
		).rejects.toThrow("limit");
		expect(mocks.generate).not.toHaveBeenCalled();
	});
	it("rejects oversized model output without returning a partial proposal", async () => {
		mocks.generate.mockResolvedValue({
			object: {
				segments: [
					{ id: "0", text: "ä".repeat(20000) },
					{ id: "1", text: "ä".repeat(20000) },
				],
			},
		});
		await expect(proposeCmsEditorDraft({}, "owner-org", input)).rejects.toThrow(
			"output limit",
		);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
	});
});
