import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { Alert, AlertDescription, AlertTitle, LoadError } from "./alert";

describe("Kumo Alert adapter", () => {
	// Kumo's Banner does `isValidElement(children) ? children : <p>{children}</p>`,
	// and an ARRAY of children is not a valid element. The title+description
	// anatomy every Tedix alert uses was landing inside a `<p>` — invalid HTML
	// and a React nesting error — so the slots must render as direct children.
	it("announces destructive errors and keeps the title/description anatomy out of a paragraph", () => {
		const destructive = renderToStaticMarkup(
			<Alert variant="destructive">
				<AlertTitle>Review required</AlertTitle>
				<AlertDescription>Something failed</AlertDescription>
			</Alert>,
		);
		expect(destructive).toContain('data-variant="destructive"');
		expect(destructive).toContain('role="alert"');
		expect(destructive).toContain('data-slot="alert-title"');
		expect(destructive).toContain('data-slot="alert-description"');
		expect(destructive).not.toMatch(
			/<p[^>]*>\s*<div[^>]*data-slot="alert-title"/,
		);

		const neutral = renderToStaticMarkup(
			<Alert>
				<AlertDescription>Helpful context</AlertDescription>
			</Alert>,
		);
		expect(neutral).toContain('data-variant="default"');
		expect(neutral).not.toContain('role="alert"');
	});
});

describe("load errors", () => {
	it("keeps server diagnostics in a closed disclosure and maps known errors", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			<LoadError
				title="Accounts could not be loaded"
				error={{
					code: "SERVICE_UNAVAILABLE",
					message: "Database temporarily unavailable; retry shortly",
					data: { traceId: "fictional-trace" },
				}}
				onRetry={() => {}}
			/>,
		);
		expect(
			host.querySelector('[data-slot="load-error-help"]')?.textContent,
		).toBe("This is taking longer than usual. Try again in a moment.");
		const trigger = host.querySelector('[data-kumo-part="default-trigger"]');
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		const details = host.querySelector("[hidden]");
		expect(details?.textContent).toContain("Database temporarily unavailable");
		expect(details?.textContent).toContain("Trace ID: fictional-trace");
		const retry = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry",
		);
		expect(retry?.type).toBe("button");
	});

	it.each(["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"])(
		"keeps access guidance and permits an explicit read refresh for %s",
		(code) => {
			const host = document.createElement("div");
			host.innerHTML = renderToStaticMarkup(
				<LoadError error={{ code }} onRetry={() => {}} />,
			);
			expect(host.querySelector("button")?.textContent).toBe("Retry");
			expect(
				host.querySelector('[data-kumo-part="default-trigger"]'),
			).toBeNull();
		},
	);

	it("retries only on click and disables the action while reading", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const retry = vi.fn();
		try {
			await act(async () => root.render(<LoadError onRetry={retry} />));
			expect(retry).not.toHaveBeenCalled();
			await act(async () => host.querySelector("button")?.click());
			expect(retry).toHaveBeenCalledTimes(1);
			await act(async () =>
				root.render(<LoadError onRetry={retry} retrying />),
			);
			expect(host.querySelector("button")?.disabled).toBe(true);
			await act(async () => host.querySelector("button")?.click());
			expect(retry).toHaveBeenCalledTimes(1);
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
