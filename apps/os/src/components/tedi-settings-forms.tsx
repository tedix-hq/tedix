import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TediAppAssignmentRole } from "@tedix/api-contract/schemas/tedi-app-assignments";
import { osApi } from "@/lib/api";
import { errorMessage } from "@/lib/orpc-error";
import { osQueryKeys } from "@/lib/os-query-options";
import { toast } from "@/components/kumo/toast";
import { type ReactNode, useEffect } from "react";
import * as z from "zod";
import { Key, Plus } from "@phosphor-icons/react";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Button } from "@/components/kumo/button";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { SelectItem } from "@/components/kumo/select";
import { SensitiveInput } from "@/components/kumo/sensitive-input";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { SettingsRow } from "@/components/settings-row";
import { modelsForSettings } from "@/lib/model-selection";
import { recordValue } from "./tedi-settings-channels";

export function SettingsSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">{children}</CardContent>
		</Card>
	);
}

export function SettingsRecordRow({
	title,
	description,
	trailing,
}: {
	title: ReactNode;
	description?: ReactNode;
	trailing: ReactNode;
}) {
	return (
		<li>
			<SettingsRow title={title} description={description} className="p-3">
				{trailing}
			</SettingsRow>
		</li>
	);
}

const SECRET_PRESETS = [
	"GITHUB_PAT",
	"TELEGRAM_BOT_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
] as const;

export function modelOverride(current: unknown, primary: string) {
	const runtime = recordValue(current);
	const agents = recordValue(runtime.agents);
	const defaults = recordValue(agents.defaults);
	const model = recordValue(defaults.model);
	return {
		...runtime,
		agents: {
			...agents,
			defaults: { ...defaults, model: { ...model, primary } },
		},
	};
}

export function prettyJson(value: unknown): string {
	return JSON.stringify(value ?? {}, null, 2);
}

const identitySettingsSchema = z.object({
	displayName: z.string().trim().max(120),
	personality: z.string().trim().max(10_000),
	language: z.string().trim().min(1, "Enter a preferred language."),
	timezone: z.string().trim().min(1, "Enter a timezone."),
});

const repositorySettingsSchema = z.object({
	repoUrl: z
		.string()
		.trim()
		.refine((value) => value.length === 0 || URL.canParse(value), {
			message: "Enter a valid repository URL.",
		}),
	repoBranch: z.string().trim().max(255),
});

function jsonDocument(label: string) {
	return z.string().superRefine((value, context) => {
		try {
			JSON.parse(value);
		} catch {
			context.addIssue({
				code: "custom",
				message: `${label} must be valid JSON.`,
			});
		}
	});
}

const governanceSettingsSchema = z.object({
	toolPolicyJson: jsonDocument("Tool policy"),
	learningPolicyJson: jsonDocument("Learning policy"),
	budgetsJson: jsonDocument("Budgets"),
	quietHoursJson: jsonDocument("Quiet hours"),
});

const modelSettingsSchema = z.object({
	model: z.string().min(1, "Choose a model."),
});

export const secretSettingsSchema = z.object({
	name: z.enum(SECRET_PRESETS),
	value: z.string().min(1, "Enter a secret value."),
});

const appAssignmentSchema = z.object({
	appId: z.string().uuid("Choose an app."),
	role: z.enum(["operator", "observer"]),
});

export const customDomainSchema = z.object({
	hostname: z
		.string()
		.trim()
		.toLowerCase()
		.regex(
			/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
			"Enter a valid hostname.",
		),
});

export function ModelSettingsForm({
	value,
	models,
	disabled,
	onSave,
}: {
	value: string;
	models: Array<{
		ref: string;
		label: string;
		allowed: boolean;
		selectable: boolean;
	}>;
	disabled: boolean;
	onSave: (value: z.output<typeof modelSettingsSchema>) => void;
}) {
	const options = modelsForSettings(models, value).map((model) => ({
		...model,
		value: model.ref,
		label: `${model.ref === "cloudflare/auto" ? "Auto" : model.label}${!model.selectable ? " — superseded" : model.allowed ? "" : " — unavailable"}`,
	}));
	const form = useZodForm({
		schema: modelSettingsSchema,
		defaultValues: { model: value },
		onSubmit: ({ value: next }) => onSave(next),
	});
	useEffect(() => form.reset({ model: value }), [form, value]);
	return (
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<FormField
				form={form}
				name="model"
				label="Primary model"
				description="Unavailable active models remain visible but cannot be selected. A superseded current model remains visible until you replace it."
			>
				{(field, meta) => (
					<FormSelect
						field={field}
						{...meta}
						disabled={disabled}
						items={options}
					>
						{options.map((model) => (
							<SelectItem
								key={model.ref}
								value={model.ref}
								disabled={!model.allowed || !model.selectable}
							>
								{model.label}
							</SelectItem>
						))}
					</FormSelect>
				)}
			</FormField>
			<Button type="submit" variant="outline" disabled={disabled}>
				Save model
			</Button>
		</form>
	);
}

