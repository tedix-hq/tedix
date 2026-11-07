import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({ dismissReminders: vi.fn() }));
vi.mock("@/lib/api", () => ({ osApi: { workInteractions: api } }));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: { workInteractions: { key: () => ["wi"] } },
}));
import { openCommitmentReminders } from "@/lib/commitment-reminders";
import { DeckReminders } from "./decision-deck-reminders";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Row = Parameters<typeof openCommitmentReminders>[0][number];
function row(
	id: string,
	requestedAt: string,
	options: {
		source?: string;
		disposition?: "accepted" | "completed" | "cancelled";
	} = {},
): Row {
	return {
		request: {
			id,
			requestedAt,
			subject: `Follow up: Work ${id}`,
			metadata: { source: options.source ?? "commitment_followup" },
		},
		effectiveState: "open",
		canRespond: true,
		canCancel: true,
		workItem: {
			id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
			title: `Work ${id}`,
			projectId: null,
			disposition: options.disposition ?? "accepted",
		},
		responseCount: 0,
	} as unknown as Row;
}

describe("openCommitmentReminders", () => {
	it("keeps only open reminders on live Work, newest first", () => {
		expect(
			openCommitmentReminders([
				row("1", "2026-11-05T08:00:00.000Z"),
				row("2", "2026-11-07T08:00:00.000Z"),
				row("3", "2026-11-06T08:00:00.000Z", { source: "decision" }),
				row("4", "2026-11-07T09:00:00.000Z", { disposition: "completed" }),
				row("5", "2026-11-06T08:00:00.000Z"),
			]).map((r) => r.request.id),
		).toEqual(["2", "5", "1"]);
	});
});

describe("DeckReminders", () => {
	let root: ReturnType<typeof createRoot> | undefined;
	let host: HTMLDivElement | undefined;
	afterEach(async () => {
		if (root) await act(async () => root!.unmount());
		host?.remove();
		api.dismissReminders.mockReset();
	});
	async function mount(rows: Row[]) {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false } },
		});
		await act(async () =>
			root!.render(
				<QueryClientProvider client={client}>
					<DeckReminders
						reminders={openCommitmentReminders(rows)}
						now={new Date("2026-11-07T12:00:00.000Z")}
					/>
				</QueryClientProvider>,
			),
		);
		return host;
	}

	it("renders nothing without reminders", async () => {
		expect((await mount([])).textContent).toBe("");
	});

	it("shows one collapsed row with the count and dismisses all at once", async () => {
		api.dismissReminders.mockResolvedValue({ dismissed: [] });
		const rows = Array.from({ length: 3 }, (_, i) =>
			row(String(i + 1), `2026-11-0${5 + i}T08:00:00.000Z`),
		);
		const view = await mount(rows);
		const trigger = [...view.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Reminders"),
		)!;
		expect(trigger.textContent).toContain("3");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		await act(async () => trigger.click());
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const titles = [...view.querySelectorAll("li a")].map((a) => a.textContent);
		expect(titles).toEqual(["Work 3", "Work 2", "Work 1"]);
		const dismiss = [...view.querySelectorAll("button")].find(
			(b) => b.textContent === "Dismiss all",
		)!;
		await act(async () => dismiss.click());
		expect(api.dismissReminders).toHaveBeenCalledWith({
			requestIds: ["3", "2", "1"],
		});
	});
});
