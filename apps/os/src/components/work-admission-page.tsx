import {
	WorkPageHeader,
	WorkListSkeleton,
	WorkReadFailure,
} from "@/components/work-surface-primitives";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Page } from "@/components/kumo/page";
import { osApi } from "@/lib/api";
import { useOsFormattingPreferences, sentenceCase } from "@/lib/format";
import { absoluteTime } from "@/lib/time";
import {
	workAdmissionSpecificationQueryOptions,
	workFleetQueryOptions,
	workItemReadinessQueryOptions,
	workSchedulerQueryOptions,
} from "@/lib/os-query-options";
import { ReadinessOverview, MutationError } from "./work-operations-shared";

const admissionLookupSchema = z.object({
	itemId: z.string().trim().uuid("Enter a canonical Work Item UUID."),
});

const admissionSpecificationSchema = z.object({
	rawSpec: z.string().refine((value) => {
		try {
			const parsed = JSON.parse(value) as unknown;
			return Boolean(
				parsed && typeof parsed === "object" && !Array.isArray(parsed),
			);
		} catch {
			return false;
		}
	}, "Enter a valid JSON object."),
});

export function WorkAdmissionPage() {
	useOsFormattingPreferences();
	const client = useQueryClient();
	const [loadedId, setLoadedId] = useState("");
	const spec = useQuery({
		...workAdmissionSpecificationQueryOptions(
			loadedId || "00000000-0000-4000-8000-000000000000",
		),
		enabled: Boolean(loadedId),
	});
	const readiness = useQuery({
		...workItemReadinessQueryOptions(
			loadedId || "00000000-0000-4000-8000-000000000000",
		),
		enabled: Boolean(loadedId),
	});
	const replace = useMutation({
		mutationFn: (value: z.output<typeof admissionSpecificationSchema>) => {
			if (!spec.data)
				throw new Error(
					"Load the current admission specification before editing",
				);
			return osApi.workItems.replaceAdmissionSpecification({
				id: loadedId,
				expectedWorkItemVersion: spec.data.workItemVersion,
				expectedAdmissionSpecRevision: spec.data.admissionSpecRevision,
				specification: JSON.parse(value.rawSpec) as never,
			});
		},
		onSuccess: async (value) => {
			editorForm.setFieldValue(
				"rawSpec",
				JSON.stringify(
					{ resources: value.resources, budget: value.budget },
					null,
					2,
				),
			);
			await Promise.all([
				client.invalidateQueries({
					queryKey: workAdmissionSpecificationQueryOptions(loadedId).queryKey,
				}),
				client.invalidateQueries({
					queryKey: workItemReadinessQueryOptions(loadedId).queryKey,
				}),
				client.invalidateQueries({
					queryKey: workSchedulerQueryOptions().queryKey,
				}),
				client.invalidateQueries({
					queryKey: workFleetQueryOptions().queryKey,
				}),
			]);
		},
	});
	const editorForm = useZodForm({
		schema: admissionSpecificationSchema,
		defaultValues: { rawSpec: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => replace.mutate(value),
	});
	useEffect(() => {
		editorForm.setFieldValue(
			"rawSpec",
			spec.data
				? JSON.stringify(
						{ resources: spec.data.resources, budget: spec.data.budget },
						null,
						2,
					)
				: "",
		);
	}, [spec.data, editorForm]);
	const lookupForm = useZodForm({
		schema: admissionLookupSchema,
		defaultValues: { itemId: "" },
		validateOn: "submit",
		onSubmit: ({ value }) => {
			setLoadedId(value.itemId);
			editorForm.reset();
		},
	});
	return (
		<Page width="full">
			<WorkPageHeader
				title="Admission"
				description="See which tasks are ready to start and what each needs. Readiness is checked again when work starts."
			/>
			<ReadinessOverview
				selectedId={loadedId}
				onSelect={(id) => {
					setLoadedId(id);
					editorForm.reset();
				}}
			/>
			{loadedId && (readiness.isPending || spec.isPending) ? (
				<WorkListSkeleton />
			) : null}
			{readiness.isError || spec.isError ? (
				<WorkReadFailure
					title="Admission unavailable"
					error={readiness.error ?? spec.error}
				/>
			) : null}
			<Collapsible>
				<CollapsibleDefaultTrigger>
					Advanced: IDs and specification JSON
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<Card>
						<CardHeader>
							<CardTitle>Admission specification</CardTitle>
							<CardDescription>
								Select Work above or load an exact ID here. Replacing its
								resource and budget requirements requires an explicit save.
							</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-3">
							<form
								className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
								onSubmit={(event) => {
									event.preventDefault();
									void lookupForm.handleSubmit();
								}}
							>
								<FormField form={lookupForm} name="itemId" label="Work Item id">
									{(field, meta) => (
										<FormInput
											field={field}
											{...meta}
											placeholder="Work Item UUID"
										/>
									)}
								</FormField>
								<Button type="submit" variant="outline">
									Load
								</Button>
							</form>
							{spec.data ? (
								<Button
									size="sm"
									variant="outline"
									onClick={() =>
										editorForm.setFieldValue(
											"rawSpec",
											JSON.stringify(
												{
													resources: spec.data.resources,
													budget: spec.data.budget,
												},
												null,
												2,
											),
										)
									}
								>
									Use current specification
								</Button>
							) : null}
							<form
								className="grid gap-3"
								onSubmit={(event) => {
									event.preventDefault();
									void editorForm.handleSubmit();
								}}
							>
								<FormField
									form={editorForm}
									name="rawSpec"
									label="Admission specification JSON"
								>
									{(field, meta) => (
										<FormTextarea
											field={field}
											{...meta}
											className="min-h-48 font-mono"
										/>
									)}
								</FormField>
								<Button
									type="submit"
									disabled={!spec.data || spec.isFetching || replace.isPending}
								>
									Replace specification
								</Button>
							</form>
							<MutationError error={replace.error} />
						</CardContent>
					</Card>
				</CollapsibleDefaultContent>
			</Collapsible>
			{readiness.data ? (
				<Card>
					<CardHeader>
						<CardTitle>Current readiness</CardTitle>
						<CardDescription>
							Derived{" "}
							<time
								dateTime={readiness.data.derivedAt}
								title={absoluteTime(readiness.data.derivedAt)}
							>
								{absoluteTime(readiness.data.derivedAt)}
							</time>{" "}
							from every admission gate; this state is read-only.
						</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-3">
						<Badge variant={readiness.data.ready ? "success" : "warning"}>
							{sentenceCase(readiness.data.state)}
						</Badge>
						<ul className="m-0 grid gap-2 pl-5">
							{readiness.data.gates.map((gate) => (
								<li key={gate.gate}>
									<strong>{sentenceCase(gate.gate)}</strong>: {gate.detail}{" "}
									<Badge
										variant={
											gate.evaluation === "passed" ? "success" : "warning"
										}
									>
										{sentenceCase(gate.evaluation)}
									</Badge>
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			) : null}
		</Page>
	);
}
