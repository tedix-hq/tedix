import { CaretDown, CaretRight, File, Folder } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Button } from "@/components/kumo/button";
import { CodeBlock } from "@/components/kumo/code";
import { Text } from "@/components/kumo/text";

export type SkillBundleNode = {
	name: string;
	path: string;
	type: "directory" | "file";
	children: SkillBundleNode[];
};

export function buildSkillBundleTree(
	paths: readonly string[],
): SkillBundleNode[] {
	const roots: SkillBundleNode[] = [];
	for (const path of [...paths].sort()) {
		let level = roots;
		let built = "";
		path.split("/").forEach((name, index, parts) => {
			built = built ? `${built}/${name}` : name;
			const type = index === parts.length - 1 ? "file" : "directory";
			let node = level.find((item) => item.name === name);
			if (!node) {
				node = { name, path: built, type, children: [] };
				level.push(node);
			}
			level = node.children;
		});
	}
	const sort = (nodes: SkillBundleNode[]) => {
		nodes.sort((a, b) => {
			if (a.path === "SKILL.md") return -1;
			if (b.path === "SKILL.md") return 1;
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		nodes.forEach((node) => sort(node.children));
	};
	sort(roots);
	return roots;
}

function languageForPath(
	path: string,
): "markdown" | "typescript" | "json" | "yaml" | "bash" {
	if (/\.tsx?$/.test(path)) return "typescript";
	if (/\.jsonc?$/.test(path)) return "json";
	if (/\.ya?ml$/.test(path)) return "yaml";
	if (/\.(sh|bash)$/.test(path)) return "bash";
	return "markdown";
}

function TreeNodes({
	nodes,
	selected,
	onSelect,
}: {
	nodes: SkillBundleNode[];
	selected: string;
	onSelect: (path: string) => void;
}) {
	const [closed, setClosed] = useState<Set<string>>(new Set());
	return (
		<ul className="m-0 grid list-none gap-0.5 p-0">
			{nodes.map((node) => {
				const collapsed = closed.has(node.path);
				return (
					<li key={node.path}>
						<Button
							aria-expanded={node.type === "directory" ? !collapsed : undefined}
							className="w-full justify-start"
							variant={node.path === selected ? "secondary" : "ghost"}
							onClick={() =>
								node.type === "directory"
									? setClosed((current) => {
											const next = new Set(current);
											if (collapsed) next.delete(node.path);
											else next.add(node.path);
											return next;
										})
									: onSelect(node.path)
							}
						>
							{node.type === "directory" ? (
								collapsed ? (
									<CaretRight size={14} />
								) : (
									<CaretDown size={14} />
								)
							) : (
								<File size={14} />
							)}
							{node.type === "directory" ? <Folder size={14} /> : null}
							{node.name}
						</Button>
						{node.type === "directory" && !collapsed ? (
							<div className="ml-4">
								<TreeNodes
									nodes={node.children}
									selected={selected}
									onSelect={onSelect}
								/>
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

export function SkillBundleTree({
	content,
	files,
}: {
	content: string;
	files?: Record<string, string> | null;
}) {
	const bundle = useMemo<Record<string, string>>(
		() => ({ ...files, "SKILL.md": content }),
		[content, files],
	);
	const tree = useMemo(
		() => buildSkillBundleTree(Object.keys(bundle)),
		[bundle],
	);
	const [selected, setSelected] = useState("SKILL.md");
	const selectedContent = bundle[selected] ?? "";
	return (
		<section
			aria-label="Skill bundle"
			className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]"
		>
			<nav
				aria-label="Bundle files"
				className="rounded-lg border border-kumo-line p-2"
			>
				<TreeNodes nodes={tree} selected={selected} onSelect={setSelected} />
			</nav>
			<div className="min-w-0">
				<Text role="label" tone="secondary" className="mb-1">
					{selected}
				</Text>
				<CodeBlock
					className="max-h-96 overflow-auto"
					code={selectedContent}
					lang={languageForPath(selected)}
					showCopyButton
				/>
			</div>
		</section>
	);
}
