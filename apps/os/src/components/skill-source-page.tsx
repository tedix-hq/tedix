import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { DetailUnavailable } from "@/components/detail-unavailable";
import { CodeBlock } from "@/components/kumo/code";
import {
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { SkillAnatomySection } from "@/components/skill-anatomy-section";
import { SkillBundleTree } from "@/components/skill-bundle-tree";
import {
	skillDetailQueryOptions,
	skillRunsQueryOptions,
} from "@/lib/os-query-options";

/**
 * The saved version as a developer reads it: the files, what a run does step
 * by step, and the input definition exactly as stored.
 */
export function SkillSourcePage() {
	const { skillId } = useParams({ from: "/_session/_tenant/skills/$skillId" });
	const detail = useQuery(skillDetailQueryOptions(skillId));
	const runs = useQuery(skillRunsQueryOptions(skillId));
	const skill = detail.data?.entry;
	if (detail.isPending) return <ListSkeleton rows={6} />;
	if (detail.isError || !skill)
		return (
			<DetailUnavailable
				resource="Skill"
				error={detail.error}
				onRetry={() => detail.refetch()}
				retrying={detail.isFetching}
			/>
		);
	return (
		<div className="grid min-w-0 gap-8">
			<PageSection aria-labelledby="skill-files-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="skill-files-title">
							Instructions and files
						</SectionTitle>
						<SectionDescription>
							Everything saved in version {skill.revision}. Select a file to
							read it.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<SkillBundleTree content={skill.content} files={skill.files} />
			</PageSection>
			<SkillAnatomySection skill={skill} runs={runs.data?.runs ?? []} />
			<PageSection aria-labelledby="skill-input-definition-title">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle id="skill-input-definition-title">
							Input definition
						</SectionTitle>
						<SectionDescription>
							The inputs exactly as stored. Settings lists them in plain words.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				{skill.inputSchema ? (
					<CodeBlock
						className="max-h-96 overflow-auto"
						code={JSON.stringify(skill.inputSchema, null, 2)}
						lang="json"
						showCopyButton
					/>
				) : (
					<Text role="body" tone="secondary" className="m-0">
						This version stores no input definition.
					</Text>
				)}
			</PageSection>
		</div>
	);
}
