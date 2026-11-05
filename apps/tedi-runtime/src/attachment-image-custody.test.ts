import assert from "node:assert/strict";
import { resolveTurnImageParts } from "@tedix/voice/stt";
import { describeTurnImages } from "./image-description";
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

// Without custody the delegated turn still runs and names the image, even
// when the description request cannot be made.
const unadmitted = await runtimeFacetTurns.resolveAttachmentTurn.call(
	host(false),
	"fix the loading ui",
	screenshot,
);
assert.deepEqual(unadmitted.images, []);
assert.match(unadmitted.content, /fix the loading ui/);
assert.match(unadmitted.content, /Screenshot\.png/);

// The description request is billed to the turn's own run; a run-less call is
// refused by a per-run budget.
const correlations: unknown[] = [];
await runtimeFacetTurns.resolveAttachmentTurn.call(
	{
		...host(false),
		observerBeforeDispatch: () => () => {},
		tediAigMetadata: (_source: string, turn: unknown) => {
			correlations.push(turn);
			return {};
		},
	} as unknown as ThisParameterType<
		typeof runtimeFacetTurns.resolveAttachmentTurn
	>,
	"fix the loading ui",
	screenshot,
	{ runId: "run-1", sessionKey: "session-1" },
);
assert.deepEqual(correlations, [{ runId: "run-1", sessionKey: "session-1" }]);

// The vision request carries the image itself and its answer becomes text.
const [image] = resolveTurnImageParts(screenshot).images;
let sent: string[] = [];
const described = await describeTurnImages([image!], async ({ images }) => {
	sent = images;
	return JSON.stringify({
		images: [{ description: "A spinner overlaps the card titles." }],
	});
});
assert.equal(sent.length, 1);
assert.match(sent[0]!, /^data:image\/png;base64,/);
assert.match(described, /Screenshot\.png/);
assert.match(described, /spinner overlaps the card titles/);

// A malformed answer falls back to the file-name note.
const fellBack = await describeTurnImages([image!], async () => "not json");
assert.match(fellBack, /Attachments received/);
assert.match(fellBack, /Screenshot\.png/);

console.log("attachment-image-custody: ok");
