import { UploadSimple } from "@phosphor-icons/react";
import { parseSkillFrontmatter } from "@tedix/api-contract/utils/skill-manifest";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";

export const SKILL_BUNDLE_MAX_FILES = 100;
export const SKILL_BUNDLE_MAX_FILE_BYTES = 512 * 1024;
export const SKILL_BUNDLE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export type SkillBundleDraft = {
	title: string;
	description: string;
	content: string;
	files: Record<string, string>;
	fileCount: number;
	totalBytes: number;
};

const unsafePath = (path: string) =>
	path.startsWith("/") ||
	/^[a-zA-Z]:/.test(path) ||
	path.includes("\\") ||
	path.split("/").some((part) => part === "" || part === "." || part === "..");

const looksBinary = (content: string) => {
	if (content.includes("\0") || content.includes("\uFFFD")) return true;
	const sample = content.slice(0, 8_192);
	for (let index = 0; index < sample.length; index += 1) {
		const code = sample.charCodeAt(index);
		if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
	}
	return false;
};

function commonRoot(paths: string[]): string | null {
	const roots = new Set(paths.map((path) => path.split("/")[0]));
	return roots.size === 1 && paths.every((path) => path.includes("/"))
		? [...roots][0]!
		: null;
}

export async function readSkillBundle(
	files: readonly File[],
): Promise<SkillBundleDraft> {
	if (files.length === 0) throw new Error("Choose a skill folder to import.");
	if (files.length > SKILL_BUNDLE_MAX_FILES) {
		throw new Error(
			`Browser safety limit: select at most ${SKILL_BUNDLE_MAX_FILES} files.`,
		);
	}
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	if (totalBytes > SKILL_BUNDLE_MAX_TOTAL_BYTES) {
		throw new Error(
			"Browser safety limit: the bundle must be 2 MiB or smaller.",
		);
	}
	const originalPaths = files.map(
		(file) => file.webkitRelativePath || file.name,
	);
	const unsafeOriginal = originalPaths.find(unsafePath);
	if (unsafeOriginal) throw new Error(`Unsafe bundle path: ${unsafeOriginal}`);
	const root = commonRoot(originalPaths);
	const entries = await Promise.all(
		files.map(async (file, index) => {
			if (file.size > SKILL_BUNDLE_MAX_FILE_BYTES) {
				throw new Error(
					`Browser safety limit: ${file.name} must be 512 KiB or smaller.`,
				);
			}
			const original = originalPaths[index]!;
			const path = root ? original.slice(root.length + 1) : original;
			if (unsafePath(path)) throw new Error(`Unsafe bundle path: ${original}`);
			let content: string;
			try {
				content = await file.text();
			} catch {
				throw new Error(`Could not read ${path}.`);
			}
			if (looksBinary(content)) {
				throw new Error(`Binary files are not supported: ${path}`);
			}
			return [path, content] as const;
		}),
	);
	const paths = entries.map(([path]) => path);
	if (new Set(paths).size !== paths.length) {
		throw new Error("The bundle contains duplicate normalized paths.");
	}
	const skillDocs = paths.filter((path) => path === "SKILL.md");
	const nestedSkillDocs = paths.filter(
		(path) => path !== "SKILL.md" && path.endsWith("/SKILL.md"),
	);
	if (skillDocs.length !== 1) {
		throw new Error("The selected folder must contain one root SKILL.md.");
	}
	if (nestedSkillDocs.length > 0) {
		throw new Error("Nested SKILL.md files are not supported.");
	}
	const content = entries.find(([path]) => path === "SKILL.md")![1];
	const frontmatter = parseSkillFrontmatter(content);
	const title =
		typeof frontmatter?.name === "string" ? frontmatter.name.trim() : "";
	const description =
		typeof frontmatter?.description === "string"
			? frontmatter.description.trim()
			: "";
	if (!title || !description) {
		throw new Error("SKILL.md frontmatter must include name and description.");
	}
	return {
		title,
		description,
		content,
		files: Object.fromEntries(entries.filter(([path]) => path !== "SKILL.md")),
		fileCount: entries.length,
		totalBytes,
	};
}

type ValidationIssue = { code: string; message: string; path?: string };

