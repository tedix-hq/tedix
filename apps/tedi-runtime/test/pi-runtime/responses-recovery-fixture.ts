import { createAzure } from "@ai-sdk/azure";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
/** Scripted native Responses SSE, consumed by the installed Azure SDK. */
export function responsesFixtureStream(call: number): Response {
	const reasoning = {
		type: "reasoning",
		id: "rs-fixture",
		summary: [],
		encrypted_content: "opaque-fixture-reasoning",
	};
	const tool = {
		type: "function_call",
		status: "completed",
		id: "fc-fixture",
		call_id: "receipt-1",
		name: "receipt",
		arguments: "{}",
	};
	const message = {
		type: "message",
		id: `msg-${call}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "completed", annotations: [] }],
	};
	const response = {
		id: `resp-${call}`,
		object: "response",
		created_at: 1,
		model: "gpt-5.6-terra",
		status: "completed",
		output: call === 1 ? [reasoning, tool] : [message],
		usage: {
			input_tokens: call === 1 ? 80 : 30,
			output_tokens: 20,
			total_tokens: call === 1 ? 100 : 50,
			output_tokens_details: { reasoning_tokens: 10 },
		},
	};
	const events: unknown[] = [
		{
			type: "response.created",
			response: { ...response, status: "in_progress", output: [] },
		},
	];
	if (call === 1)
		events.push(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { ...reasoning, encrypted_content: null },
			},
			{ type: "response.output_item.done", output_index: 0, item: reasoning },
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { ...tool, arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: tool.id,
				output_index: 1,
				delta: "{}",
			},
			{
				type: "response.function_call_arguments.done",
				item_id: tool.id,
				output_index: 1,
				arguments: "{}",
			},
			{ type: "response.output_item.done", output_index: 1, item: tool },
		);
	else
		events.push(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { ...message, content: [] },
			},
			{
				type: "response.output_text.delta",
				item_id: message.id,
				output_index: 0,
				content_index: 0,
				delta: "completed",
			},
			{ type: "response.output_item.done", output_index: 0, item: message },
		);
	events.push({ type: "response.completed", response });
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

/** Native Pi replay uses the real provider SDK with a scripted provider transport.
 * Production Gateway admission/serialization is covered by model-generation.test.
 */
export function responsesFixtureModel(
	observe: (body: Record<string, unknown>) => Promise<number>,
) {
	const provider = createAzure({
		resourceName: "test-resource",
		apiKey: "fixture-only",
		fetch: async (_input, init) =>
			responsesFixtureStream(await observe(JSON.parse(String(init?.body)))),
	});
	return wrapLanguageModel({
		model: provider.responses("gpt-5.6-terra"),
		middleware: defaultSettingsMiddleware({
			settings: {
				providerOptions: {
					azure: { store: false, include: ["reasoning.encrypted_content"] },
				},
			},
		}),
	});
}
