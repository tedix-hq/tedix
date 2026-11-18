import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { ChatApproval } from "@/lib/workspace-chat-state";

const outputs = vi.hoisted(() => ({
	get: vi.fn(),
	archive: vi.fn(),
	history: vi.fn(),
	revise: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ osApi: { osWorkspaces: { outputs } } }));

import { ReplyApprovalActions } from "./workspace-chat-reply-actions";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	for (const fn of Object.values(outputs)) fn.mockReset();
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function applied(
	approvalId: string,
	title: string,
	outputId: string,
	revision: number,
): ChatApproval {
	return {
		approvalId,
		stepId: `s-${approvalId}`,
		title: revision === 1 ? "Creating a new output" : "Saving a sheet revision",
		reason: "Policy requires a person.",
		target: { id: outputId, title },
		decision: "approve",
		execution: { status: "applied", output: { outputId, revision } },
	} as ChatApproval;
}

function render(approvals: ChatApproval[]) {
	act(() =>
		root.render(
			<QueryClientProvider client={new QueryClient()}>
				<ReplyApprovalActions
					approvals={approvals}
					approvingAll={false}
					onApproveAll={() => {}}
				/>
			</QueryClientProvider>,
		),
	);
}

const button = (text: string) =>
	[...host.querySelectorAll("button")].find(
		(item) => item.textContent === text,
	);

async function settle() {
	for (let i = 0; i < 10; i++) await act(async () => {});
}

describe("Undo all from this reply", () => {
	it("archives created files and puts changed files back, newest first", async () => {
		outputs.get.mockImplementation(async ({ outputId }) => ({
			output: { id: outputId, status: "active" },
			currentRevision: {
				id: `${outputId}-current`,
				revision: outputId === "budget" ? 1 : 5,
			},
		}));
		outputs.history.mockResolvedValue({
			revisions: [{ revision: 4, content: { kind: "sheet", rows: [] } }],
		});
		outputs.archive.mockResolvedValue({});
		outputs.revise.mockResolvedValue({});
		render([
			applied("a1", "Budget", "budget", 1),
			applied("a2", "Plan", "plan", 5),
		]);
		act(() => button("Undo all from this reply")?.click());
		await settle();
		expect(outputs.archive).toHaveBeenCalledWith({ outputId: "budget" });
		expect(outputs.history).toHaveBeenCalledWith({
			outputId: "plan",
			revision: 4,
		});
		expect(outputs.revise).toHaveBeenCalledWith(
			expect.objectContaining({
				outputId: "plan",
				content: { kind: "sheet", rows: [] },
				expectedRevisionId: "plan-current",
			}),
		);
		expect(outputs.get.mock.calls.map(([input]) => input.outputId)).toEqual([
			"plan",
			"budget",
		]);
		expect(host.textContent).toContain("Undid 2 changes.");
		expect(button("Undo all from this reply")).toBeUndefined();
	});

	it("leaves a file alone when it changed again since", async () => {
		outputs.get.mockResolvedValue({
			output: { id: "plan", status: "active" },
			currentRevision: { id: "plan-7", revision: 7 },
		});
		render([applied("a2", "Plan", "plan", 5)]);
		act(() => button("Undo all from this reply")?.click());
		await settle();
		expect(outputs.revise).not.toHaveBeenCalled();
		expect(outputs.archive).not.toHaveBeenCalled();
		expect(host.textContent).toContain(
			"Undid 0 of 1 changes. Plan was not undone: it changed again since.",
		);
	});

	it("offers no undo while a proposal of the reply still waits", () => {
		const waiting = {
			...applied("a3", "Deck", "deck", 1),
			decision: null,
			execution: undefined,
		} as ChatApproval;
		render([applied("a1", "Budget", "budget", 1), waiting]);
		expect(button("Undo all from this reply")).toBeUndefined();
	});
});
