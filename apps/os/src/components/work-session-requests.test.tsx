import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { osApi } from "@/lib/api";
import {
	SessionRequestsSection,
	type SessionRequest,
} from "./work-session-requests";

vi.mock("@/lib/api", () => ({
	osApi: { workAgentSessions: { updateRequest: vi.fn() } },
}));

const row: SessionRequest = {
	id: "11111111-1111-4111-8111-111111111111",
	harness: "codex",
	sessionKey: "example",
	repository: "demo",
	kind: "request",
	text: "Review the project plan",
	status: "waiting_on_user",
	evidence: "Draft ready",
	sourceAt: "2026-10-20T10:00:00.000Z",
	statusChangedAt: "2026-10-20T10:00:00.000Z",
};
const client = () =>
	new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("Your requests ledger", () => {
	it("preserves row status, copy, timestamps and actions", () => {
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={client()}>
					<SessionRequestsSection rows={[row]} />
				</QueryClientProvider>,
			),
			"text/html",
		);
		const item = doc.querySelector(
			'[aria-label="Your requests"] [data-request-status="waiting_on_user"]',
		)!;
		expect(item.textContent).toContain(row.text);
		expect(item.textContent).toContain("Codex · demo");
		expect(item.textContent).toContain(row.evidence);
		expect(item.querySelector("time")?.dateTime).toBe(row.sourceAt);
		expect(
			[...item.querySelectorAll("button")].map((button) => button.textContent),
		).toEqual(["Done", "Withdraw"]);
	});
	it("uses an inline empty state with the existing explanation", () => {
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client()}>
				<SessionRequestsSection rows={[]} />
			</QueryClientProvider>,
		);
		expect(html).toContain('data-appearance="inline"');
		expect(html).toContain(
			"No requests yet. They appear here once the Tedix plugin records your messages (decision capture on).",
		);
	});
	it("keeps Done connected to the existing mutation", async () => {
		const update = vi
			.mocked(osApi.workAgentSessions.updateRequest)
			.mockResolvedValue({ request: { ...row, status: "done" } });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client()}>
						<SessionRequestsSection rows={[row]} />
					</QueryClientProvider>,
				),
			);
			await act(async () =>
				[...container.querySelectorAll("button")]
					.find((button) => button.textContent === "Done")!
					.click(),
			);
			expect(update).toHaveBeenCalledWith({
				id: row.id,
				status: "done",
				evidence: "Marked done by you in Tedix OS.",
			});
		} finally {
			await act(async () => root.unmount());
			container.remove();
			update.mockReset();
		}
	});
});
