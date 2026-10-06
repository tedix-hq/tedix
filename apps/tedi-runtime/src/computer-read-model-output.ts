import { createReadTool, type FileStore } from "@cloudflare/computer/tools";

const noStorage = (): never => {
	throw new Error(
		"Computer read model projection must use captured output bytes",
	);
};

// The SDK captures media in execute(). Its exported projection needs no live
// filesystem, so it also works after a facet restart or parent registry loss.
// Fail closed if a future SDK starts reading storage during model assembly.
const store: FileStore = {
	stat: noStorage,
	readChunks: noStorage,
	readAll: noStorage,
	write: noStorage,
};
const projectRead = createReadTool({ store }).toModelOutput!;
export function computerReadToolModelOutput(options: {
	toolCallId: string;
	input: unknown;
	output: unknown;
}) {
	return projectRead({
		...options,
		input: options.input as Parameters<typeof projectRead>[0]["input"],
	});
}
