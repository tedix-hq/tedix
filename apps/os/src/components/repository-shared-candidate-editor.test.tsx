import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { UseCollabDocResult } from "@/lib/use-collab-doc";
const h = vi.hoisted(() => ({
	read: vi.fn(),
	input: vi.fn(),
	room: {} as UseCollabDocResult,
}));
vi.mock("@/lib/os-query-options", () => ({
	repositoryCandidateQueryOptions: (id: string, attemptId: string) => ({
		queryKey: ["candidate-editor-test", id, attemptId],
		queryFn: () => h.read(id, attemptId),
	}),
}));
vi.mock("@/lib/use-collab-doc", () => ({
	useCollabDoc: (input: unknown) => {
		h.input(input);
		return h.room;
	},
}));
vi.mock("@/components/canvas-editor", () => ({
	CanvasCodeEditor: ({
		path,
		readOnly,
	}: {
		path: string;
		readOnly: boolean;
	}) => (
		<div data-code-path={path} data-read-only={readOnly}>
			Code editor
		</div>
	),
}));
import { RepositorySharedCandidate } from "./repository-shared-candidate-editor";
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const workItemId = "11111111-1111-4111-8111-111111111111",
	attemptId = "22222222-2222-4222-8222-222222222222",
	base = "a".repeat(40);
const result = {
	descriptor: {
		version: 1,
		organizationId: "org-example",
		workItemId,
		attemptId,
		admissionId: "33333333-3333-4333-8333-333333333333",
		repositoryId: "example",
		repositoryName: "work-example",
		baseRevision: base,
		files: [
			{ path: "client.js", blobRevision: base, bytes: 6 },
			{ path: "server.js", blobRevision: base, bytes: 6 },
		],
		selectionDigest: "b".repeat(64),
		roomName: "server-derived",
		docKey: "repo-candidate:server-derived",
		createdAt: "2026-11-03T00:00:00.000Z",
	},
	state: {
		snapshot: {
			position: { generation: 0, revision: 0 },
			canonical: { revision: 0, revisionId: base },
			files: { "client.js": "client", "server.js": "server" },
		},
		contentDigest: "c".repeat(64),
		sealed: false,
		seal: null,
	},
	writtenToRepository: false,
};
let host: HTMLDivElement,
	root: ReturnType<typeof createRoot>,
	client: QueryClient;
function render(active = true) {
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<RepositorySharedCandidate
					workItemId={workItemId}
					attemptId={attemptId}
					active={active}
				/>
			</QueryClientProvider>,
		),
	);
}
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}
async function click(text: string) {
	await act(async () =>
		[...host.querySelectorAll("button")]
			.find((button) => button.textContent === text)!
			.click(),
	);
	await flush();
	await flush();
}
beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	h.read.mockReset().mockResolvedValue(result);
	h.input.mockReset();
	h.room = {
		session: {
			text: (path: string) => path,
			applyLocal: vi.fn(),
			onRemote: () => () => {},
			blocked: () => null,
		},
		status: "connected",
		peers: 2,
		recoveryRequired: false,
		recoverableFiles: null,
		clearRecoverableFiles: vi.fn(),
		retry: vi.fn(),
	} as unknown as UseCollabDocResult;
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	client.clear();
});
it("opens only the existing executor candidate and switches files in the same Work-scoped session", async () => {
	render();
	expect(h.read).not.toHaveBeenCalled();
	await click("Open shared code candidate");
	expect(h.read).toHaveBeenCalledWith(workItemId, attemptId);
	expect(h.input).toHaveBeenLastCalledWith({
		workItemId,
		docKey: result.descriptor.docKey,
		enabled: true,
		paused: false,
		canonical: {
			text: "",
			files: result.state.snapshot.files,
			revision: 0,
			revisionId: base,
		},
	});
	expect(
		host.querySelector("[data-code-path]")?.getAttribute("data-code-path"),
	).toBe("client.js");
	await click("server.js");
	expect(
		host.querySelector("[data-code-path]")?.getAttribute("data-code-path"),
	).toBe("server.js");
	expect(host.textContent).toContain("have not been written to the repository");
	expect(
		[...host.querySelectorAll("button")].some((button) =>
			/save|apply|initialize|publish/i.test(button.textContent ?? ""),
		),
	).toBe(false);
});
it("explains missing initialization without acquiring another writer", async () => {
	h.read.mockRejectedValue(
		new Error(
			"Current executor has not initialized a shared repository candidate",
		),
	);
	render();
	await click("Open shared code candidate");
	expect(host.textContent).toContain("current executor");
	expect(h.input).not.toHaveBeenCalled();
});
it("keeps an ended session mounted and read-only so its text can be copied", async () => {
	render();
	await click("Open shared code candidate");
	const session = h.room.session;
	render(false);
	expect(h.room.session).toBe(session);
	expect(
		host.querySelector("[data-read-only]")?.getAttribute("data-read-only"),
	).toBe("true");
	expect(host.textContent).toContain("Keep a copy");
	expect(h.input.mock.calls.at(-1)?.[0]).toMatchObject({ paused: true });
	expect(host.textContent).not.toContain("Reconnect shared candidate");
});
it("pauses an already sealed candidate and offers no reconnect control", async () => {
	h.read.mockResolvedValue({
		...result,
		state: { ...result.state, sealed: true },
	});
	render();
	await click("Open shared code candidate");
	expect(h.input.mock.calls.at(-1)?.[0]).toMatchObject({ paused: true });
	expect(host.textContent).toContain("Candidate sealed");
	expect(host.textContent).not.toContain("Reconnect shared candidate");
});

it("retains unsynced full file-map recovery and blocks editing until the copy is reviewed", async () => {
	h.room.recoverableFiles = {
		"client.js": "retained local edit",
		"server.js": "another local edit",
	};
	render();
	await click("Open shared code candidate");
	expect(
		(host.querySelector("textarea") as HTMLTextAreaElement).value,
	).toContain("retained local edit");
	expect(
		(host.querySelector("textarea") as HTMLTextAreaElement).value,
	).toContain("another local edit");
	expect(
		host.querySelector("[data-read-only]")?.getAttribute("data-read-only"),
	).toBe("true");
	await click("I have reviewed my copy; use shared code");
	expect(h.room.clearRecoverableFiles).toHaveBeenCalledOnce();
});
