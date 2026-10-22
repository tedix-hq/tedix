import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SkillBundleTree } from "../src/components/skill-bundle-tree";
import "../src/styles.css";

const parameters = new URLSearchParams(location.search);
const dark = parameters.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const checklist =
	"references/quarterly-supplier-onboarding-and-contract-renewal-checklist.md";

const revisions: Record<
	string,
	{ content: string; files: Record<string, string> }
> = {
	base: {
		content:
			"# Fixture skill\n\nCanonical instructions for the fictional bundle.",
		files: {
			[checklist]: "Checklist body v1",
			"references/glossary.md": "Glossary body v1",
			"scripts/run.ts": "export const run = 1;",
		},
	},
	refreshed: {
		content:
			"# Fixture skill\n\nCanonical instructions for the fictional bundle.",
		files: {
			[checklist]: "Checklist body v2",
			"references/glossary.md": "Glossary body v2",
			"scripts/run.ts": "export const run = 2;",
		},
	},
	pruned: {
		content: "# Fixture skill\n\nCanonical instructions, second revision.",
		files: {
			"references/glossary.md": "Glossary body v3",
			"scripts/run.ts": "export const run = 3;",
		},
	},
};

function Harness() {
	const [revision, setRevision] = useState("base");
	useEffect(() => {
		Object.assign(window, {
			bundleFixture: { refresh: (next: string) => setRevision(next) },
		});
	}, []);
	const current = revisions[revision]!;
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 text-kumo-default">
			<h1 className="text-lg font-semibold">Skill bundle selection</h1>
			<p className="text-sm text-kumo-subtle">
				Fictional bundle. Local revision swaps only.
			</p>
			<SkillBundleTree content={current.content} files={current.files} />
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Harness />);
