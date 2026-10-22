import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { buildSkillBundleTree, SkillBundleTree } from "./skill-bundle-tree";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(element: ReactElement) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(element);
	});
	return {
		host,
		async rerender(next: ReactElement) {
			await act(async () => {
				root.render(next);
			});
		},
		async unmount() {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

async function select(host: HTMLElement, name: string) {
	const button = [...host.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(name),
	);
	await act(async () => button?.click());
}

function activePath(host: HTMLElement) {
	return host.querySelector('[data-slot="text"]')?.textContent;
}

describe("skill bundle tree", () => {
	it("builds deterministic implicit directories with SKILL.md first", () => {
		const tree = buildSkillBundleTree([
			"references/z.md",
			"scripts/workflow.ts",
			"SKILL.md",
			"references/a.md",
		]);
		expect(tree.map((node) => node.name)).toEqual([
			"SKILL.md",
			"references",
			"scripts",
		]);
		expect(tree[1]?.children.map((node) => node.name)).toEqual([
			"a.md",
			"z.md",
		]);
	});

	it("lets a reader select every supporting text file", async () => {
		const view = await mount(
			<SkillBundleTree
				content="# Root"
				files={{
					"references/guide.md": "Guide body",
					"assets/prompt.txt": "Prompt body",
				}}
			/>,
		);
		expect(view.host.textContent).toContain("references");
		expect(view.host.textContent).toContain("assets");
		await select(view.host, "guide.md");
		expect(view.host.textContent).toContain("Guide body");
		await view.unmount();
	});

	it("never lets a supporting-file key replace canonical SKILL.md", async () => {
		const view = await mount(
			<SkillBundleTree
				content="Canonical instructions"
				files={{ "SKILL.md": "Untrusted override" }}
			/>,
		);
		expect(view.host.textContent).toContain("Canonical instructions");
		expect(view.host.textContent).not.toContain("Untrusted override");
		await view.unmount();
	});

	it("falls back to SKILL.md when a refreshed bundle drops the selected file", async () => {
		const view = await mount(
			<SkillBundleTree
				content="# Canonical"
				files={{
					"notes/todo.md": "Old todo",
					"scripts/run.sh": "echo run",
				}}
			/>,
		);
		await select(view.host, "todo.md");
		expect(view.host.textContent).toContain("Old todo");
		await view.rerender(
			<SkillBundleTree
				content="# Canonical"
				files={{ "scripts/run.sh": "echo run" }}
			/>,
		);
		expect(activePath(view.host)).toBe("SKILL.md");
		expect(view.host.textContent).toContain("# Canonical");
		expect(view.host.textContent).not.toContain("Old todo");
		await view.unmount();
	});

	it("keeps a surviving selection and shows refreshed content", async () => {
		const view = await mount(
			<SkillBundleTree
				content="# Canonical"
				files={{ "notes/todo.md": "Old todo" }}
			/>,
		);
		await select(view.host, "todo.md");
		await view.rerender(
			<SkillBundleTree
				content="# Canonical"
				files={{ "notes/todo.md": "New todo" }}
			/>,
		);
		expect(activePath(view.host)).toBe("notes/todo.md");
		expect(view.host.textContent).toContain("New todo");
		expect(view.host.textContent).not.toContain("Old todo");
		await view.unmount();
	});

	it("renders the canonical file when the bundle map is missing", async () => {
		for (const files of [null, undefined] as const) {
			const view = await mount(
				<SkillBundleTree content="# Canonical" files={files} />,
			);
			expect(activePath(view.host)).toBe("SKILL.md");
			expect(view.host.textContent).toContain("# Canonical");
			await view.unmount();
		}
	});

	it("recovers to an empty canonical file when refresh drops the selection", async () => {
		const view = await mount(
			<SkillBundleTree content="" files={{ "notes/todo.md": "Old todo" }} />,
		);
		await select(view.host, "todo.md");
		expect(view.host.textContent).toContain("Old todo");
		await view.rerender(<SkillBundleTree content="" files={{}} />);
		expect(activePath(view.host)).toBe("SKILL.md");
		expect(view.host.textContent).not.toContain("Old todo");
		await view.unmount();
	});
});
