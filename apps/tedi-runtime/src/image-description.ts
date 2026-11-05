import type { TurnImagePart } from "@tedix/voice/stt";

/** Sends one JSON-mode vision request; the caller owns transport and billing. */
export type DescribeImagesCompletion = (input: {
	messages: Array<{ role: "system" | "user"; content: string }>;
	images: string[];
}) => Promise<string>;

const SYSTEM = [
	"You describe images for an assistant that cannot see them.",
	"For each image, in order, write a precise description of everything that",
	"matters for acting on it: visible text verbatim, layout, UI elements and",
	"their state (loading, empty, error, disabled), colors and anything that",
	'looks broken. Respond with JSON: {"images":[{"description":"..."}]}.',
].join(" ");

function imageUrl(image: TurnImagePart): string {
	return image.kind === "url"
		? image.data
		: `data:${image.mediaType};base64,${image.data}`;
}

function fallbackNote(images: TurnImagePart[]): string {
	const list = images
		.map((image) => `- ${image.fileName} (${image.mediaType})`)
		.join("\n");
	return `[Attachments received (not yet processed by this tedi):\n${list}]`;
}

/**
 * A tedi that cannot keep image bytes still learns what an attached image
 * shows: one vision request turns each image into a text description. Any
 * failure falls back to the file-name note, so the turn always runs.
 */
export async function describeTurnImages(
	images: TurnImagePart[],
	complete: DescribeImagesCompletion,
): Promise<string> {
	if (!images.length) return "";
	try {
		const raw = await complete({
			messages: [
				{ role: "system", content: SYSTEM },
				{
					role: "user",
					content: `Describe these ${images.length} image(s): ${images.map((image) => image.fileName).join(", ")}.`,
				},
			],
			images: images.map(imageUrl),
		});
		const parsed = JSON.parse(raw) as {
			images?: Array<{ description?: unknown }>;
		};
		const descriptions = images.map((image, index) => {
			const text = parsed.images?.[index]?.description;
			if (typeof text !== "string" || !text.trim())
				throw new Error(`no description for ${image.fileName}`);
			return `[Image "${image.fileName}" (described for you; you cannot view it directly): ${text.trim()}]`;
		});
		return descriptions.join("\n\n");
	} catch (error) {
		console.warn("[image-description] fell back to the file-name note", {
			reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
		});
		return fallbackNote(images);
	}
}
