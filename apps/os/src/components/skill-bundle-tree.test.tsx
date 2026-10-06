import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { buildSkillBundleTree, SkillBundleTree } from "./skill-bundle-tree";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<SkillBundleTree
					content="# Root"
					files={{
						"references/guide.md": "Guide body",
						"assets/prompt.txt": "Prompt body",
					}}
				/>,
			);
		});
		expect(host.textContent).toContain("references");
		expect(host.textContent).toContain("assets");
		const guide = [...host.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("guide.md"),
		);
		await act(async () => guide?.click());
		expect(host.textContent).toContain("Guide body");
		await act(async () => root.unmount());
		host.remove();
	});

	it("never lets a supporting-file key replace canonical SKILL.md", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<SkillBundleTree
					content="Canonical instructions"
					files={{ "SKILL.md": "Untrusted override" }}
				/>,
			);
		});
		expect(host.textContent).toContain("Canonical instructions");
		expect(host.textContent).not.toContain("Untrusted override");
		await act(async () => root.unmount());
		host.remove();
	});
});
