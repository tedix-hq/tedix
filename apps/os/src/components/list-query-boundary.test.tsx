import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ListQueryBoundary } from "./list-query-boundary";

function query(overrides = {}) {
	return {
		isPending: false,
		isError: false,
		isFetching: false,
		error: null,
		refetch: vi.fn().mockResolvedValue({}),
		...overrides,
	};
}

describe("operational list read boundary", () => {
	it("shows loading rows without an unavailable alert", () => {
		const html = renderToStaticMarkup(
			<ListQueryBoundary
				query={query({ isPending: true })}
				errorTitle="Apps are unavailable"
				rows={2}
			/>,
		);
		expect(html.match(/data-slot="skeleton"/g)).toHaveLength(2);
		expect(html).not.toContain("unavailable");
	});
	it.each([null, {}, "Malformed Orpc Error Response"])(
		"handles an unknown error %j without inventing an empty list",
		(error) => {
			const html = renderToStaticMarkup(
				<ListQueryBoundary
					query={query({ isError: true, error })}
					errorTitle="Skills are unavailable"
				/>,
			);
			expect(html).toContain("The list could not be read.");
			expect(html).toContain("Try again");
			expect(html).not.toContain("No skills");
		},
	);
	it("keeps cached rows visible and retries only after the user clicks", async () => {
		const state = query({ isError: true, error: new Error("Read failed") });
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<>
						<ListQueryBoundary
							query={state}
							errorTitle="Apps are unavailable"
						/>
						<p>Cached app</p>
					</>,
				),
			);
			expect(container.textContent).toContain("Cached app");
			expect(state.refetch).not.toHaveBeenCalled();
			await act(async () => container.querySelector("button")!.click());
			expect(state.refetch).toHaveBeenCalledOnce();
			await act(async () =>
				root.render(
					<ListQueryBoundary
						query={{ ...state, isFetching: true }}
						errorTitle="Apps are unavailable"
					/>,
				),
			);
			expect(container.querySelector("button")!.disabled).toBe(true);
			expect(container.textContent).toContain("Trying again");
		} finally {
			await act(async () => root.unmount());
		}
	});
	it("renders no boundary for a successful read", () => {
		expect(
			renderToStaticMarkup(
				<ListQueryBoundary query={query()} errorTitle="Apps are unavailable" />,
			),
		).toBe("");
	});
});
