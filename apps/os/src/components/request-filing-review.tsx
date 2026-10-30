import { Link } from "@/components/kumo/link";
import type { AttentionResult } from "@tedix/api-contract/schemas/work-attention";
import { Card, CardContent } from "@/components/kumo/card";
import { Text } from "@/components/kumo/text";
import {
	Select,
	SelectTrigger,
	SelectValue,
	SelectContent,
	SelectItem,
} from "@/components/kumo/select";

export function RequestFilingReview({
	data,
	file,
	filing,
}: {
	data: AttentionResult;
	file: (id: string, projectId: string) => void;
	filing: boolean;
}) {
	const names = new Map(
		data.projects.map((project) => [project.id, project.name]),
	);
	return (
		<section
			id="attention-unfiled"
			aria-label="Automatic filing"
			className="grid min-w-0 gap-3"
		>
			<Text as="h2" role="section">
				Automatic filing
			</Text>
			{data.automaticFilingEnabled === false && (
				<Text tone="secondary">Automatic filing is paused.</Text>
			)}
			{data.automaticFilingEnabled !== false &&
				(data.pendingFilingCount ?? data.unfiled.length) > 0 && (
					<Text tone="secondary">
						{data.pendingFilingCount ?? data.unfiled.length} captured requests
						are waiting for a confident project match.
					</Text>
				)}
			{(data.pendingFilingCount ?? data.unfiled.length) === 0 && (
				<Text tone="secondary">All captured requests are filed.</Text>
			)}
			{data.filingDigest && (
				<Text role="label" tone="secondary">
					Past 7 days: {data.filingDigest.total} auto-filings ·{" "}
					{data.filingDigest.corrected} corrections learned.
				</Text>
			)}
			{data.filings?.map((row) => (
				<Card key={row.id} size="sm">
					<CardContent className="grid gap-2 pt-3">
						<Text>{row.text}</Text>
						<Text tone="secondary">
							{row.projectId
								? `Filed to ${names.get(row.projectId) ?? "project"} · ${row.by === "auto" ? "auto-filed" : "corrected"}`
								: row.suggestedProjectId
									? `Unfiled · suggested ${names.get(row.suggestedProjectId) ?? "project"}`
									: "Unfiled"}
							{row.review ? ", needs a better match" : ""}
						</Text>
						<Text role="label" tone="secondary">
							{row.reason}
						</Text>
						<Select
							disabled={filing}
							value={row.projectId}
							items={Object.fromEntries(
								data.projects.map((project) => [project.id, project.name]),
							)}
							onValueChange={(value) => {
								if (value) file(row.id, value);
							}}
						>
							<SelectTrigger aria-label={`Move: ${row.text}`}>
								Move · <SelectValue placeholder="Project" />
							</SelectTrigger>
							<SelectContent>
								{data.projects
									.filter((project) => project.status === "active")
									.map((project) => (
										<SelectItem key={project.id} value={project.id}>
											{project.name}
										</SelectItem>
									))}
							</SelectContent>
						</Select>
					</CardContent>
				</Card>
			))}
			{!!data.emptyAutoCreated?.length && (
				<div className="grid gap-1">
					<Text role="label" tone="secondary">
						Auto-created containers empty after 14 days
					</Text>
					{data.emptyAutoCreated.map((container) => (
						<Link
							key={container.id}
							href={
								container.kind === "workspace"
									? `/workspace/${container.id}`
									: `/work/projects/${container.id}`
							}
						>
							{container.name}
						</Link>
					))}
				</div>
			)}
		</section>
	);
}
