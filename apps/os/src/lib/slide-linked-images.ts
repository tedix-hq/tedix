import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	slideBackgroundMarkup,
	slideElementMarkup,
	type PresentationAppearance,
} from "@tedix/api-contract/utils/presentation-style";

/** One transparent pixel: what a linked image shows until its embedded copy arrives. */
const BLANK =
	"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

const isLink = (source: string | null | undefined): source is string =>
	!!source && /^https:\/\//i.test(source);

/**
 * Puts slide markup on screen where the browser may not load web images. A
 * linked image is drawn from an embedded copy that `read` fetches once per
 * link; until it arrives the image is blank, and if it cannot be read the
 * image is marked `data-linked-state="failed"`. Only the markup changes: the
 * slide, element and appearance passed in keep their links.
 */
export function createSlideLinkedImages(
	root: ParentNode,
	read: (url: string) => Promise<string>,
) {
	const embedded = new Map<string, string>();
	const waiting = new Map<string, "loading" | "failed">();
	const shown = (link: string) => embedded.get(link) ?? BLANK;
	const images = (link: string) =>
		[
			...root.querySelectorAll<HTMLImageElement>("img[data-linked-image]"),
		].filter((image) => image.dataset.linkedImage === link);

	function request(link: string) {
		if (embedded.has(link) || waiting.get(link) === "loading") return;
		waiting.set(link, "loading");
		for (const image of images(link)) image.dataset.linkedState = "loading";
		void read(link)
			.then((source) => {
				if (!/^data:image\//i.test(source)) throw new Error("Not an image");
				embedded.set(link, source);
				waiting.delete(link);
				for (const image of images(link)) {
					image.src = source;
					delete image.dataset.linkedState;
				}
			})
			.catch(() => {
				waiting.set(link, "failed");
				for (const image of images(link)) image.dataset.linkedState = "failed";
			});
	}
	function track(node: HTMLElement, link: string | null | undefined) {
		const image = node.querySelector<HTMLImageElement>(":scope > img");
		if (!image || !isLink(link)) return;
		image.dataset.linkedImage = link;
		if (embedded.has(link)) return;
		// A link that failed stays failed until `retry`.
		if (!waiting.has(link)) request(link);
		image.dataset.linkedState = waiting.get(link) ?? "loading";
	}

	return {
		/** Draw one element's content into its node. */
		element(
			node: HTMLElement,
			element: OsPresentationElement,
			appearance?: PresentationAppearance,
		) {
			const logo = appearance?.logoUrl;
			node.innerHTML = slideElementMarkup(
				isLink(element.src) ? { ...element, src: shown(element.src) } : element,
				"canvas",
				isLink(logo) ? { ...appearance, logoUrl: shown(logo) } : appearance,
			);
			track(
				node,
				element.type === "logo"
					? logo
					: element.type === "image" || element.type === "svg"
						? element.src
						: undefined,
			);
		},
		/** Draw a slide's background layers into their node. */
		background(
			node: HTMLElement,
			slide: OsPresentationCanvasSlide,
			appearance?: PresentationAppearance,
		) {
			const link = slide.backgroundImage;
			node.innerHTML = slideBackgroundMarkup(
				isLink(link) ? { ...slide, backgroundImage: shown(link) } : slide,
				"canvas",
				appearance,
			);
			track(node, link);
		},
		/** Ask again for the failed links still on screen. */
		retry() {
			for (const [link, state] of waiting) {
				if (state !== "failed") continue;
				waiting.delete(link);
				if (images(link).length) request(link);
			}
		},
	};
}
