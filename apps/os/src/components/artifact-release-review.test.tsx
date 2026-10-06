import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	approve: vi.fn(),
	revoke: vi.fn(),
	share: vi.fn(),
	writeText: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		cognitiveRuntime: {
			createRedactedArtifactRevision: api.create,
			createArtifactShareLink: api.share,
		},
	},
	getAuthenticatedOsApi: () => ({
		cognitiveRuntime: {
			approveArtifactRelease: api.approve,
			revokeArtifactRelease: api.revoke,
		},
	}),
}));
vi.mock("@/lib/os-query-options", () => ({
	artifactReleaseTargetQueryOptions: (tediId: string, artifactId: string) => ({
		queryKey: ["release", tediId, artifactId],
		queryFn: () => api.get(artifactId),
	}),
}));
vi.mock("@/lib/step-up-auth", () => ({
	useStepUpAuth: () => ({
		requireStepUp: (callback: (token: string) => void) =>
			callback("step-up-token"),
		StepUpDialog: () => null,
	}),
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: { organization: { descopeTenantId: "tenant-1" } },
	}),
}));
vi.mock("@/components/kumo/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/kumo/textarea", async () => {
	const React = await import("react");
	return {
		Textarea: React.forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(
			({ onChange, "aria-label": label, ...props }, ref) => (
				<>
					<textarea
						ref={ref}
						aria-label={label}
						onChange={onChange}
						{...props}
					/>
					<button
						data-fill={label}
						onClick={() =>
							onChange?.({
								target: {
									value:
										label === "Redacted candidate text"
											? "safe redaction"
											: "I reviewed every byte",
								},
							} as never)
						}
					>
						Fill
					</button>
				</>
			),
		),
	};
});
vi.mock("@/components/kumo/checkbox", () => ({
	Checkbox: ({
		checked,
		onCheckedChange,
	}: {
		checked: boolean;
		onCheckedChange: (value: boolean) => void;
	}) => (
		<button
			role="checkbox"
			aria-checked={checked}
			onClick={() => onCheckedChange(!checked)}
		/>
	),
}));

import { ArtifactReleaseReview } from "./artifact-release-review";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.resetAllMocks();
});

function click(element: Element | null) {
	if (!(element instanceof HTMLElement)) throw new Error("missing element");
	element.click();
}
async function waitForText(container: HTMLElement, value: string) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (container.textContent?.includes(value)) return;
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	throw new Error(`Timed out waiting for ${value}`);
}

describe("ArtifactReleaseReview", () => {
	it("moves from exact source preview through approval, link mint, and revocation", async () => {
		const digestA = "a".repeat(64);
		const digestB = "b".repeat(64);
		const source = {
			review: null,
			sourcePreview: {
				parentArtifactId: "source-1",
				parentContentDigest: digestA,
				sourceStatus: "unknown_history",
				sourceNotice: "Observed prefix is incomplete",
				parentPreview: {
					artifactId: "source-1",
					digest: digestA,
					text: "private source",
					mimeType: "text/plain; charset=utf-8",
				},
			},
		};
		const review = {
			candidateId: "candidate-1",
			parentArtifactId: "source-1",
			parentContentDigest: digestA,
			childArtifactId: "child-1",
			childContentDigest: digestB,
			sourceStatus: "unknown_history",
			sourceNotice: "Observed prefix is incomplete",
			reviewHeadId: "candidate-1",
			activeApprovalId: null,
			recordedApprovalId: null,
			releaseActive: false,
			reviewability: "reviewable",
			createdAt: "2026-09-23T00:00:00Z",
			parentPreview: source.sourcePreview.parentPreview,
			candidatePreview: {
				artifactId: "child-1",
				digest: digestB,
				text: "safe redaction",
				mimeType: "text/plain; charset=utf-8",
			},
		};
		let approved = false;
		api.get.mockImplementation((id: string) =>
			id === "source-1"
				? source
				: {
						review: approved
							? {
									...review,
									reviewHeadId: "approval-1",
									activeApprovalId: "approval-1",
									recordedApprovalId: "approval-1",
									releaseActive: true,
								}
							: review,
						sourcePreview: null,
					},
		);
		api.create
			.mockRejectedValueOnce(new Error("outcome unknown"))
			.mockResolvedValue({ review });
		api.approve.mockImplementation(async () => {
			approved = true;
			return {
				review: {
					...review,
					activeApprovalId: "approval-1",
					recordedApprovalId: "approval-1",
					releaseActive: true,
				},
				decision: {},
			};
		});
		api.revoke.mockResolvedValue({ review: null, decision: {} });
		api.share.mockResolvedValue({
			url: "https://artifact.test/release",
			expiresAt: "later",
			artifactId: "child-1",
		});
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: api.writeText },
		});
		api.writeText.mockResolvedValue(undefined);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<ArtifactReleaseReview tediId="tedi-1" artifactId="source-1" />
				</QueryClientProvider>,
			);
		});
		cleanups.push(() => {
			root.unmount();
			container.remove();
		});
		await act(async () => {
			click(
				[...container.querySelectorAll("button")].find((button) =>
					button.textContent?.includes("Review"),
				) ?? null,
			);
			await Promise.resolve();
		});
		await waitForText(container, "Original — always private");
		expect(container.textContent).toContain("Original — always private");
		await act(async () => {
			click(container.querySelector('[data-fill="Redacted candidate text"]'));
		});
		await act(async () => {
			click(
				[...container.querySelectorAll("button")].find((button) =>
					button.textContent?.includes("Create private"),
				) ?? null,
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.textContent).toContain("Original — always private");
		await act(async () => {
			click(
				[...container.querySelectorAll("button")].find((button) =>
					button.textContent?.includes("Create private"),
				) ?? null,
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		await waitForText(container, "Redacted copy");
		expect(api.create).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedParentDigest: digestA,
				content: "safe redaction",
			}),
		);
		expect(api.create.mock.calls[0]?.[0].idempotencyKey).toBe(
			api.create.mock.calls[1]?.[0].idempotencyKey,
		);
		expect(container.textContent).toContain("Redacted copy");
		await act(async () => {
			click(
				container.querySelector(
					'[data-fill="Owner attestation or revocation reason"]',
				),
			);
			const checkbox = container.querySelector('[role="checkbox"]');
			click(checkbox);
		});
		await act(async () => {
			click(
				[...container.querySelectorAll("button")].find((button) =>
					button.textContent?.includes("Approve exact"),
				) ?? null,
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(api.approve).toHaveBeenCalledWith(
			expect.objectContaining({
				childContentDigest: digestB,
				acknowledgeIncompleteSourceHistory: true,
			}),
		);
		await act(async () => {
			click(
				[...container.querySelectorAll("button")].find((button) =>
					button.textContent?.includes("Copy approved"),
				) ?? null,
			);
			await Promise.resolve();
		});
		expect(api.writeText).toHaveBeenCalledWith("https://artifact.test/release");
		await act(async () => {
			click(
				container.querySelector(
					'[data-fill="Owner attestation or revocation reason"]',
				),
			);
		});
		await act(async () => {
			click(
				[...container.querySelectorAll("button")].find(
					(button) => button.textContent === "Revoke",
				) ?? null,
			);
			await Promise.resolve();
		});
		expect(api.revoke).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedApprovalId: "approval-1",
				childContentDigest: digestB,
			}),
		);
	});
});
