import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({ validate: vi.fn(), record: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ osApi: { skills: api } }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => navigate,
}));

import {
	readSkillBundle,
	SkillBundleImportDialog,
} from "./skill-bundle-import-dialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function folderFile(path: string, value: string): File {
	const file = new File([value], path.split("/").at(-1)!, {
		type: "text/plain",
	});
	Object.defineProperty(file, "webkitRelativePath", { value: path });
	return file;
}

const doc = `---\nname: weekly-digest\ndescription: Compile the weekly digest\n---\n# Weekly digest\n`;

describe("readSkillBundle", () => {
	it("preserves the root document and maps every supporting file", async () => {
		const result = await readSkillBundle([
			folderFile("weekly-digest/SKILL.md", doc),
			folderFile("weekly-digest/references/checks.md", "# Checks"),
			folderFile("weekly-digest/scripts/workflow.ts", "export default {}"),
		]);
		expect(result).toMatchObject({
			title: "weekly-digest",
			description: "Compile the weekly digest",
			content: doc,
		});
		expect(result.files).toEqual({
			"references/checks.md": "# Checks",
			"scripts/workflow.ts": "export default {}",
		});
	});

	it("rejects nested skill documents, unsafe paths, and binary input", async () => {
		await expect(
			readSkillBundle([
				folderFile("bundle/SKILL.md", doc),
				folderFile("bundle/nested/SKILL.md", doc),
			]),
		).rejects.toThrow("Nested");
		await expect(
			readSkillBundle([
				folderFile("SKILL.md", doc),
				folderFile("../escape.md", "x"),
			]),
		).rejects.toThrow("Unsafe");
		await expect(
			readSkillBundle([
				folderFile("bundle/SKILL.md", doc),
				folderFile("bundle/assets/blob.bin", "a\0b"),
			]),
		).rejects.toThrow("Binary");
		await expect(
			readSkillBundle([folderFile("../SKILL.md", doc)]),
		).rejects.toThrow("Unsafe");
		await expect(
			readSkillBundle([folderFile("/SKILL.md", doc)]),
		).rejects.toThrow("Unsafe");
		await expect(
			readSkillBundle([folderFile("C:/SKILL.md", doc)]),
		).rejects.toThrow("Unsafe");
	});

	it("labels the browser file-count safety limit", async () => {
		const files = Array.from({ length: 101 }, (_, index) =>
			folderFile(`bundle/references/${index}.md`, "text"),
		);
		await expect(readSkillBundle(files)).rejects.toThrow(
			"Browser safety limit",
		);
	});
});

describe("SkillBundleImportDialog", () => {
	it("requires validation, then records only an explicit draft import", async () => {
		api.validate.mockResolvedValue({
			valid: true,
			errors: [],
			warnings: [{ code: "SUMMARY", message: "Add a summary" }],
		});
		api.record.mockResolvedValue({ entry: { id: "skill-1" }, warnings: [] });
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () =>
			root.render(
				<QueryClientProvider client={new QueryClient()}>
					<SkillBundleImportDialog onClose={vi.fn()} />
				</QueryClientProvider>,
			),
		);
		const input = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [folderFile("weekly-digest/SKILL.md", doc)],
		});
		await act(async () =>
			input.dispatchEvent(new Event("change", { bubbles: true })),
		);
		const validateButton = [...document.querySelectorAll("button")].find(
			(button) => button.textContent?.includes("Validate bundle"),
		);
		await act(async () => validateButton?.click());
		expect(api.record).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Add a summary");
		const importButton = [...document.querySelectorAll("button")].find(
			(button) => button.textContent?.includes("Import draft"),
		);
		await act(async () => importButton?.click());
		expect(api.record).toHaveBeenCalledWith(
			expect.objectContaining({
				lifecycleState: "draft",
				validate: "error",
				title: "weekly-digest",
			}),
		);
		expect(navigate).toHaveBeenCalledWith({
			to: "/skills/$skillId",
			params: { skillId: "skill-1" },
		});
		await act(async () => root.unmount());
		host.remove();
	});

	it("keeps the newest folder when an older read resolves last", async () => {
		let resolveFirst!: (value: string) => void;
		let resolveSecond!: (value: string) => void;
		const first = folderFile("first/SKILL.md", "pending");
		const second = folderFile("second/SKILL.md", "pending");
		Object.defineProperty(first, "text", {
			value: () => new Promise<string>((resolve) => (resolveFirst = resolve)),
		});
		Object.defineProperty(second, "text", {
			value: () => new Promise<string>((resolve) => (resolveSecond = resolve)),
		});
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () =>
			root.render(
				<QueryClientProvider client={new QueryClient()}>
					<SkillBundleImportDialog onClose={vi.fn()} />
				</QueryClientProvider>,
			),
		);
		const input = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [first],
		});
		act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [second],
		});
		act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
		await act(async () =>
			resolveSecond(
				"---\nname: second-skill\ndescription: Second selection\n---\n# Two",
			),
		);
		expect(document.body.textContent).toContain("second-skill");
		await act(async () =>
			resolveFirst(
				"---\nname: first-skill\ndescription: First selection\n---\n# One",
			),
		);
		expect(document.body.textContent).toContain("second-skill");
		expect(document.body.textContent).not.toContain("first-skill");
		await act(async () => root.unmount());
		host.remove();
	});
});
