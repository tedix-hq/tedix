import { MockLanguageModelV3 } from "ai/test";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { describe, expect, it, vi } from "vite-plus/test";
import { planDocumentCreate } from "./document-create-plan";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function model(blocks: unknown) {
	return new MockLanguageModelV3({
		doGenerate: async () => ({
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
			content: [{ type: "text", text: JSON.stringify({ blocks }) }],
		}),
	});
}

describe("document body generation", () => {
	it("honors the selected model's configured reasoning effort", async () => {
		const base = model([{ type: "paragraph", text: "Welcome." }]);
		const configured = wrapLanguageModel({
			model: base,
			middleware: defaultSettingsMiddleware({
				settings: { providerOptions: { azure: { reasoningEffort: "none" } } },
			}),
		});
		await planDocumentCreate({
			content:
				'Create a document titled "Welcome" with a short welcome paragraph.',
			toolName: "os.create_os_output",
			model: configured,
			abortSignal: new AbortController().signal,
		});
		expect(base.doGenerateCalls[0]?.providerOptions?.azure).toMatchObject({
			reasoningEffort: "none",
			strictJsonSchema: false,
		});
	});

	it.each(["workspaceId", "workspace", "workspace id"])(
		"fixes metadata from the request and generates only semantic blocks (%s)",
		async (marker) => {
			const blocks = [{ type: "paragraph", text: "Welcome to our shop." }];
			const draftModel = model(blocks);
			const generate = vi.spyOn(draftModel, "doGenerate");
			const draft = await planDocumentCreate({
				content: `Create a short OS document titled "Shop welcome" welcoming visitors. Use ${marker} ${workspaceId}.`,
				toolName: "os.create_os_output",
				model: draftModel,
				abortSignal: new AbortController().signal,
			});
			expect(draft?.args).toEqual({
				kind: "document",
				title: "Shop welcome",
				workspaceId,
				content: { kind: "document", blocks },
			});
			const schema = JSON.stringify(generate.mock.calls[0]![0].responseFormat);
			expect(schema).toContain("paragraph");
			expect(schema).not.toContain("toolName");
			expect(schema).not.toContain("richText");
		},
	);

	it.each([
		"Create a document welcoming visitors.",
		'Create a document titled "One" and another titled "Two".',
		'Create a Google document titled "Welcome".',
		'Append a paragraph to the document titled "Welcome".',
	])("leaves unsupported requests to the full planner: %s", async (content) => {
		const draftModel = model([]);
		const generate = vi.spyOn(draftModel, "doGenerate");
		expect(
			await planDocumentCreate({
				content,
				toolName: "os.create_os_output",
				model: draftModel,
				abortSignal: new AbortController().signal,
			}),
		).toBeUndefined();
		expect(generate).not.toHaveBeenCalled();
	});

	it("keeps a drafting refusal as a declined write", async () => {
		expect(
			await planDocumentCreate({
				content:
					'Create a document titled "Welcome" and send it to a customer.',
				toolName: "os.create_os_output",
				model: model(null),
				abortSignal: new AbortController().signal,
			}),
		).toBeNull();
	});

	it("does not silently replace a conflicting selected workspace", async () => {
		const draftModel = model([]);
		const generate = vi.spyOn(draftModel, "doGenerate");
		expect(
			await planDocumentCreate({
				content: `Create a document titled "Welcome" in workspaceId ${workspaceId}.`,
				toolName: "os.create_os_output",
				workspaceId: "22222222-2222-4222-8222-222222222222",
				model: draftModel,
				abortSignal: new AbortController().signal,
			}),
		).toBeUndefined();
		expect(generate).not.toHaveBeenCalled();
	});
});
