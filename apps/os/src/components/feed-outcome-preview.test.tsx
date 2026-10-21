import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { ResolvedWorkEvidenceSchema } from "@tedix/api-contract/schemas/work-items";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const api = vi.hoisted(() => ({
	listEvidence: vi.fn(),
	previewEvidence: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ osApi: { workItems: api } }));
import {
	osQuery,
	workEvidencePreviewQueryOptions,
} from "@/lib/os-query-options";
import { FeedOutcomePreview } from "./feed-outcome-preview";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workId = "11111111-1111-4111-8111-111111111111";
const evidenceId = "22222222-2222-4222-8222-222222222222";
const source = `/work/items/${workId}`;
const dataUrl = "data:image/png;base64,aGVsbG8=";
const available = {
	status: "available",
	canonicalUri: "artifact://pine/chart",
	mediaType: "image/png",
	digest: "sha256:pine",
	text: "",
	imageDataUrl: dataUrl,
	truncated: false,
};
const imageRow = ResolvedWorkEvidenceSchema.parse({
	id: evidenceId,
	orgId: workId,
	workItemId: workId,
	attemptId: null,
	claimKey: "chart",
	kind: "artifact",
	uri: "artifact://pine/chart",
	digest: null,
	mediaType: "image/png",
	label: null,
	disposition: "accepted",
	submittedByType: "user",
	submittedById: "pine-user",
	submittedBySessionId: null,
	submittedAt: "2026-10-21T09:00:00Z",
	reviewedByType: null,
	reviewedById: null,
	reviewedBySessionId: null,
	reviewedAt: null,
	reviewReason: null,
	version: 1,
	metadata: {},
	reference: {
		kind: "artifact",
		status: "available",
		canonicalUri: "artifact://pine/chart",
		artifactId: "pine-chart",
		digest: "sha256:pine",
		mediaType: "image/png",
		reason: null,
		bundleDigestKind: "bytes",
	},
});
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
	api.listEvidence
		.mockReset()
		.mockResolvedValue({ data: [], nextCursor: null });
	api.previewEvidence.mockReset().mockResolvedValue(available);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	host.remove();
});
async function mount(withTitle = true, overrides = {}) {
	const item = ActivityFeedItemSchema.parse({
		id: "pine-result",
		actor: "Pine worker",
		sentence: "The chart is ready.",
		source,
		projectId: null,
		tediId: null,
		workItemId: workId,
		kind: "result",
		classId: "result",
		importance: "normal",
		at: "2026-10-21T09:00:00Z",
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: true,
		explanation: "Completed chart",
		reactions: [],
		...(withTitle
			? {
					attachment: {
						title: "Delivery chart",
						summary: "Delivery dates by supplier.",
					},
				}
			: {}),
		...overrides,
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<FeedOutcomePreview item={item} />
			</QueryClientProvider>,
		),
	);
}
async function shows(text: string) {
	await vi.waitFor(async () => {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(host.textContent).toContain(text);
	});
}
function preservesSource(withTitle: boolean) {
	expect(host.querySelector("a")?.getAttribute("href")).toBe(source);
	if (withTitle) {
		expect(host.textContent).toContain("Delivery chart");
		expect(host.textContent).toContain("Delivery dates by supplier.");
	}
}
async function retry(name: string) {
	const button = host.querySelector<HTMLButtonElement>(
		`button[aria-label="${name}"]`,
	);
	expect(button).not.toBeNull();
	await act(async () => button!.click());
}

describe.each([true, false])(
	"evidence reads with attachment title=%s",
	(withTitle) => {
		it("keeps the source readable while evidence is delayed, then describes only the bounded page", async () => {
			let resolve!: (value: { data: []; nextCursor: null }) => void;
			api.listEvidence.mockReturnValue(
				new Promise((done) => {
					resolve = done;
				}),
			);
			await mount(withTitle);
			await shows("Loading evidence");
			preservesSource(withTitle);
			await act(async () => resolve({ data: [], nextCursor: null }));
			await shows("No preview in the first five evidence records");
			preservesSource(withTitle);
			expect(host.textContent).not.toMatch(/no evidence/i);
			expect(api.previewEvidence).not.toHaveBeenCalled();
		});
		it("reports failed evidence verification and retries only that generated read", async () => {
			api.listEvidence.mockRejectedValueOnce(new Error("private diagnostic"));
			await mount(withTitle);
			await shows("Evidence could not be verified");
			preservesSource(withTitle);
			expect(host.textContent).not.toContain("private diagnostic");
			expect(host.textContent).not.toContain("No preview");
			await retry("Retry evidence");
			await shows("No preview in the first five evidence records");
			expect(api.listEvidence).toHaveBeenCalledTimes(2);
			expect(api.listEvidence.mock.calls[1]?.[0]).toEqual({
				id: workId,
				limit: 5,
			});
			expect(api.previewEvidence).not.toHaveBeenCalled();
		});
		it("reports failed image verification and retries only the canonical image read", async () => {
			api.listEvidence.mockResolvedValue({
				data: [imageRow],
				nextCursor: null,
			});
			api.previewEvidence.mockRejectedValueOnce(new Error("preview failed"));
			await mount(withTitle);
			await shows("Image preview could not be verified");
			preservesSource(withTitle);
			expect(host.querySelector("img")).toBeNull();
			await retry("Retry image preview");
			await act(async () => {
				await vi.waitFor(() =>
					expect(host.querySelector("img")?.getAttribute("src")).toBe(dataUrl),
				);
			});
			expect(api.listEvidence).toHaveBeenCalledTimes(1);
			expect(api.previewEvidence).toHaveBeenCalledTimes(2);
			expect(api.previewEvidence.mock.calls[1]?.[0]).toEqual({
				id: workId,
				evidenceId,
			});
		});
		it("keeps the title and source while the image is delayed or unavailable", async () => {
			let resolve!: (value: { status: string; reason: string }) => void;
			api.listEvidence.mockResolvedValue({
				data: [imageRow],
				nextCursor: null,
			});
			api.previewEvidence.mockReturnValue(
				new Promise((done) => {
					resolve = done;
				}),
			);
			await mount(withTitle);
			await shows("Loading image preview");
			preservesSource(withTitle);
			await act(async () =>
				resolve({ status: "unavailable", reason: "private reason" }),
			);
			await shows("Image preview unavailable");
			preservesSource(withTitle);
			expect(host.querySelector("img, button")).toBeNull();
			expect(host.textContent).not.toContain("private reason");
		});
	},
);