export function SecretSettingsForm({
	disabled,
	onSave,
}: {
	disabled: boolean;
	onSave: (value: z.output<typeof secretSettingsSchema>) => Promise<boolean>;
}) {
	const form = useZodForm({
		schema: secretSettingsSchema,
		defaultValues: { name: SECRET_PRESETS[0], value: "" },
		onSubmit: async ({ value }) => {
			if (await onSave(value)) form.reset({ name: value.name, value: "" });
		},
	});
	return (
		<form
			className="grid gap-3 sm:grid-cols-[minmax(12rem,1fr)_2fr_auto]"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<FormField form={form} name="name" label="Secret name">
				{(field, meta) => (
					<FormSelect field={field} {...meta} disabled={disabled}>
						{SECRET_PRESETS.map((name) => (
							<SelectItem key={name} value={name}>
								{name}
							</SelectItem>
						))}
					</FormSelect>
				)}
			</FormField>
			<FormField form={form} name="value" label="Secret value">
				{(field, meta) => (
					<SensitiveInput
						id={meta.id}
						aria-labelledby={`${meta.id}-label`}
						aria-invalid={meta.invalid || undefined}
						aria-describedby={meta.descriptionId}
						aria-errormessage={meta.errorId}
						value={field.state.value}
						disabled={disabled}
						onValueChange={field.handleChange}
					/>
				)}
			</FormField>
			<Button
				type="submit"
				disabled={disabled}
				className="self-end"
				icon={<Key className="size-4" />}
			>
				Save
			</Button>
		</form>
	);
}

export function AppAssignmentForm({
	apps,
	disabled,
	onSave,
}: {
	apps: Array<{ id: string; name: string }>;
	disabled: boolean;
	onSave: (value: z.output<typeof appAssignmentSchema>) => Promise<boolean>;
}) {
	const form = useZodForm({
		schema: appAssignmentSchema,
		defaultValues: { appId: "", role: "operator" },
		onSubmit: async ({ value }) => {
			if (await onSave(value)) form.reset({ appId: "", role: value.role });
		},
	});
	return (
		<form
			className="grid gap-3 sm:grid-cols-[1fr_10rem_auto]"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<FormField form={form} name="appId" label="App to assign">
				{(field, meta) => (
					<FormSelect
						field={field}
						{...meta}
						placeholder="Choose app"
						disabled={disabled}
					>
						{apps.map((app) => (
							<SelectItem key={app.id} value={app.id}>
								{app.name}
							</SelectItem>
						))}
					</FormSelect>
				)}
			</FormField>
			<FormField form={form} name="role" label="Assignment role">
				{(field, meta) => (
					<FormSelect field={field} {...meta} disabled={disabled}>
						<SelectItem value="operator">Operator</SelectItem>
						<SelectItem value="observer">Observer</SelectItem>
					</FormSelect>
				)}
			</FormField>
			<Button
				type="submit"
				disabled={disabled}
				className="self-end"
				icon={<Plus className="size-4" />}
			>
				Assign
			</Button>
		</form>
	);
}

export function CustomDomainForm({
	disabled,
	onSave,
}: {
	disabled: boolean;
	onSave: (value: z.output<typeof customDomainSchema>) => Promise<boolean>;
}) {
	const form = useZodForm({
		schema: customDomainSchema,
		defaultValues: { hostname: "" },
		onSubmit: async ({ value }) => {
			if (await onSave(value)) form.reset({ hostname: "" });
		},
	});
	return (
		<form
			className="flex items-start gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<div className="min-w-0 flex-1">
				<FormField form={form} name="hostname" label="Custom hostname">
					{(field, meta) => (
						<FormInput
							field={field}
							{...meta}
							placeholder="agent.example.com"
							disabled={disabled}
						/>
					)}
				</FormField>
			</div>
			<Button
				type="submit"
				size="sm"
				disabled={disabled}
				className="self-end"
				icon={<Plus className="size-4" />}
			>
				Add
			</Button>
		</form>
	);
}