export function SkillBundleImportDialog({ onClose }: { onClose: () => void }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<SkillBundleDraft | null>(null);
	const [readError, setReadError] = useState<string | null>(null);
	const [reading, setReading] = useState(false);
	const selectionGeneration = useRef(0);
	const [validation, setValidation] = useState<{
		errors: ValidationIssue[];
		warnings: ValidationIssue[];
	} | null>(null);

	const validate = useMutation({
		mutationFn: (value: SkillBundleDraft) =>
			osApi.skills.validate({
				title: value.title,
				description: value.description,
				content: value.content,
				files: value.files,
			}),
		onSuccess: (result) =>
			setValidation({ errors: result.errors, warnings: result.warnings }),
	});
	const record = useMutation({
		mutationFn: (value: SkillBundleDraft) =>
			osApi.skills.record({
				title: value.title,
				description: value.description,
				content: value.content,
				files: value.files,
				lifecycleState: "draft",
				validate: "error",
			}),
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: osQueryKeys.skills() });
			onClose();
			void navigate({
				to: "/skills/$skillId",
				params: { skillId: result.entry.id },
			});
		},
	});
	const busy = reading || validate.isPending || record.isPending;

	return (
		<Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
			<DialogContent size="lg">
				<DialogHeader>
					<DialogTitle>Import skill bundle</DialogTitle>
					<DialogDescription>
						Choose a folder containing one root SKILL.md. Import creates a
						draft; it does not activate or run the skill.
					</DialogDescription>
				</DialogHeader>
				<Input
					aria-label="Skill bundle folder"
					disabled={busy}
					multiple
					type="file"
					{...({ webkitdirectory: "" } as Record<string, string>)}
					onChange={async (event) => {
						setReadError(null);
						setValidation(null);
						setDraft(null);
						validate.reset();
						record.reset();
						const generation = selectionGeneration.current + 1;
						selectionGeneration.current = generation;
						setReading(true);
						try {
							const next = await readSkillBundle(
								Array.from(event.target.files ?? []),
							);
							if (selectionGeneration.current === generation) setDraft(next);
						} catch (error) {
							if (selectionGeneration.current === generation) {
								setReadError(
									error instanceof Error
										? error.message
										: "Could not read this bundle.",
								);
							}
						} finally {
							if (selectionGeneration.current === generation) setReading(false);
						}
					}}
				/>
				<Text role="label" tone="secondary" className="m-0">
					Browser safety limits: 100 text files, 512 KiB each, 2 MiB total.
					Folder selection requires a browser with directory-upload support.
				</Text>
				{draft ? (
					<div className="grid gap-1 rounded-lg border border-kumo-line p-3">
						<Text as="strong" role="body">
							{draft.title}
						</Text>
						<Text role="body" tone="secondary" className="m-0">
							{draft.description}
						</Text>
						<Text role="label" tone="secondary" className="m-0">
							{draft.fileCount} text files
						</Text>
					</div>
				) : null}
				{readError || validate.isError || record.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Bundle could not be imported</AlertTitle>
						<AlertDescription>
							{readError ??
								(validate.error as Error | null)?.message ??
								(record.error as Error | null)?.message}
						</AlertDescription>
					</Alert>
				) : null}
				{validation?.errors.length ? (
					<Alert variant="destructive">
						<AlertTitle>Validation failed</AlertTitle>
						<AlertDescription>
							{validation.errors.map((issue) => issue.message).join(" · ")}
						</AlertDescription>
					</Alert>
				) : null}
				{validation?.warnings.length ? (
					<Alert>
						<AlertTitle>Review warnings</AlertTitle>
						<AlertDescription>
							{validation.warnings.map((issue) => issue.message).join(" · ")}
						</AlertDescription>
					</Alert>
				) : null}
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={onClose}>
						Cancel
					</Button>
					{validation && validation.errors.length === 0 ? (
						<Button
							disabled={!draft || busy}
							onClick={() => draft && record.mutate(draft)}
						>
							<UploadSimple size={14} />
							{record.isPending ? "Importing…" : "Import draft"}
						</Button>
					) : (
						<Button
							disabled={!draft || busy}
							onClick={() => draft && validate.mutate(draft)}
						>
							{validate.isPending ? "Validating…" : "Validate bundle"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