it("does not embed rejected, superseded, unavailable, legacy or external evidence", async () => {
	api.listEvidence.mockResolvedValue({
		data: [
			{ ...imageRow, disposition: "rejected", label: "Rejected secret" },
			{ ...imageRow, disposition: "superseded", label: "Superseded secret" },
			{
				...imageRow,
				reference: { ...imageRow.reference, status: "unavailable" },
			},
			{
				...imageRow,
				reference: { ...imageRow.reference, status: "unverified_legacy" },
			},
			{
				...imageRow,
				uri: "https://outside.example/image.png",
				reference: {
					kind: "external_https",
					status: "unverified",
					href: "https://outside.example/image.png",
					digest: null,
					reason: "unverified_external",
				},
			},
		],
		nextCursor: "more",
	});
	await mount();
	await shows("Evidence content unavailable");
	preservesSource(true);
	expect(api.previewEvidence).not.toHaveBeenCalled();
	expect(host.querySelector("img")).toBeNull();
	expect(host.innerHTML).not.toMatch(
		/outside\.example|Rejected secret|Superseded secret/,
	);
});
it("keeps the attachment title when available evidence has an empty label", async () => {
	api.listEvidence.mockResolvedValue({
		data: [{ ...imageRow, label: "" }],
		nextCursor: null,
	});
	api.previewEvidence.mockResolvedValue({
		status: "unavailable",
		reason: "unavailable",
	});
	await mount();
	await shows("Image preview unavailable");
	preservesSource(true);
});
it("retains canonical output revision titles and avoids repeating the sentence as a summary", async () => {
	api.listEvidence.mockResolvedValue({
		data: [
			{
				...imageRow,
				label: "Supplier report",
				reference: { kind: "output_revision", status: "available" },
			},
		],
		nextCursor: null,
	});
	await mount(true, {
		attachment: { title: "Attachment", summary: "The chart is ready." },
	});
	await shows("Supplier report");
	expect(host.textContent).not.toContain("The chart is ready.");
	expect(api.previewEvidence).not.toHaveBeenCalled();
});
it.each(["external", "available"])(
	"does not embed a %s preview without canonical image bytes",
	async (status) => {
		api.listEvidence.mockResolvedValue({ data: [imageRow], nextCursor: null });
		api.previewEvidence.mockResolvedValue({
			...available,
			status,
			imageDataUrl: undefined,
			href: "https://outside.example/image.png",
		});
		await mount();
		await shows("Image preview unavailable");
		expect(host.querySelector("img")).toBeNull();
		preservesSource(true);
	},
);
it("does not present cached image bytes as verified when an evidence refresh fails", async () => {
	client.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
	api.listEvidence
		.mockResolvedValueOnce({ data: [imageRow], nextCursor: null })
		.mockRejectedValue(new Error("offline"));
	await mount();
	await act(async () => {
		await vi.waitFor(() => expect(host.querySelector("img")).not.toBeNull());
	});
	await act(async () => {
		await client.refetchQueries(
			osQuery.workItems.listEvidence.queryOptions({
				input: { id: workId, limit: 5 },
			}),
		);
	});
	await shows("Evidence could not be verified");
	expect(host.querySelector("img")).toBeNull();
	api.listEvidence.mockResolvedValue({ data: [imageRow], nextCursor: null });
	await retry("Retry evidence");
	await act(async () => {
		await vi.waitFor(() => expect(host.querySelector("img")).not.toBeNull());
	});
	expect(api.listEvidence).toHaveBeenCalledTimes(3);
	expect(api.previewEvidence).toHaveBeenCalledTimes(1);
});
it("does not present cached image bytes as verified when the image refresh fails", async () => {
	api.listEvidence.mockResolvedValue({ data: [imageRow], nextCursor: null });
	api.previewEvidence
		.mockResolvedValueOnce(available)
		.mockRejectedValue(new Error("offline"));
	await mount();
	await act(async () => {
		await vi.waitFor(() => expect(host.querySelector("img")).not.toBeNull());
	});
	await act(async () => {
		await client.refetchQueries(
			workEvidencePreviewQueryOptions(workId, evidenceId),
		);
	});
	await shows("Image preview could not be verified");
	expect(host.querySelector("img")).toBeNull();
});
it.each([{ kind: "signal" }, { workItemId: null }])(
	"does not load evidence for an ineligible Feed item %s",
	async (overrides) => {
		await mount(false, overrides);
		expect(host.innerHTML).toBe("");
		expect(api.listEvidence).not.toHaveBeenCalled();
		expect(api.previewEvidence).not.toHaveBeenCalled();
	},
);
