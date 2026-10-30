import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ModelFallbackPolicySchema,
	PLATFORM_MODEL_FALLBACK,
	type ModelFallbackPolicy,
} from "@tedix/api-contract/schemas/model-fallback";
import { LoadError, Alert, AlertDescription } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	SettingsSection,
	SettingsSectionContent,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { modelCatalogQueryOptions, osQueryKeys } from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";

export function OrganizationModelFallbackForm({
	organizationId,
	initialPolicy,
}: {
	organizationId: string;
	initialPolicy: ModelFallbackPolicy | null | undefined;
}) {
	const [policy, setPolicy] = useState<ModelFallbackPolicy>(() =>
		structuredClone(initialPolicy ?? PLATFORM_MODEL_FALLBACK),
	);
	const [inherited, setInherited] = useState(!initialPolicy);
	const id = useId();
	const queryClient = useQueryClient();
	const catalog = useQuery({
		...modelCatalogQueryOptions(),
		staleTime: 60_000,
	});
	const models = (catalog.data?.models ?? []).filter(
		(model) =>
			["azure-openai", "workers-ai", "cloudflare"].includes(model.provider) &&
			(model.selectable || Boolean(policy.ladder[model.ref])),
	);
	const validation = ModelFallbackPolicySchema.safeParse(policy);
	const save = useMutation({
		mutationFn: (next: ModelFallbackPolicy | null) =>
			osApi.organizations.update({
				organizationId,
				metadata: { modelFallback: next },
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.organizationDetail(),
			});
		},
	});
	function edit(next: ModelFallbackPolicy) {
		setPolicy(next);
		setInherited(false);
		save.reset();
	}
	return (
		<SettingsSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Model fallback</SectionTitle>
					<SectionDescription>
						When a provider runs out of credits, exhausts its quota or stays
						unavailable after retries, try these models in order. Every switch
						is recorded on the run. Fixed-model and residency requirements still
						apply.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SettingsSectionContent className="grid min-w-0 gap-4">
				{catalog.isError && (
					<LoadError
						title="Model availability could not be loaded"
						help="Try again before saving this policy."
						error={catalog.error}
						onRetry={() => {
							void catalog.refetch();
						}}
						retrying={catalog.isFetching}
					/>
				)}
				{catalog.isPending && (
					<Text role="label" tone="secondary">
						Loading model availability…
					</Text>
				)}
				<Text role="label" tone="secondary">
					{inherited ? "Using the platform default" : "Organization policy"}
				</Text>
				<Label htmlFor={`${id}-cap`}>
					<span id={`${id}-cap-label`}>
						Maximum switches per model operation
					</span>
				</Label>
				<Input
					id={`${id}-cap`}
					aria-labelledby={`${id}-cap-label`}
					type="number"
					min={0}
					max={5}
					value={policy.maxTransitions}
					disabled={save.isPending}
					onChange={(event) =>
						edit({ ...policy, maxTransitions: Number(event.target.value) })
					}
				/>
				<Text role="label" tone="secondary">
					Set to 0 to disable fallback. Provider errors after output begins are
					never replayed.
				</Text>
				{models.map((primary) => (
					<div key={primary.ref} className="grid min-w-0 gap-2">
						<Text as="strong" role="body">
							{primary.label}
						</Text>
						{(policy.ladder[primary.ref] ?? []).map((ref, index) => (
							<div
								key={`${primary.ref}-${index}`}
								className="flex flex-wrap items-center gap-2"
							>
								<Text role="label" tone="secondary">
									{index + 1}.
								</Text>
								<Select
									value={ref}
									disabled={save.isPending}
									onValueChange={(value) => {
										if (!value) return;
										const next = [...(policy.ladder[primary.ref] ?? [])];
										next[index] = String(value);
										edit({
											...policy,
											ladder: { ...policy.ladder, [primary.ref]: next },
										});
									}}
								>
									<SelectTrigger
										aria-label={`${primary.label} fallback ${index + 1}`}
									>
										<SelectValue>
											{models.find((candidate) => candidate.ref === ref)
												?.label ?? ref}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{models
											.filter((candidate) => candidate.ref !== primary.ref)
											.map((candidate) => (
												<SelectItem
													key={candidate.ref}
													value={candidate.ref}
													disabled={!candidate.allowed || !candidate.selectable}
												>
													{candidate.label}
												</SelectItem>
											))}
									</SelectContent>
								</Select>
								<Button
									variant="secondary"
									disabled={save.isPending}
									onClick={() =>
										edit({
											...policy,
											ladder: {
												...policy.ladder,
												[primary.ref]: (
													policy.ladder[primary.ref] ?? []
												).filter((_, i) => i !== index),
											},
										})
									}
								>
									Remove
								</Button>
							</div>
						))}
						<Button
							className="justify-self-start"
							variant="secondary"
							disabled={
								save.isPending || (policy.ladder[primary.ref]?.length ?? 0) >= 5
							}
							onClick={() => {
								const next = models.find(
									(candidate) =>
										candidate.allowed &&
										candidate.selectable &&
										candidate.ref !== primary.ref &&
										!policy.ladder[primary.ref]?.includes(candidate.ref),
								);
								if (next)
									edit({
										...policy,
										ladder: {
											...policy.ladder,
											[primary.ref]: [
												...(policy.ladder[primary.ref] ?? []),
												next.ref,
											],
										},
									});
							}}
						>
							Add fallback for {primary.label}
						</Button>
					</div>
				))}
				{!validation.success && (
					<Alert variant="destructive">
						<AlertDescription>
							{validation.error.issues.map((issue) => issue.message).join(". ")}
						</AlertDescription>
					</Alert>
				)}
				{save.isError && (
					<Alert variant="destructive">
						<AlertDescription>
							{errorMessage(save.error, "Fallback policy could not be saved.")}
						</AlertDescription>
					</Alert>
				)}
				{save.isSuccess && <Text role="label">Fallback policy saved.</Text>}
				<div className="flex flex-wrap gap-2">
					<Button
						disabled={save.isPending || !validation.success || !catalog.data}
						onClick={() => {
							if (validation.success) save.mutate(validation.data);
						}}
					>
						Save fallback policy
					</Button>
					<Button
						variant="secondary"
						disabled={save.isPending}
						onClick={() => {
							setPolicy(structuredClone(PLATFORM_MODEL_FALLBACK));
							setInherited(true);
							save.mutate(null);
						}}
					>
						Use platform default
					</Button>
				</div>
			</SettingsSectionContent>
		</SettingsSection>
	);
}
