import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Alert, AlertDescription, AlertTitle } from "./alert";

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
