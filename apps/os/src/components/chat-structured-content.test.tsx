import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ChatMarkdown } from "./chat-markdown";
import { StructuredChatContent } from "./chat-structured-content";

const REQUEST_ID = "4f0c2a8e-1b7d-4c3e-9a51-0d6e2f8b7c10";
const ARGS = {
	kind: "sheet",
	title: "Opportunities - final format",
	content: { notes: "n".repeat(400), rows: [["Company", "Stage"]] },
};

function render(content: string): HTMLDivElement {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(
		<StructuredChatContent content={content} />,
	);
	return container;
}

describe("StructuredChatContent", () => {
	it("renders the approval request as a summary with folded arguments", () => {
		const container = render(
			[
				"Create sheet “Opportunities - final format”.",
				"Nothing has been executed. Reply “approve” or “yes” to proceed, or “reject” to cancel.",
				"### Details",
				"Tool: `os.create_os_output` on fern-labs",
				`Request: ${REQUEST_ID}`,
				`Arguments: ${JSON.stringify(ARGS)}`,
			].join("\n\n"),
		);
		expect(
			container.querySelector('[data-slot="chat-write-approval"] p')
				?.textContent,
		).toBe("Create sheet “Opportunities - final format”");
		const trigger = container.querySelector("button[aria-expanded]");
		expect(trigger?.textContent).toBe("Arguments· 3 fields");
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("### Details");
		expect(container.textContent).not.toContain('{"kind"');
		// Long values are folded until asked for.
		const code = container.querySelector('[data-slot="chat-json-code"]');
		expect(code?.textContent).toContain('"kind": "sheet"');
		expect(code?.textContent).toContain("(280 more characters)");
		expect(container.textContent).toContain("Show full values");
		const meta = container.querySelector('[data-slot="chat-tool-meta"]');
		expect(meta?.textContent).toContain("os.create_os_output");
		expect(meta?.textContent).toContain("fern-labs");
		expect(meta?.textContent).toContain(REQUEST_ID);
	});

	it("expands full values on request", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<StructuredChatContent
					content={`Here is the draft: ${JSON.stringify(ARGS)}`}
				/>,
			);
		});
		const toggle = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "Show full values",
		);
		expect(toggle).toBeDefined();
		await act(async () => {
			toggle!.click();
		});
		expect(
			host.querySelector('[data-slot="chat-json-code"]')?.textContent,
		).toContain("n".repeat(400));
		await act(async () => root.unmount());
		host.remove();
	});

	it("renders a failed write as one error line", () => {
		const container = render(
			'Approved write os.create_os_output on fern-labs failed: [{"type":"text","text":"Action \\"tedix__create_os_output\\" requires approval. No side effect was executed."}]',
		);
		const line = container.querySelector('[data-slot="chat-write-failure"] p');
		expect(line?.className).toContain("text-kumo-danger");
		expect(line?.textContent).toBe(
			'Couldn\'t create the output: Action "tedix__create_os_output" requires approval. No side effect was executed.',
		);
		expect(container.textContent).not.toContain('"type"');
	});

	it("leaves ordinary markdown untouched", () => {
		const content = "Two **invoices** need review:\n\n- F-241\n- F-242";
		expect(
			renderToStaticMarkup(<StructuredChatContent content={content} />),
		).toBe(renderToStaticMarkup(<ChatMarkdown content={content} />));
		const container = render(content);
		expect(container.querySelector("strong")?.textContent).toBe("invoices");
		expect(container.querySelectorAll("li")).toHaveLength(2);
		expect(container.querySelector("[data-slot]")).toBeNull();
	});
});
