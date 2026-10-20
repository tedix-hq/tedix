import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	WorkEmpty,
	WorkListSkeleton,
	WorkPageHeader,
	WorkReadFailure,
} from "./work-surface-primitives";

describe("Work surface primitives", () => {
	it("sets and restores the Work document title", async () => {
		const previous = document.title;
		const host = document.createElement("div");
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(
					<WorkPageHeader
						title="Queue"
						description="Accepted work"
						action={<button>Refresh</button>}
					/>,
				),
			);
			expect(document.title).toBe("Queue · Work");
			expect(host.querySelector("h1")?.textContent).toBe("Queue");
			expect(host.textContent).toContain("Accepted work");
			expect(host.querySelector("button")?.textContent).toBe("Refresh");
		} finally {
			await act(async () => root.unmount());
		}
		expect(document.title).toBe(previous);
	});
	it("keeps the loading label and supports a caller's row count", () => {
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				<WorkListSkeleton rows={2} label="Loading contributors" />,
			),
			"text/html",
		);
		const loading = doc.querySelector('[aria-label="Loading contributors"]');
		expect(loading?.children.length).toBe(2);
		expect(
			[...loading!.children].every((row) => row.classList.contains("h-11")),
		).toBe(true);
		expect(
			renderToStaticMarkup(<WorkListSkeleton />).match(/data-slot="skeleton"/g),
		).toHaveLength(3);
	});
	it.each([
		[new Error("Read refused"), "Read refused"],
		[{ message: "Projection unavailable" }, "Projection unavailable"],
		[undefined, "The canonical read failed."],
		[
			{ message: "Malformed Orpc Error Response" },
			"The canonical read failed.",
		],
	])("renders a readable failure for %s", (error, message) => {
		const html = renderToStaticMarkup(
			<WorkReadFailure title="Queue unavailable" error={error} />,
		);
		expect(html).toContain("Queue unavailable");
		expect(html).toContain(message);
		expect(html).toContain('role="alert"');
	});
	it("preserves a caller's fallback and empty appearance", () => {
		expect(
			renderToStaticMarkup(
				<WorkReadFailure title="Unavailable" fallback="Retry once." />,
			),
		).toContain("Retry once.");
		const html = renderToStaticMarkup(
			<WorkEmpty
				title="No work"
				description={
					<>
						Create <code>Work</code>.
					</>
				}
				appearance="inline"
			/>,
		);
		expect(html).toContain('data-appearance="inline"');
		expect(html).toContain("No work");
		expect(html).toContain("<code>Work</code>");
		expect(
			renderToStaticMarkup(
				<WorkEmpty title="No work" description="Nothing queued." />,
			),
		).toContain('data-appearance="quiet"');
	});
});
