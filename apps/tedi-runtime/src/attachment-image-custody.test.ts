import assert from "node:assert/strict";
import { runtimeFacetTurns } from "./runtime-facet-turns";

const pixel =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4S8AAAAASUVORK5CYII=";
const screenshot = [
	{
		type: "image" as const,
		fileName: "Screenshot.png",
		mimeType: "image/png",
		content: `data:image/png;base64,${pixel}`,
	},
];
function host(admitted: boolean) {
	return {
		env: { AZURE_CHAT_DEPLOYMENT: "gpt-6.1-sol" },
		state: { orgId: "org-1", tediId: "tedi-1" },
		runtimeAdmission: () => (admitted ? {} : null),
	} as unknown as ThisParameterType<
		typeof runtimeFacetTurns.resolveAttachmentTurn
	>;
}

// A tedi holding image custody shows the screenshot to the model.
const admitted = await runtimeFacetTurns.resolveAttachmentTurn.call(
	host(true),
	"fix the loading ui",
	screenshot,
);
assert.equal(admitted.images.length, 1);

// Without custody the delegated turn still runs and names the image.
const unadmitted = await runtimeFacetTurns.resolveAttachmentTurn.call(
	host(false),
	"fix the loading ui",
	screenshot,
);
assert.deepEqual(unadmitted.images, []);
assert.match(unadmitted.content, /fix the loading ui/);
assert.match(unadmitted.content, /Screenshot\.png/);

console.log("attachment-image-custody: ok");
