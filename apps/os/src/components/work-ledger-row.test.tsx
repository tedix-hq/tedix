import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { absoluteTime, relativeTime } from "@/lib/time";
import { LedgerRow, LedgerRowMeta, RelativeTime } from "./work-ledger-row";

const documentOf = (html: string) =>
	new DOMParser().parseFromString(html, "text/html");

describe("Work ledger", () => {
	it("keeps list hooks and places actions beside the title, metadata and hint", () => {
		const doc = documentOf(
			renderToStaticMarkup(
				<ul>
					<LedgerRow
						data-needs-you="Question"
						aria-label="Review request"
						className="office-knock-arrive"
						badge={<span>Question</span>}
						title={<a href="/work/items/example">Review the plan</a>}
						meta="From Nova"
						hint="Answer to continue"
						actions={<button>Answer</button>}
					/>
				</ul>,
			),
		);
		const row = doc.querySelector("li")!;
		expect(row.getAttribute("data-needs-you")).toBe("Question");
		expect(row.getAttribute("aria-label")).toBe("Review request");
		expect(row.className).toContain("office-knock-arrive");
		expect(row.className).toContain("px-4 py-3");
		expect([...row.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
			"QuestionReview the plan",
			"From Nova",
			"Answer to continue",
		]);
		expect(row.querySelector("a")?.getAttribute("href")).toBe(
			"/work/items/example",
		);
		expect(row.lastElementChild?.querySelector("button")?.textContent).toBe(
			"Answer",
		);
	});

	it("omits empty metadata, hints and actions", () => {
		const doc = documentOf(
			renderToStaticMarkup(
				<ul>
					<LedgerRow title="Plan" meta="" hint={null} />
				</ul>,
			),
		);
		expect(doc.querySelectorAll("p")).toHaveLength(1);
		expect(doc.querySelector("li")?.children).toHaveLength(1);
	});

	it("uses the shared relative and absolute timestamp formats with a supplied clock", () => {
		const at = "2026-10-20T10:00:00.000Z";
		const now = new Date("2026-10-20T11:00:00.000Z");
		const time = documentOf(
			renderToStaticMarkup(<RelativeTime at={at} now={now} />),
		).querySelector("time")!;
		expect(time.dateTime).toBe(at);
		expect(time.title).toBe(absoluteTime(at));
		expect(time.textContent).toBe(relativeTime(at, now));
	});

	it("pairs accessible metadata terms and values with decorative separators", () => {
		const doc = documentOf(
			renderToStaticMarkup(
				<LedgerRowMeta
					items={[
						{ term: "Owner", value: "Nova" },
						{ term: "Updated", value: <time>Today</time> },
					]}
				/>,
			),
		);
		expect([...doc.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(
			["Owner", "Updated"],
		);
		expect([...doc.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual(
			["Nova", "Today"],
		);
		expect(doc.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
	});
});
