import { expect, it } from "vite-plus/test";
import { dynamicTool, jsonSchema } from "ai";
import { computerReadToolModelOutput } from "../../src/computer-read-model-output";
import { describeFacetTools } from "../../src/facet-tool-descriptors";

it.each(["image/png", "application/pdf"])(
	"preserves captured %s bytes through serialized facet descriptors",
	async (mediaType) => {
		const definition = dynamicTool({
			inputSchema: jsonSchema({ type: "object" }),
			toModelOutput: computerReadToolModelOutput,
		});
		const [descriptor] = JSON.parse(
			JSON.stringify(describeFacetTools({ read: definition })),
		);
		expect(descriptor.computerReadOutput).toBe(true);
		const output = {
			kind: mediaType.startsWith("image/") ? "image" : "file",
			path: "/workspace/image",
			name: "image",
			mediaType,
			sizeBytes: 4,
			data: "AQIDBA==",
		};
		const model = await computerReadToolModelOutput({
			toolCallId: "read",
			input: { path: output.path },
			output,
		});
		expect(model).toMatchObject({
			type: "content",
			value: expect.arrayContaining([
				expect.objectContaining({
					type: "file",
					mediaType,
					data: { type: "data", data: "AQIDBA==" },
				}),
			]),
		});
	},
);

it("retains the SDK media bound and positioned-text continuation metadata", async () => {
	const large = await computerReadToolModelOutput({
		toolCallId: "read",
		input: { path: "/big.png" },
		output: {
			kind: "image",
			path: "/big.png",
			name: "big.png",
			mediaType: "image/png",
			sizeBytes: 4 * 1024 * 1024,
			data: "AA==",
		},
	});
	expect(large.type).toBe("error-text");
	const text = { content: "next line", truncated: false, nextByteOffset: 250 };
	expect(
		await computerReadToolModelOutput({
			toolCallId: "read",
			input: { path: "/file", offset: 3, byteOffset: 200 },
			output: text,
		}),
	).toEqual({ type: "json", value: text });
});
