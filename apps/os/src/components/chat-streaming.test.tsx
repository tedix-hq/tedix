import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	CHAT_PHASE_LABELS,
	phaseRowLabel,
	StreamedAssistantBubble,
	StreamedPhaseRow,
	StreamedRationaleRow,
} from "./chat-streaming";
import { CHAT_RUNTIME_PHASES } from "@tedix/chat-transport/runtime-frames";

describe("StreamedAssistantBubble", () => {
	it("matches the durable assistant treatment (left-aligned, bubble-free)", () => {
		const html = renderToStaticMarkup(
			<StreamedAssistantBubble text="Streaming an answer" />,
		);
		expect(html).toContain('data-role="assistant"');
		expect(html).toContain('data-slot="streaming-bubble"');
		expect(html).toContain("justify-start");
		// Assistant turns render bubble-free, straight on the canvas.
		expect(html).not.toContain("border-kumo-hairline");
		expect(html).not.toContain("bg-kumo-base");
		expect(html).not.toContain("whitespace-pre-wrap");
		expect(html).toContain("Streaming an answer");
	});

	it("shows the pulsing caret while streaming and marks itself busy", () => {
		const html = renderToStaticMarkup(
			<StreamedAssistantBubble text="partial" />,
		);
		expect(html).toContain('data-streaming="true"');
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('data-slot="streaming-caret"');
		// The caret animates on the OS motion contract, not Tailwind's stock 2s
		// `pulse` cycle, and drops to a solid bar under reduced motion.
		expect(html).toContain(
			"[animation-duration:var(--duration-tedix-structural)]",
		);
		expect(html).toContain(
			"[animation-timing-function:var(--ease-tedix-standard)]",
		);
		expect(html).toContain("motion-reduce:animate-none");
	});

	it("drops the caret once finalized so the durable swap is seamless", () => {
		const html = renderToStaticMarkup(
			<StreamedAssistantBubble text="full answer" done />,
		);
		expect(html).toContain('data-streaming="false"');
		expect(html).not.toContain("streaming-caret");
		expect(html).not.toContain('aria-busy="true"');
	});

	it("renders the in-flight text through the durable markdown component", () => {
		const html = renderToStaticMarkup(
			<StreamedAssistantBubble
				text={"Here is **bold** and a list:\n\n- one"}
			/>,
		);
		// Same renderer as the durable row, so the swap is not a reflow.
		expect(html).toContain("chat-markdown");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain('class="my-[0.2em]">one</li>');
		expect(html).not.toContain("**bold**");
	});

	it("keeps an unterminated fence rendering as an open block mid-stream", () => {
		const html = renderToStaticMarkup(
			<StreamedAssistantBubble text={'```json\n{ "a": 1 }'} />,
		);
		// A partial fence is legitimate markdown: it opens a code block that
		// fills in as the stream continues rather than dumping the backticks.
		expect(html).toContain("<pre");
		expect(html).not.toContain("```json");
	});

	it("escapes markup instead of rendering it", () => {
		const html = renderToStaticMarkup(
			<StreamedAssistantBubble text="<script>alert(1)</script>" />,
		);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});

describe("StreamedPhaseRow", () => {
	const since = Date.parse("2026-08-13T10:00:00.000Z");

	it("labels every phase in the cross-surface vocabulary", () => {
		for (const phase of CHAT_RUNTIME_PHASES) {
			expect(CHAT_PHASE_LABELS[phase]).toBeTruthy();
		}
	});

	it("reads as progress with whole elapsed seconds and a sanitized detail", () => {
		expect(
			phaseRowLabel(
				{ phase: "preparing_context", detail: null, since, sequence: 1 },
				since + 7_400,
			),
		).toBe("Preparing context · 7s");
		expect(
			phaseRowLabel(
				{ phase: "using_tool", detail: "gmail_send\u202e", since, sequence: 2 },
				since + 999,
			),
		).toBe("Using a tool: gmail_send · 0s");
		// A clock skewed before the phase start never renders negative time.
		expect(
			phaseRowLabel(
				{ phase: "planning", detail: null, since, sequence: 3 },
				since - 5_000,
			),
		).toBe("Planning · 0s");
	});

	it("takes the RunningIndicator slot: same loader, same live region", () => {
		const html = renderToStaticMarkup(
			<StreamedPhaseRow
				phase={{ phase: "delegating", detail: "CTO", since, sequence: 1 }}
				now={since + 3_000}
			/>,
		);
		expect(html).toContain('data-slot="streaming-phase"');
		expect(html).toContain('data-phase="delegating"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain("Delegating: CTO · 3s");
	});
});

describe("StreamedRationaleRow", () => {
	it("renders the provisional rationale, visually distinct from the answer", () => {
		const html = renderToStaticMarkup(
			<StreamedRationaleRow rationale="Delegating to the GitHub-owning tedi" />,
		);
		expect(html).toContain('data-slot="streaming-rationale"');
		expect(html).toContain('data-empty="false"');
		expect(html).toContain("Delegating to the GitHub-owning tedi");
		// Not the assistant treatment: muted + italic, one clamped line, and no
		// streaming caret that would read as "this is the answer".
		expect(html).toContain("italic");
		expect(html).toContain("text-kumo-subtle");
		expect(html).toContain("truncate");
		expect(html).not.toContain('data-slot="streaming-caret"');
	});

	it("is pre-spaced: the empty row still reserves its line", () => {
		const html = renderToStaticMarkup(<StreamedRationaleRow rationale="" />);
		expect(html).toContain('data-empty="true"');
		// The reserved line height is what keeps the thread from shifting when
		// the first rationale chunk lands.
		expect(html).toContain("min-h-5");
	});

	it("sanitizes untrusted runtime text", () => {
		const html = renderToStaticMarkup(
			<StreamedRationaleRow rationale="  routing‮  " />,
		);
		expect(html).not.toContain("‮");
		expect(html).toContain("routing");
	});
});