export function IdentitySettingsForm({
	values,
	disabled,
	onSave,
}: {
	values: z.input<typeof identitySettingsSchema>;
	disabled: boolean;
	onSave: (value: z.output<typeof identitySettingsSchema>) => void;
}) {
	const form = useZodForm({
		schema: identitySettingsSchema,
		defaultValues: values,
		onSubmit: ({ value }) => onSave(value),
	});
	useEffect(
		() => form.reset(values),
		[
			form,
			values.displayName,
			values.personality,
			values.language,
			values.timezone,
		],
	);
	return (
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<FormField
				form={form}
				name="displayName"
				label="Display name"
				description="Shown throughout Tedix without changing the tedi's stable identity."
			>
				{(field, meta) => <FormInput field={field} {...meta} />}
			</FormField>
			<FormField
				form={form}
				name="personality"
				label="Personality"
				description="Defines working style and tone; what it may do is set separately."
			>
				{(field, meta) => <FormTextarea field={field} {...meta} rows={5} />}
			</FormField>
			<div className="grid gap-3 sm:grid-cols-2">
				<FormField
					form={form}
					name="language"
					label="Language"
					description="Preferred response language."
				>
					{(field, meta) => <FormInput field={field} {...meta} />}
				</FormField>
				<FormField
					form={form}
					name="timezone"
					label="Timezone"
					description="Local-time context for schedules and coordination."
				>
					{(field, meta) => <FormInput field={field} {...meta} />}
				</FormField>
			</div>
			<Button type="submit" disabled={disabled}>
				Save identity
			</Button>
		</form>
	);
}

export function RepositorySettingsForm({
	values,
	disabled,
	onSave,
}: {
	values: z.input<typeof repositorySettingsSchema>;
	disabled: boolean;
	onSave: (value: z.output<typeof repositorySettingsSchema>) => void;
}) {
	const form = useZodForm({
		schema: repositorySettingsSchema,
		defaultValues: values,
		onSubmit: ({ value }) => onSave(value),
	});
	useEffect(
		() => form.reset(values),
		[form, values.repoUrl, values.repoBranch],
	);
	return (
		<form
			className="space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			<FormField form={form} name="repoUrl" label="Repository URL" optional>
				{(field, meta) => (
					<FormInput
						field={field}
						{...meta}
						type="url"
						placeholder="https://github.com/acme/repository"
					/>
				)}
			</FormField>
			<FormField form={form} name="repoBranch" label="Repository branch">
				{(field, meta) => <FormInput field={field} {...meta} />}
			</FormField>
			<Button type="submit" disabled={disabled}>
				Save repository
			</Button>
		</form>
	);
}

export function GovernanceSettingsForm({
	values,
	disabled,
	onSave,
}: {
	values: z.input<typeof governanceSettingsSchema>;
	disabled: boolean;
	onSave: (value: z.output<typeof governanceSettingsSchema>) => void;
}) {
	const form = useZodForm({
		schema: governanceSettingsSchema,
		defaultValues: values,
		validateOn: "blur",
		onSubmit: ({ value }) => onSave(value),
	});
	useEffect(
		() => form.reset(values),
		[
			form,
			values.toolPolicyJson,
			values.learningPolicyJson,
			values.budgetsJson,
			values.quietHoursJson,
		],
	);
	return (
		<form
			className="space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			{(
				[
					["toolPolicyJson", "Tool policy"],
					["learningPolicyJson", "Learning policy"],
					["budgetsJson", "Budgets"],
					["quietHoursJson", "Quiet hours"],
				] as const
			).map(([name, label]) => (
				<FormField key={name} form={form} name={name} label={label}>
					{(field, meta) => (
						<FormTextarea
							field={field}
							{...meta}
							rows={4}
							aria-label={`${label} JSON`}
						/>
					)}
				</FormField>
			))}
			<Button type="submit" disabled={disabled}>
				Save
			</Button>
		</form>
	);
}

function assignmentOutcomeMessage(
	action: string,
	result: { aihClientSync: { status: string; reason?: string } },
) {
	if (result.aihClientSync.status === "skipped") {
		toast.warning(
			`${action}; AIH client sync was skipped${result.aihClientSync.reason ? `: ${result.aihClientSync.reason}` : ""}`,
		);
		return;
	}
	toast.success(action);
}

export function useTediAppAssignments(tediId: string) {
	const queryClient = useQueryClient();
	const createAssignment = useMutation({
		mutationFn: (value: z.output<typeof appAssignmentSchema>) =>
			osApi.tediAppAssignments.create({
				tediId,
				appId: value.appId,
				role: value.role,
			}),
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.tediAppAssignments(),
			});
			assignmentOutcomeMessage("App assigned", result);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to assign app")),
	});

	const updateAssignmentRole = useMutation({
		mutationFn: (input: {
			assignmentId: string;
			role: TediAppAssignmentRole;
		}) => osApi.tediAppAssignments.updateRole(input),
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.tediAppAssignments(),
			});
			assignmentOutcomeMessage("Assignment role updated", result);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to update assignment role")),
	});

	const deleteAssignment = useMutation({
		mutationFn: (assignmentId: string) =>
			osApi.tediAppAssignments.delete({ assignmentId }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.tediAppAssignments(),
			});
			toast.success("App unassigned");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to unassign app")),
	});

	return { createAssignment, updateAssignmentRole, deleteAssignment };
}
