/** Tedix OS ownership of the governed digital-worker settings seam. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { TediAppAssignmentRole } from "@tedix/api-contract/schemas/tedi-app-assignments";
import type {
	QuietHours,
	SelfImprovementPolicy,
	TediBudgets,
	ToolPolicy,
	ChannelsConfig,
} from "@tedix/api-contract/schemas/tedi";
import { ArrowsClockwise, Key, Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/kumo/alert-dialog";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { SensitiveInput } from "@/components/kumo/sensitive-input";
import { Surface } from "@/components/kumo/surface";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import { getAuthenticatedOsApi, osApi } from "@/lib/api";
import { errorMessage } from "@/lib/orpc-error";
import {
	modelCatalogQueryOptions,
	appListQueryOptions,
	osQuery,
	osQueryKeys,
	tediDetailQueryOptions,
	tediDevicesQueryOptions,
	tediDomainsQueryOptions,
	tediRuntimeStatusQueryOptions,
	tediAppAssignmentsQueryOptions,
	tediPairingRequestsQueryOptions,
	tediSecretsQueryOptions,
} from "@/lib/os-query-options";
import { modelsForSettings } from "@/lib/model-selection";
import { useStepUpAuth } from "@/lib/step-up-auth";
import {
	TEDIS_DELETE_DENIED_REASON,
	TEDIS_MANAGE_DENIED_REASON,
	TEDI_SECRETS_MANAGE_DENIED_REASON,
	TEDI_SECRETS_UNKNOWN_REASON,
	useCanManageTediSecrets,
	useCanReadTediSecrets,
	useCanDeleteTedis,
	useCanManageTedis,
} from "@/lib/tedi-permissions";

const SECRET_PRESETS = [
	"GITHUB_PAT",
	"TELEGRAM_BOT_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
] as const;

type ManagedChannel = "telegram";
type DmPolicy = "allowlist" | "disabled" | "open" | "pairing";
type GroupPolicy = "allowlist" | "disabled" | "open";
type CommonChannelPolicy = {
	dmPolicy: DmPolicy;
	groupPolicy: GroupPolicy;
	requireMention: boolean;
};

const DEFAULT_CHANNEL_POLICY: CommonChannelPolicy = {
	dmPolicy: "pairing",
	groupPolicy: "allowlist",
	requireMention: true,
};

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function modelOverride(current: unknown, primary: string) {
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

function prettyJson(value: unknown): string {
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

const secretSettingsSchema = z.object({
	name: z.enum(SECRET_PRESETS),
	value: z.string().min(1, "Enter a secret value."),
});

const appAssignmentSchema = z.object({
	appId: z.string().uuid("Choose an app."),
	role: z.enum(["operator", "observer"]),
});

const customDomainSchema = z.object({
	hostname: z
		.string()
		.trim()
		.toLowerCase()
		.regex(
			/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
			"Enter a valid hostname.",
		),
});

const channelPolicySchema = z.object({
	enabled: z.boolean(),
	botToken: z.string(),
	dmPolicy: z.enum(["allowlist", "disabled", "open", "pairing"]),
	groupPolicy: z.enum(["allowlist", "disabled", "open"]),
	requireMention: z.boolean(),
});

const liveChannelsSchema = z.object({
	telegram: channelPolicySchema,
});

type LiveChannelsValues = z.output<typeof liveChannelsSchema>;

function liveChannelValues(channelsValue: unknown): LiveChannelsValues {
	const channels = recordValue(channelsValue);
	return Object.fromEntries(
		(["telegram"] as const).map((channel) => {
			const existing = recordValue(channels[channel]);
			const dmPolicy = ["allowlist", "disabled", "open", "pairing"].includes(
				String(existing.dmPolicy),
			)
				? (existing.dmPolicy as DmPolicy)
				: DEFAULT_CHANNEL_POLICY.dmPolicy;
			const groupPolicy = ["allowlist", "disabled", "open"].includes(
				String(existing.groupPolicy),
			)
				? (existing.groupPolicy as GroupPolicy)
				: DEFAULT_CHANNEL_POLICY.groupPolicy;
			return [
				channel,
				{
					enabled: existing.enabled === true,
					botToken: "",
					dmPolicy,
					groupPolicy,
					requireMention: existing.requireMention !== false,
				},
			];
		}),
	) as LiveChannelsValues;
}

function LiveChannelsForm({
	values,
	canManage,
	canReadSecrets,
	canManageSecrets,
	isSaving,
	isTesting,
	onSave,
	onTest,
}: {
	values: LiveChannelsValues;
	canManage: boolean;
	canReadSecrets: boolean;
	canManageSecrets: boolean;
	isSaving: boolean;
	isTesting: boolean;
	onSave: (value: LiveChannelsValues) => Promise<boolean>;
	onTest: (channel: ManagedChannel, token: string) => void;
}) {
	const form = useZodForm({
		schema: liveChannelsSchema,
		defaultValues: values,
		onSubmit: async ({ value }) => {
			if (await onSave(value)) {
				form.reset(
					Object.fromEntries(
						(["telegram"] as const).map((channel) => [
							channel,
							{ ...value[channel], botToken: "" },
						]),
					) as LiveChannelsValues,
				);
			}
		},
	});
	useEffect(() => form.reset(values), [form, values]);

	return (
		<form
			className="space-y-5"
			onSubmit={(event) => {
				event.preventDefault();
				void form.handleSubmit();
			}}
		>
			{(["telegram"] as const).map((channel) => (
				<Surface key={channel} className="space-y-3 p-3">
					<FormField
						form={form}
						name={`${channel}.enabled`}
						label={channel}
						orientation="horizontal"
					>
						{(field, meta) => (
							<Switch
								id={meta.id}
								checked={field.state.value}
								disabled={!canManage}
								onCheckedChange={field.handleChange}
							/>
						)}
					</FormField>
					<FormField
						form={form}
						name={`${channel}.botToken`}
						label={`${channel} bot token`}
						description={
							canReadSecrets
								? "Leave blank to preserve the current credential."
								: "Credential presence is unknown."
						}
					>
						{(field, meta) => (
							<div className="flex flex-wrap items-start gap-2">
								<div className="min-w-0 flex-1">
									<SensitiveInput
										id={meta.id}
										aria-labelledby={`${meta.id}-label`}
										aria-invalid={meta.invalid || undefined}
										aria-describedby={meta.descriptionId}
										aria-errormessage={meta.errorId}
										placeholder={
											canReadSecrets
												? "Enter a replacement token"
												: "Credential presence unknown"
										}
										disabled={!canManageSecrets}
										value={field.state.value}
										onValueChange={field.handleChange}
									/>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={isTesting || !field.state.value}
									onClick={() => onTest(channel, field.state.value)}
								>
									Test replacement credential
								</Button>
							</div>
						)}
					</FormField>
					<div className="grid gap-3 sm:grid-cols-3">
						<FormField
							form={form}
							name={`${channel}.dmPolicy`}
							label="DM policy"
						>
							{(field, meta) => (
								<FormSelect field={field} {...meta} disabled={!canManage}>
									{["pairing", "allowlist", "open", "disabled"].map((value) => (
										<SelectItem key={value} value={value}>
											{value}
										</SelectItem>
									))}
								</FormSelect>
							)}
						</FormField>
						<FormField
							form={form}
							name={`${channel}.groupPolicy`}
							label="Group policy"
						>
							{(field, meta) => (
								<FormSelect field={field} {...meta} disabled={!canManage}>
									{["allowlist", "open", "disabled"].map((value) => (
										<SelectItem key={value} value={value}>
											{value}
										</SelectItem>
									))}
								</FormSelect>
							)}
						</FormField>
						<FormField
							form={form}
							name={`${channel}.requireMention`}
							label="Require mention"
							orientation="horizontal"
						>
							{(field, meta) => (
								<Switch
									id={meta.id}
									checked={field.state.value}
									disabled={!canManage}
									onCheckedChange={field.handleChange}
								/>
							)}
						</FormField>
					</div>
				</Surface>
			))}
			<Button type="submit" disabled={!canManage || isSaving}>
				Save channels
			</Button>
		</form>
	);
}

function ModelSettingsForm({
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
					<FormSelect field={field} {...meta} disabled={disabled}>
						{modelsForSettings(models, value).map((model) => (
							<SelectItem
								key={model.ref}
								value={model.ref}
								disabled={!model.allowed || !model.selectable}
							>
								{model.label}
								{!model.selectable
									? " — superseded"
									: model.allowed
										? ""
										: " — unavailable"}
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

function SecretSettingsForm({
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
			<Button type="submit" disabled={disabled} className="self-end">
				<Key className="h-4 w-4" /> Save
			</Button>
		</form>
	);
}

function AppAssignmentForm({
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
			<Button type="submit" disabled={disabled} className="self-end">
				<Plus className="h-4 w-4" /> Assign
			</Button>
		</form>
	);
}

function CustomDomainForm({
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
			<Button type="submit" size="sm" disabled={disabled} className="self-end">
				<Plus className="h-4 w-4" /> Add
			</Button>
		</form>
	);
}

function IdentitySettingsForm({
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
				description="Defines working style and tone; authority remains governed separately."
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

function RepositorySettingsForm({
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

function GovernanceSettingsForm({
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
				Save governance
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

export function TediSettingsPage({ tediId }: { tediId: string }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const canManage = useCanManageTedis();
	const canDelete = useCanDeleteTedis();
	const canReadSecrets = useCanReadTediSecrets();
	const canManageSecrets = useCanManageTediSecrets();
	const tedi = useQuery(tediDetailQueryOptions(tediId));
	const runtime = useQuery(tediRuntimeStatusQueryOptions(tediId));
	const models = useQuery(modelCatalogQueryOptions(tediId));
	const secrets = useQuery({
		...tediSecretsQueryOptions(tediId),
		enabled: canReadSecrets,
	});
	const devices = useQuery(tediDevicesQueryOptions(tediId));
	const domains = useQuery(tediDomainsQueryOptions(tediId));
	const assignments = useQuery(tediAppAssignmentsQueryOptions(tediId));
	const apps = useQuery(appListQueryOptions(100));
	const pairingRequests = useQuery({
		...tediPairingRequestsQueryOptions(tediId),
		refetchInterval: 30_000,
	});
	const channelValues = useMemo(
		() => liveChannelValues(tedi.data?.channels),
		[tedi.data?.channels],
	);
	const runtimeOverrides = tedi.data?.runtimeOverrides as
		| { agents?: { defaults?: { model?: { primary?: string } } } }
		| null
		| undefined;
	const selectedModel =
		runtimeOverrides?.agents?.defaults?.model?.primary ?? "";

	const invalidateTedi = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
			queryClient.invalidateQueries({ queryKey: osQueryKeys.tediSecrets() }),
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.tediAppAssignments(),
			}),
		]);

	const update = useMutation({
		...osQuery.tedis.update.mutationOptions(),
		onSuccess: async () => {
			await Promise.all([
				invalidateTedi(),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.modelCatalog() }),
			]);
			toast.success("Tedi settings saved");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to save tedi settings")),
	});

	const run = useMutation({
		mutationFn: async (action: "wake" | "recover" | "repair" | "sync") => {
			if (action === "wake") return osApi.tedis.wake({ tediId });
			if (action === "recover")
				return osApi.tedis.wake({
					tediId,
					allowSandboxReset: true,
					reason: "Operator requested safe workstation recovery",
				});
			if (action === "repair") return osApi.tedis.repair({ tediId });
			return osApi.tedis.syncConfig({ tediId, force: true });
		},
		onSuccess: async (_data, action) => {
			await invalidateTedi();
			toast.success(
				action === "wake"
					? "Wake requested"
					: action === "recover"
						? "Recovery wake requested"
						: action === "repair"
							? "Repair completed"
							: "Configuration synced",
			);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Runtime action failed")),
	});

	const setSecret = useMutation({
		mutationFn: (value: z.output<typeof secretSettingsSchema>) =>
			osApi.tediSecrets.set({
				tediId,
				name: value.name,
				value: value.value,
			}),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tediSecrets() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
			]);
			toast.success("Secret saved");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to save secret")),
	});

	const deleteSecret = useMutation({
		mutationFn: (secretId: string) =>
			osApi.tediSecrets.delete({ tediId, secretId }),
		onMutate: async (secretId) => {
			const key = tediSecretsQueryOptions(tediId).queryKey;
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData(key);
			queryClient.setQueryData(key, (current: typeof secrets.data) =>
				current
					? {
							...current,
							data: current.data.filter((row) => row.id !== secretId),
						}
					: current,
			);
			return { previous, key };
		},
		onError: (error, _secretId, context) => {
			if (context?.previous)
				queryClient.setQueryData(context.key, context.previous);
			toast.error(errorMessage(error, "Failed to delete secret"));
		},
		onSettled: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tediSecrets() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
			]),
	});

	const saveChannels = useMutation({
		mutationFn: async (value: LiveChannelsValues) => {
			if (!tedi.data) throw new Error("Tedi settings are unavailable");
			const current = recordValue(tedi.data.channels);
			const nextChannels = {
				...current,
				telegram: {
					...recordValue(current.telegram),
					enabled: value.telegram.enabled,
					dmPolicy: value.telegram.dmPolicy,
					groupPolicy: value.telegram.groupPolicy,
					requireMention: value.telegram.requireMention,
				},
			} as ChannelsConfig;

			await osApi.tedis.update({ tediId, channels: nextChannels });
			const issues: string[] = [];
			const secretWrites = [
				{ name: "TELEGRAM_BOT_TOKEN", value: value.telegram.botToken },
			]
				.filter(({ value }) => value.length > 0)
				.map(({ name, value }) =>
					osApi.tediSecrets.set({ tediId, name, value }),
				);
			const secretResults = await Promise.allSettled(secretWrites);
			const failedSecrets = secretResults.filter(
				(result) => result.status === "rejected",
			).length;
			if (failedSecrets)
				issues.push(`${failedSecrets} credential writes failed`);

			const policyResults = await Promise.allSettled(
				(["telegram"] as const).map((channel) =>
					osApi.tedis.updateChannelConfig({
						tediId,
						channel,
						config: {
							enabled: value[channel].enabled,
							dmPolicy: value[channel].dmPolicy,
							groupPolicy: value[channel].groupPolicy,
							requireMention: value[channel].requireMention,
						},
					}),
				),
			);
			const failedPolicies = policyResults.filter(
				(result) => result.status === "rejected",
			).length;
			if (failedPolicies)
				issues.push(`${failedPolicies} live channel policies did not save`);
			try {
				await osApi.tedis.syncConfig({ tediId });
			} catch {
				issues.push("runtime config sync did not finish");
			}
			return issues;
		},
		onSuccess: async (issues) => {
			await invalidateTedi();
			if (issues.length) {
				toast.warning(
					`Channels saved with partial outcomes: ${issues.join("; ")}`,
				);
			} else {
				toast.success("Channels saved and synced");
			}
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Channel metadata did not save")),
	});

	const testChannelToken = useMutation({
		mutationFn: ({
			channel,
			token,
		}: {
			channel: ManagedChannel;
			token: string;
		}) => osApi.tedis.testChannelToken({ tediId, channel, token }),
		onSuccess: (result, { channel }) => {
			if (result.valid) {
				toast.success(
					`${channel} credential is valid${result.botUsername ? ` for @${result.botUsername}` : ""}`,
				);
			} else {
				toast.error(result.error ?? `${channel} credential is invalid`);
			}
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Credential validation failed")),
	});

	const approvePairing = useMutation({
		mutationFn: (code: string) =>
			osApi.tedis.approvePairing({ tediId, channel: "telegram", code }),
		onSuccess: async (result) => {
			await Promise.all([
				pairingRequests.refetch(),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
			]);
			toast.success(result.message || "Telegram pairing approved");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to approve Telegram pairing")),
	});

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

	const deviceAction = useMutation({
		mutationFn: async ({
			id,
			action,
		}: {
			id: string;
			action: "approve" | "revoke";
		}) => {
			if (action === "approve") {
				await osApi.tedis.approveDevice({ tediId, deviceId: id });
			} else {
				await osApi.tedis.revokeDevice({ tediId, deviceId: id });
			}
		},
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
		onError: (error) =>
			toast.error(errorMessage(error, "Device action failed")),
	});

	const addDomain = useMutation({
		mutationFn: (value: z.output<typeof customDomainSchema>) =>
			osApi.tedis.addCustomDomain({ tediId, hostname: value.hostname }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() });
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to add domain")),
	});

	const removeDomain = useMutation({
		mutationFn: (domainId: string) =>
			osApi.tedis.removeCustomDomain({ tediId, domainId }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
	});

	const resetSandbox = useMutation({
		mutationFn: () =>
			osApi.tedis.resetSandbox({
				tediId,
				reason: "Operator requested non-force workstation reset",
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() });
			toast.success(
				"Workstation sandbox reset; next wake creates a fresh lease",
			);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Safe sandbox reset failed")),
	});

	const {
		requireStepUp: requireRotateStepUp,
		StepUpDialog: RotateStepUpDialog,
	} = useStepUpAuth({
		title: "Confirm access-key rotation",
		description:
			"Rotating replaces the tedi identity credential and refreshes runtime configuration.",
		onFailure: (message) => toast.error(message),
	});
	const rotateAccessKey = useMutation({
		mutationFn: (token: string) =>
			getAuthenticatedOsApi(token).tedis.rotateAccessKey({ tediId }),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tediSecrets() }),
			]);
			toast.success("Tedi access key rotated and runtime config refreshed");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to rotate tedi access key")),
	});

	const retire = useMutation({
		mutationFn: () => osApi.tedis.delete({ tediId }),
		onSuccess: async () => {
			await invalidateTedi();
			toast.success("Tedi retired; cognitive history was retained");
			navigate({ to: "/team", search: { tab: "tedis", page: 1 } });
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to retire tedi")),
	});

	if (tedi.isPending)
		return <p className="text-kumo-subtle">Loading settings…</p>;
	if (tedi.isError) {
		return <p className="text-kumo-danger">Tedi settings are unavailable.</p>;
	}

	const assignedAppIds = new Set(
		(assignments.data?.data ?? []).map((assignment) => assignment.appId),
	);
	const appNames = new Map(
		(apps.data?.data ?? []).map((app) => [app.id, app.name]),
	);

	return (
		<div className="space-y-6">
			<div>
				<Text as="h2" role="title" weight="semibold">
					Settings
				</Text>
				<Text role="body" tone="secondary">
					Governed identity, runtime, credentials, devices, domains, and
					lifecycle.
				</Text>
			</div>

			{!canManage ? (
				<p className="text-kumo-subtle text-sm" role="note">
					{TEDIS_MANAGE_DENIED_REASON}
				</p>
			) : null}

			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Identity & personality</CardTitle>
					</CardHeader>
					<CardContent>
						<IdentitySettingsForm
							values={{
								displayName: tedi.data.displayName ?? "",
								personality: tedi.data.personality ?? "",
								language: tedi.data.language ?? "en",
								timezone: tedi.data.timezone ?? "UTC",
							}}
							disabled={!canManage || update.isPending}
							onSave={(value) =>
								update.mutate({
									tediId,
									displayName: value.displayName || null,
									personality: value.personality || null,
									language: value.language,
									timezone: value.timezone,
								})
							}
						/>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Model & runtime</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<ModelSettingsForm
							value={selectedModel}
							models={models.data?.models ?? []}
							disabled={!canManage || update.isPending}
							onSave={(value) =>
								update.mutate({
									tediId,
									runtimeOverrides: modelOverride(
										tedi.data.runtimeOverrides,
										value.model,
									),
								})
							}
						/>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								disabled={!canManage || run.isPending}
								onClick={() => run.mutate("wake")}
							>
								Wake
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!canManage || run.isPending}
								onClick={() => run.mutate("recover")}
							>
								Recover wake
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!canManage || run.isPending}
								onClick={() => run.mutate("sync")}
							>
								<ArrowsClockwise className="h-4 w-4" /> Sync config
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!canManage || run.isPending}
								onClick={() => run.mutate("repair")}
							>
								Repair credentials
							</Button>
						</div>
						<Text role="label" tone="secondary">
							Runtime:{" "}
							{runtime.data?.runtimeStatus ??
								tedi.data.runtimeStatus ??
								"unknown"}
							. Restart was removed for Agent-runtime tedis; wake/status are
							canonical.
						</Text>
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Live channels</CardTitle>
				</CardHeader>
				<CardContent className="space-y-5">
					<Text role="body" tone="secondary">
						Saving preserves channel fields owned by the runtime. Credential and
						config-sync failures are reported as partial outcomes.
					</Text>
					<LiveChannelsForm
						values={channelValues}
						canManage={canManage}
						canReadSecrets={canReadSecrets}
						canManageSecrets={canManageSecrets}
						isSaving={saveChannels.isPending}
						isTesting={testChannelToken.isPending}
						onSave={(value) =>
							saveChannels
								.mutateAsync(value)
								.then(() => true)
								.catch(() => false)
						}
						onTest={(channel, token) =>
							testChannelToken.mutate({ channel, token })
						}
					/>
					{(pairingRequests.data?.pending ?? []).length ? (
						<Surface className="space-y-2 p-3">
							<Text role="body" weight="medium">
								Pending Telegram pairings
							</Text>
							{(pairingRequests.data?.pending ?? []).map((request) => (
								<div
									key={request.code}
									className="flex items-center justify-between gap-3"
								>
									<Text role="body">
										{request.senderName ?? request.senderId ?? request.code}
									</Text>
									<Button
										size="sm"
										disabled={!canManage || approvePairing.isPending}
										onClick={() => approvePairing.mutate(request.code)}
									>
										Approve pairing
									</Button>
								</div>
							))}
						</Surface>
					) : null}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Encrypted credentials</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					{!canReadSecrets ? (
						<p className="text-kumo-subtle text-sm" role="note">
							{TEDI_SECRETS_UNKNOWN_REASON}
						</p>
					) : !canManageSecrets ? (
						<p className="text-kumo-subtle text-sm" role="note">
							{TEDI_SECRETS_MANAGE_DENIED_REASON}
						</p>
					) : null}
					<SecretSettingsForm
						disabled={!canManageSecrets || setSecret.isPending}
						onSave={(value) =>
							setSecret
								.mutateAsync(value)
								.then(() => true)
								.catch(() => false)
						}
					/>
					<Surface className="divide-y">
						{(secrets.data?.data ?? []).map((secret) => (
							<div
								key={secret.id}
								className="flex items-center justify-between gap-3 p-3"
							>
								<div>
									<Text as="p" role="body" tone="mono">
										{secret.name}
									</Text>
									<Text role="label" tone="secondary">
										{secret.hint}
									</Text>
								</div>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Delete ${secret.name}`}
									disabled={!canManageSecrets || deleteSecret.isPending}
									onClick={() => deleteSecret.mutate(secret.id)}
								>
									<Trash className="h-4 w-4" />
								</Button>
							</div>
						))}
					</Surface>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>App assignments</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<AppAssignmentForm
						apps={(apps.data?.data ?? []).filter(
							(app) => !assignedAppIds.has(app.id),
						)}
						disabled={!canManage || createAssignment.isPending}
						onSave={(value) =>
							createAssignment
								.mutateAsync(value)
								.then(() => true)
								.catch(() => false)
						}
					/>
					{(assignments.data?.data ?? []).map((assignment) => (
						<Surface
							key={assignment.id}
							className="flex flex-wrap items-center justify-between gap-3 p-3"
						>
							<Text role="body" weight="medium">
								{appNames.get(assignment.appId) ?? assignment.appId}
							</Text>
							<div className="flex items-center gap-2">
								<Select
									value={assignment.role}
									disabled={!canManage || updateAssignmentRole.isPending}
									onValueChange={(value) =>
										value &&
										updateAssignmentRole.mutate({
											assignmentId: assignment.id,
											role: value as TediAppAssignmentRole,
										})
									}
								>
									<SelectTrigger className="w-32" aria-label="Assigned role">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="operator">Operator</SelectItem>
										<SelectItem value="observer">Observer</SelectItem>
									</SelectContent>
								</Select>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Unassign app"
									disabled={!canManage || deleteAssignment.isPending}
									onClick={() => deleteAssignment.mutate(assignment.id)}
								>
									<Trash className="h-4 w-4" />
								</Button>
							</div>
						</Surface>
					))}
				</CardContent>
			</Card>

			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Repository</CardTitle>
					</CardHeader>
					<CardContent>
						<RepositorySettingsForm
							values={{
								repoUrl: tedi.data.repoConfig?.repoUrl ?? "",
								repoBranch: tedi.data.repoConfig?.branch ?? "main",
							}}
							disabled={!canManage || update.isPending}
							onSave={(value) =>
								update.mutate({
									tediId,
									repoConfig: value.repoUrl
										? {
												repoUrl: value.repoUrl,
												branch: value.repoBranch || undefined,
											}
										: null,
								})
							}
						/>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Governance & budgets</CardTitle>
					</CardHeader>
					<CardContent>
						<GovernanceSettingsForm
							values={{
								toolPolicyJson: prettyJson(tedi.data.toolPolicy),
								learningPolicyJson: prettyJson(tedi.data.selfImprovementPolicy),
								budgetsJson: prettyJson(tedi.data.budgets),
								quietHoursJson: prettyJson(tedi.data.quietHours),
							}}
							disabled={!canManage || update.isPending}
							onSave={(value) =>
								update.mutate({
									tediId,
									toolPolicy: JSON.parse(value.toolPolicyJson) as ToolPolicy,
									selfImprovementPolicy: JSON.parse(
										value.learningPolicyJson,
									) as SelfImprovementPolicy,
									budgets: JSON.parse(value.budgetsJson) as TediBudgets,
									quietHours: JSON.parse(value.quietHoursJson) as QuietHours,
								})
							}
						/>
					</CardContent>
				</Card>
			</div>

			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Devices</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						{[
							...(devices.data?.pending ?? []),
							...(devices.data?.paired ?? []),
						].map((device) => (
							<Surface
								key={device.id}
								className="flex items-center justify-between gap-3 p-3"
							>
								<div>
									<Text role="body" weight="medium">
										{device.displayName ?? device.id}
									</Text>
									<Badge variant="outline">{device.status}</Badge>
								</div>
								<Button
									size="sm"
									variant="outline"
									disabled={!canManage || deviceAction.isPending}
									onClick={() =>
										deviceAction.mutate({
											id: device.id,
											action:
												device.status === "pending" ? "approve" : "revoke",
										})
									}
								>
									{device.status === "pending" ? "Approve" : "Revoke"}
								</Button>
							</Surface>
						))}
						{(devices.data?.pending.length ?? 0) +
							(devices.data?.paired.length ?? 0) ===
						0 ? (
							<Text role="body" tone="secondary">
								No observed devices.
							</Text>
						) : null}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Custom domains</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<Text role="body" tone="secondary">
							Adding a hostname creates a pending Tedix record only. DNS and
							certificate provisioning are separate steps.
						</Text>
						<CustomDomainForm
							disabled={!canManage || addDomain.isPending}
							onSave={(value) =>
								addDomain
									.mutateAsync(value)
									.then(() => true)
									.catch(() => false)
							}
						/>
						{(domains.data?.data ?? []).map((domain) => (
							<Surface
								key={domain.id}
								className="flex items-center justify-between gap-3 p-3"
							>
								<div>
									<Text role="body" weight="medium">
										{domain.hostname}
									</Text>
									<Badge variant="outline">{domain.status ?? "pending"}</Badge>
								</div>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Remove ${domain.hostname}`}
									disabled={!canDelete || removeDomain.isPending}
									title={!canDelete ? TEDIS_DELETE_DENIED_REASON : undefined}
									onClick={() => removeDomain.mutate(domain.id)}
								>
									<Trash className="h-4 w-4" />
								</Button>
							</Surface>
						))}
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="text-kumo-danger">Lifecycle</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-wrap gap-3">
					<Button
						variant="outline"
						disabled={!canManage || rotateAccessKey.isPending}
						onClick={() =>
							requireRotateStepUp((token) => rotateAccessKey.mutate(token))
						}
					>
						Rotate identity access key
					</Button>
					<AlertDialog>
						<AlertDialogTrigger
							render={
								<Button
									variant="outline"
									disabled={!canDelete || resetSandbox.isPending}
									title={!canDelete ? TEDIS_DELETE_DENIED_REASON : undefined}
								/>
							}
						>
							Reset workstation sandbox
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									Reset this workstation sandbox?
								</AlertDialogTitle>
								<AlertDialogDescription>
									This non-force recovery destroys the current workstation
									sandbox and is blocked unless a healthy backup exists. It does
									not force a reset or delete the tedi's cognitive history.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction onClick={() => resetSandbox.mutate()}>
									Reset safely
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
					<AlertDialog>
						<AlertDialogTrigger
							render={
								<Button
									variant="destructive"
									disabled={!canDelete || retire.isPending}
									title={!canDelete ? TEDIS_DELETE_DENIED_REASON : undefined}
								/>
							}
						>
							Retire Tedi
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Retire this tedi?</AlertDialogTitle>
								<AlertDialogDescription>
									The worker identity and runtime stop immediately. Memory,
									rationale, skills, artifacts, growth history, and audit
									evidence remain retained.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									disabled={retire.isPending}
									onClick={() => retire.mutate()}
								>
									Retire tedi
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</CardContent>
			</Card>
			<RotateStepUpDialog />
		</div>
	);
}
