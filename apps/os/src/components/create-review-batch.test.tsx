import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CreateReviewBatch } from "./create-review-batch";

describe("CreateReviewBatch", () => {
	afterEach(() => document.body.replaceChildren());

	it("names each source selector with its visible label", () => {
		const host = document.createElement("div");
		document.body.append(host);
		host.innerHTML = renderToStaticMarkup(
			<>
				<CreateReviewBatch shareId="share-a" gadgetId="gadget-a" />
				<CreateReviewBatch shareId="share-b" gadgetId="gadget-b" />
			</>,
		);
		const labels = Array.from(host.querySelectorAll("label")).filter((label) =>
			label.textContent?.trim().startsWith("Source document"),
		);
		expect(labels).toHaveLength(2);
		const ids = labels.map((label) => {
			const selector = label.control;
			expect(selector).not.toBeNull();
			expect(selector?.getAttribute("role")).toBe("combobox");
			expect(selector?.getAttribute("aria-label")).toBeNull();
			expect(selector?.getAttribute("aria-labelledby")).toBeNull();
			expect(label.textContent?.trim()).toBe("Source documentChoose a source");
			return selector?.id;
		});
		expect(new Set(ids).size).toBe(2);
	});
});
