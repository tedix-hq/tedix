import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const api = vi.hoisted(() => ({
	getMine: vi.fn(),
	updateMine: vi.fn(),
	requestAvatarUpload: vi.fn(),
	confirmAvatarUpload: vi.fn(),
	deleteAvatar: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		userProfile: api,
	},
}));
vi.mock("@/lib/os-query-options", () => ({
	userProfileQueryOptions: () => ({
		queryKey: ["user-profile"],
		queryFn: () => api.getMine({}),
	}),
}));
vi.mock("@/lib/use-os-identity", () => ({
	useOsIdentity: () => ({ name: "JWT fallback", email: "jwt@example.com" }),
}));
vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "launcher" }),
}));

import { ProfilePage, profileInitials, uploadUserAvatar } from "./profile-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function renderProfile() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<ProfilePage />
			</QueryClientProvider>,
		);
	});
	await flush();
	return { container, queryClient };
}

beforeEach(() => {
	vi.clearAllMocks();
	api.getMine.mockResolvedValue({
		id: "descope-subject-legacy-ada",
		name: "Ada Lovelace",
		email: "ada@example.com",
		avatarUrl: "https://images.example.com/ada.jpg",
		revision: 3,
		updatedAt: "2026-09-25T10:00:00.000Z",
	});
	api.updateMine.mockResolvedValue({
		id: "descope-subject-legacy-ada",
		name: "Ada Byron",
		email: "ada@example.com",
		avatarUrl: "https://images.example.com/ada.jpg",
		revision: 4,
		updatedAt: "2026-09-25T10:01:00.000Z",
	});
	api.requestAvatarUpload.mockResolvedValue({
		imageId: "profile-image",
		uploadURL: "https://upload.example.com/once",
		uploadNonce: "22222222-2222-4222-8222-222222222222",
	});
	api.confirmAvatarUpload.mockResolvedValue({
		url: "https://images.example.com/new.jpg",
		imageId: "profile-image",
		revision: 4,
	});
	api.deleteAvatar.mockResolvedValue({ success: true, revision: 4 });
});

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
	document.body.replaceChildren();
});

describe("ProfilePage", () => {
	it("renders canonical profile identity and provider-owned security copy", async () => {
		const { container } = await renderProfile();
		expect(
			container.querySelector<HTMLInputElement>("#profile-name")?.value,
		).toBe("Ada Lovelace");
		expect(
			container.querySelector<HTMLInputElement>("#profile-email")?.value,
		).toBe("ada@example.com");
		expect(container.textContent).toContain("managed by Tedix Identity");
		expect(container.textContent).not.toContain("Change password");
		expect(
			container.querySelector('input[aria-label="Choose profile photo"]'),
		).not.toBeNull();
	});

	it("offers reviewer setup through the existing logout broker and fresh email verification", async () => {
		api.getMine.mockResolvedValue({
			id: "reviewer-profile",
			name: "Marketplace reviewer",
			email: "reviewer@example.test",
			avatarUrl: null,
			revision: 1,
		});
		const { container } = await renderProfile();
		const link = Array.from(container.querySelectorAll("a")).find((element) =>
			element.textContent?.includes("Sign out for sign-in setup"),
		);
		expect(link?.getAttribute("href")).toBe(
			"/auth/session-broker/start?operation=logout&redirect_to=%2Faccount%2Fprofile",
		);
		expect(container.textContent).toContain("Continue by email");
		expect(container.querySelector('input[type="password"]')).toBeNull();
	});

	it("leaves available setup methods to the provider rather than hardcoding user identity", async () => {
		const { container } = await renderProfile();
		expect(container.textContent).not.toContain(
			"Sign out to set reviewer password",
		);
		expect(container.textContent).toContain("Tedix Identity determines");
	});

	it("updates the display name against the loaded revision", async () => {
		const { container, queryClient } = await renderProfile();
		const input = container.querySelector<HTMLInputElement>("#profile-name")!;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(input, "  Ada Byron  ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			container.querySelector<HTMLFormElement>("form")!.requestSubmit();
		});
		await flush();
		expect(api.updateMine).toHaveBeenCalledWith({
			name: "Ada Byron",
			expectedRevision: 3,
		});
		expect(queryClient.getQueryData(["user-profile"])).toMatchObject({
			name: "Ada Byron",
			revision: 4,
		});
	});

	it("derives a short, stable avatar fallback", () => {
		expect(profileInitials("Ada Lovelace", "ada@example.com")).toBe("AL");
		expect(profileInitials("", "grace@example.com")).toBe("G");
	});

	it("binds a direct avatar upload with the server nonce", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 200 }));
		const result = await uploadUserAvatar(
			new File(["avatar"], "avatar.png", { type: "image/png" }),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://upload.example.com/once",
			expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
		);
		expect(api.confirmAvatarUpload).toHaveBeenCalledWith({
			imageId: "profile-image",
			uploadNonce: "22222222-2222-4222-8222-222222222222",
		});
		expect(result).toMatchObject({ revision: 4 });
		fetchMock.mockRestore();
	});

	it("deletes the current avatar against the loaded revision", async () => {
		const { container } = await renderProfile();
		const remove = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Remove",
		);
		if (!remove) throw new Error("Remove avatar action was not rendered");
		await act(async () => remove.click());
		await flush();
		expect(api.deleteAvatar).toHaveBeenCalledWith({ expectedRevision: 3 });
	});
});
