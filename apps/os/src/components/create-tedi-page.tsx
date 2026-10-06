/** Launch Tedi — Tedix OS fast-path creation flow for new digital workers. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	ArrowsClockwise,
	CaretDown,
	ChatCircle,
	CheckCircle,
	RocketLaunch,
	ShieldWarning,
	XCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import * as z from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { toast } from "@/components/kumo/toast";
import { Text } from "@/components/kumo/text";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { Loader } from "@/components/kumo/loader";
import {
	Page,
	PageActions,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import {
	KumoSelect,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { SensitiveInput } from "@/components/kumo/sensitive-input";
import { Switch } from "@/components/kumo/switch";
import { Surface } from "@/components/kumo/surface";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import {
	modelCatalogQueryOptions,
	osQuery,
	osQueryKeys,
	tediPairingRequestsQueryOptions,
} from "@/lib/os-query-options";
import { initialModelRef, modelsForNewSelection } from "@/lib/model-selection";
import {
	TEDIS_CREATE_DENIED_REASON,
	useCanCreateTedis,
} from "@/lib/tedi-permissions";

export type CreateTediChannel = "none" | "telegram" | "webchat";
type TestableChannel = "telegram";
type TelegramDmPolicy = "pairing" | "open" | "disabled";
type TelegramGroupPolicy = "open" | "allowlist" | "disabled";

type ValidationResult = {
	valid: boolean;
	botUsername?: string;
	botId?: string;
	error?: string;
};

type ValidationState = Partial<Record<TestableChannel, ValidationResult>>;

type TelegramPairingHandoff = {
	tediId: string;
	botUsername?: string;
};

interface LaunchState {
	name: string;
	displayName: string;
	/** Catalog model ref; empty until the catalog resolves an allowed default. */
	model: string;
	channel: CreateTediChannel;
	telegramBotToken: string;
	telegramDmPolicy: TelegramDmPolicy;
	telegramGroupPolicy: TelegramGroupPolicy;
	telegramRequireMention: boolean;
	telegramGroupAllowFrom: string;
	personality: string;
	language: string;
	timezone: string;
}

const createTediSchema = z.object({
	name: z.string().trim().min(1, "Enter a tedi name."),
	displayName: z.string(),
	model: z.string().min(1, "Choose a model."),
	channel: z.enum(["none", "telegram", "webchat"]),
	telegramBotToken: z.string(),
	telegramDmPolicy: z.enum(["pairing", "open", "disabled"]),
	telegramGroupPolicy: z.enum(["open", "allowlist", "disabled"]),
	telegramRequireMention: z.boolean(),
	telegramGroupAllowFrom: z.string(),
	personality: z.string(),
	language: z.string().min(1),
	timezone: z.string().min(1),
});

const INITIAL_STATE: LaunchState = {
	name: "",
	displayName: "",
	// Empty until the contract-backed catalog resolves an allowed default: the
	// launcher must never pre-select a ref it has not verified is selectable.
	model: "",
	channel: "telegram",
	telegramBotToken: "",
	telegramDmPolicy: "pairing",
	telegramGroupPolicy: "open",
	telegramRequireMention: true,
	telegramGroupAllowFrom: "",
	personality: "",
	language: "en",
	timezone: "Europe/Berlin",
};

const LANGUAGES = [
	{ value: "en", label: "English" },
	{ value: "de", label: "Deutsch" },
	{ value: "pl", label: "Polski" },
	{ value: "es", label: "Español" },
	{ value: "fr", label: "Français" },
];

const TIMEZONES = [
	"Europe/Berlin",
	"Europe/London",
	"Europe/Warsaw",
	"America/New_York",
	"America/Los_Angeles",
	"Asia/Tokyo",
	"UTC",
];

async function setSecret(tediId: string, name: string, value: string) {
	await osApi.tediSecrets.set({ tediId, name, value });
}

export function buildRuntimeModelOverrides(model: string) {
	return {
		agents: {
			defaults: {
				model: {
					primary: model,
				},
			},
		},
	};
}

export function parseIdentifierList(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function buildTelegramConfig(state: LaunchState) {
	return {
		dmPolicy: state.telegramDmPolicy,
		groupPolicy: state.telegramGroupPolicy,
		requireMention: state.telegramRequireMention,
		...(state.telegramGroupPolicy === "allowlist"
			? { groupAllowFrom: parseIdentifierList(state.telegramGroupAllowFrom) }
			: {}),
	};
}

function buildChannelMetadata(state: LaunchState, validation: ValidationState) {
	const channelInfo =
		state.channel === "telegram" ? validation.telegram : undefined;

	switch (state.channel) {
		case "telegram":
			return {
				telegram: {
					enabled: true,
					...(channelInfo?.valid
						? {
								botUsername: channelInfo.botUsername,
								botId: channelInfo.botId,
							}
						: {}),
				},
			};
		default:
			return undefined;
	}
}

export function modelDenialText(model: {
	deniedBy: { detail: string } | null;
}): string | null {
	return model.deniedBy?.detail ?? null;
}

export function CreateTediPage({
	channel,
	advanced,
	onChannelChange,
	onAdvancedChange,
}: {
	channel: CreateTediChannel;
	advanced: boolean;
	onChannelChange: (channel: CreateTediChannel) => void;
	onAdvancedChange: (advanced: boolean) => void;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const canCreateTedis = useCanCreateTedis();
	const form = useZodForm({
		schema: createTediSchema,
		defaultValues: { ...INITIAL_STATE, channel },
		onSubmit: () => handleLaunch(),
	});
	const state = useStore(form.store, (snapshot) => snapshot.values);
	const [error, setError] = useState("");
	const [validationResults, setValidationResults] = useState<ValidationState>(
		{},
	);
	const [telegramHandoff, setTelegramHandoff] =
		useState<TelegramPairingHandoff | null>(null);

	const parsedTelegramAllowlist = useMemo(
		() => parseIdentifierList(state.telegramGroupAllowFrom),
		[state.telegramGroupAllowFrom],
	);
	const invalidTelegramAllowlist = parsedTelegramAllowlist.filter(
		(value) => !/^\d+$/.test(value),
	);

	// Organization-scope catalog: no tedi exists yet, so the per-tedi filters are
	// deliberately absent from the chain rather than passing over an unread input.
	const modelCatalog = useQuery({
		...modelCatalogQueryOptions(),
		staleTime: 60_000,
	});
	useEffect(() => {
		if (form.state.values.channel !== channel) {
			form.setFieldValue("channel", channel);
		}
	}, [channel]);
	const models = useMemo(
		() => modelsForNewSelection(modelCatalog.data?.models ?? []),
		[modelCatalog.data],
	);
	const selectedModel = models.find((model) => model.ref === state.model);
	// Seed the picker from the projection's own effective routing answer, falling
	// back to the first ALLOWED model. Never a hardcoded ref.
	useEffect(() => {
		if (state.model || models.length === 0) return;
		const fallback = initialModelRef(
			models,
			modelCatalog.data?.routing.modelRef,
		);
		if (fallback) form.setFieldValue("model", fallback);
	}, [models, modelCatalog.data, state.model]);
	const secretCount = state.telegramBotToken.trim().length > 0 ? 1 : 0;

	const channelPresenceReady =
		state.channel === "telegram"
			? state.telegramBotToken.trim().length > 0 &&
				(state.telegramGroupPolicy !== "allowlist" ||
					parsedTelegramAllowlist.length > 0)
			: true;

	const channelValidationReady =
		state.channel === "telegram"
			? validationResults.telegram?.valid === true
			: true;

	const canLaunch =
		canCreateTedis &&
		state.name.trim().length > 0 &&
		channelPresenceReady &&
		channelValidationReady &&
		invalidTelegramAllowlist.length === 0;

	const validateTokenMutation = useMutation({
		mutationFn: async (params: { channel: TestableChannel; token: string }) => {
			return osApi.tedis.validateChannelToken({
				channel: params.channel,
				token: params.token,
			});
		},
		onSuccess: (data, variables) => {
			setValidationResults((prev) => ({ ...prev, [variables.channel]: data }));
		},
	});

	const pairingQuery = useQuery({
		...tediPairingRequestsQueryOptions(telegramHandoff?.tediId ?? ""),
		enabled: Boolean(telegramHandoff?.tediId),
		refetchInterval: 5000,
		staleTime: 2000,
	});

	const approvePairingMutation = useMutation({
		mutationFn: async (code: string) => {
			if (!telegramHandoff) throw new Error("No Telegram handoff is active");
			return osApi.tedis.approvePairing({
				tediId: telegramHandoff.tediId,
				channel: "telegram",
				code,
			});
		},
		onSuccess: (data) => {
			toast.success(data.message || "Pairing approved");
			pairingQuery.refetch();
		},
		onError: (mutationError) => {
			toast.error(
				mutationError instanceof Error
					? mutationError.message
					: "Failed to approve pairing",
			);
		},
	});

	const createMutation = useMutation({
		...osQuery.tedis.create.mutationOptions(),
		onSuccess: async (data) => {
			const tediId = data.id;
			const postLaunchIssues: string[] = [];

			const secretWrites: Promise<void>[] = [];
			if (state.channel === "telegram" && state.telegramBotToken.trim()) {
				secretWrites.push(
					setSecret(
						tediId,
						"TELEGRAM_BOT_TOKEN",
						state.telegramBotToken.trim(),
					),
				);
			}
			const secretResults = await Promise.allSettled(secretWrites);
			const secretFailures = secretResults.filter(
				(result) => result.status === "rejected",
			);
			if (secretFailures.length > 0) {
				postLaunchIssues.push(
					`${secretFailures.length} secret${secretFailures.length === 1 ? "" : "s"} failed to save`,
				);
			}

			const channelMetadata = buildChannelMetadata(state, validationResults);
			if (channelMetadata) {
				try {
					await osApi.tedis.update({
						tediId,
						channels: channelMetadata,
					});
				} catch {
					postLaunchIssues.push("channel metadata did not save");
				}
			}

			if (state.channel === "telegram") {
				try {
					await osApi.tedis.updateChannelConfig({
						tediId,
						channel: "telegram",
						config: buildTelegramConfig(state),
					});
				} catch {
					postLaunchIssues.push("Telegram settings did not save");
				}
			}

			try {
				await osApi.tedis.syncConfig({ tediId });
			} catch {
				postLaunchIssues.push("config sync did not finish");
			}

			try {
				const wakeResult = await osApi.tedis.wake({ tediId });
				if (!wakeResult.ready && wakeResult.status !== "running") {
					postLaunchIssues.push("runtime is still warming up");
				}
			} catch {
				postLaunchIssues.push("runtime wake-up did not confirm readiness");
			}

			await Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tediSecrets() }),
			]);

			if (postLaunchIssues.length > 0) {
				toast.warning(`Tedi launched, but ${postLaunchIssues.join("; ")}.`);
			}

			if (
				state.channel === "telegram" &&
				state.telegramDmPolicy === "pairing"
			) {
				const botUsername = validationResults.telegram?.botUsername;
				setTelegramHandoff({ tediId, botUsername });
				if (postLaunchIssues.length === 0) {
					toast.success(
						botUsername
							? `Tedi launched. Send a Telegram message to @${botUsername} to create your first pairing request.`
							: "Tedi launched. Send your Telegram bot a message to create your first pairing request.",
					);
				}
				return;
			}

			if (postLaunchIssues.length === 0) {
				if (state.channel === "telegram") {
					toast.success(
						validationResults.telegram?.botUsername
							? `Tedi launched and Telegram is ready via @${validationResults.telegram.botUsername}.`
							: "Tedi launched and Telegram is ready.",
					);
				} else {
					toast.success("Tedi launched");
				}
			}

			navigate({
				to: "/team/$tediId",
				params: { tediId },
			});
		},
		onError: (mutationError) => {
			setError(mutationError.message || "Failed to launch tedi");
		},
	});

	const runValidation = (channel: TestableChannel, token: string) => {
		if (!token.trim()) return;
		validateTokenMutation.mutate({ channel, token: token.trim() });
	};

	const selectedValidation =
		state.channel === "telegram" ? validationResults.telegram : undefined;

	const handleLaunch = () => {
		setError("");
		createMutation.mutate({
			name: state.name.trim(),
			displayName: state.displayName.trim() || undefined,
			personality: state.personality.trim() || undefined,
			language: state.language,
			timezone: state.timezone,
			runtimeOverrides: state.model
				? buildRuntimeModelOverrides(state.model)
				: undefined,
		});
	};

	if (telegramHandoff) {
		const pending = pairingQuery.data?.pending ?? [];
		return (
			<Page width="md">
				<PageHeader>
					<PageHeading>
						<PageTitle>Connect Telegram</PageTitle>
						<PageDescription>
							Your tedi is live. Finish onboarding by approving the first
							Telegram pairing request.
						</PageDescription>
					</PageHeading>
				</PageHeader>

				<div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
					<Card>
						<CardHeader>
							<CardTitle>Telegram Pairing</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							<Surface className="p-4">
								<Text role="body" weight="medium">
									Step 1
								</Text>
								<Text role="body" tone="secondary" className="mt-1">
									Open Telegram and send a message to{" "}
									<Text as="span" weight="medium" className="text-kumo-default">
										{telegramHandoff.botUsername
											? `@${telegramHandoff.botUsername}`
											: "your bot"}
									</Text>
									to generate a pairing request.
								</Text>
							</Surface>

							<div className="flex items-center justify-between">
								<div>
									<Text role="body" weight="medium">
										Pending requests
									</Text>
									<Text role="label" tone="secondary">
										We poll every few seconds while you stay on this screen.
									</Text>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={() => pairingQuery.refetch()}
									disabled={pairingQuery.isFetching}
									icon={
										pairingQuery.isFetching ? (
											<Loader aria-label="Refreshing" size={16} />
										) : (
											<ArrowsClockwise className="h-4 w-4" />
										)
									}
								>
									Refresh
								</Button>
							</div>

							{pairingQuery.isLoading ? (
								<div className="flex items-center gap-2 text-kumo-subtle type-tedix-body">
									<Loader aria-label="Checking" size={16} />
									Checking for pairing requests…
								</div>
							) : pairingQuery.isError ? (
								<Surface className="border-kumo-danger p-4" role="alert">
									<Text
										role="body"
										weight="medium"
										className="text-kumo-danger"
									>
										Pairing requests could not be loaded.
									</Text>
									<Text role="label" tone="secondary" className="mt-1">
										The request status is unknown. Refresh to try again.
									</Text>
								</Surface>
							) : pending.length === 0 ? (
								<Surface className="border-dashed p-4 text-kumo-subtle type-tedix-body">
									No pairing requests yet. Send the bot a DM, then refresh if
									needed.
								</Surface>
							) : (
								<div className="space-y-3">
									{pending.map((request) => (
										<Surface
											key={request.code}
											className="flex items-center justify-between p-3"
										>
											<div className="min-w-0">
												<div className="flex items-center gap-2">
													<Text
														as="code"
														role="label"
														tone="mono"
														weight="semibold"
													>
														{request.code}
													</Text>
													{request.senderName ? (
														<Text
															as="span"
															role="label"
															tone="secondary"
															className="truncate"
														>
															{request.senderName}
														</Text>
													) : null}
												</div>
												{request.senderId ? (
													<Text role="label" tone="secondary" className="mt-1">
														Telegram ID: {request.senderId}
													</Text>
												) : null}
											</div>
											<Button
												size="sm"
												onClick={() =>
													approvePairingMutation.mutate(request.code)
												}
												disabled={approvePairingMutation.isPending}
											>
												Approve
											</Button>
										</Surface>
									))}
								</div>
							)}
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>What happens next</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3 text-sm">
							<div className="flex items-start gap-2">
								<ChatCircle className="mt-0.5 h-4 w-4 text-kumo-brand" />
								<Text tone="secondary">
									Once approved, that Telegram user can DM the tedi immediately.
								</Text>
							</div>
							<div className="flex items-start gap-2">
								<CheckCircle className="mt-0.5 h-4 w-4 text-kumo-success" />
								<Text tone="secondary">
									You can finish the rest of channel tuning later in Settings →
									Channels.
								</Text>
							</div>
							<Button
								variant="outline"
								className="w-full"
								onClick={() =>
									navigate({
										to: "/team/$tediId",
										params: { tediId: telegramHandoff.tediId },
									})
								}
							>
								Open Tedi
							</Button>
						</CardContent>
					</Card>
				</div>
			</Page>
		);
	}

	function ChannelTestButton({
		channel,
		token,
	}: {
		channel: TestableChannel;
		token: string;
	}) {
		const result = validationResults[channel];
		const isLoading =
			validateTokenMutation.isPending &&
			validateTokenMutation.variables?.channel === channel;

		return (
			<div className="mt-2 flex items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="xs"
					disabled={!token.trim() || isLoading}
					onClick={() => runValidation(channel, token)}
				>
					{isLoading ? (
						<>
							<Loader aria-label="Testing" className="mr-1" size={12} />
							Testing…
						</>
					) : (
						"Test Connection"
					)}
				</Button>
				{result ? (
					<Text
						as="span"
						role="label"
						className={`flex items-center gap-1 ${result.valid ? "text-kumo-success" : "text-kumo-danger"}`}
					>
						{result.valid ? (
							<>
								<CheckCircle className="h-3.5 w-3.5" />
								Connected as{" "}
								{result.botUsername ? `@${result.botUsername}` : "verified bot"}
							</>
						) : (
							<>
								<XCircle className="h-3.5 w-3.5" />
								{result.error}
							</>
						)}
					</Text>
				) : null}
			</div>
		);
	}

	return (
		<Page width="md">
			<PageHeader>
				<PageHeading>
					<Link
						to="/team"
						search={{ tab: "tedis", page: 1 }}
						className="text-kumo-subtle type-tedix-body hover:text-kumo-default"
					>
						← Back to Tedis
					</Link>
					<PageTitle className="mt-3">Launch tedi</PageTitle>
					<PageDescription>
						Create a new remote tedi with the shared platform model stack and
						get it online fast.
					</PageDescription>
				</PageHeading>
				<PageActions>
					<Badge variant="secondary">Fast path</Badge>
				</PageActions>
			</PageHeader>

			<form
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					if (canLaunch && !createMutation.isPending) void form.handleSubmit();
				}}
				className="min-w-0"
			>
				<Card>
					<CardHeader>
						<CardTitle>Launch Configuration</CardTitle>
					</CardHeader>
					<CardContent className="space-y-6">
						<Input
							label="Tedi name"
							description="Required. The stable slug is generated from this name at launch."
							name="name"
							required
							value={state.name}
							onChange={(e) => form.setFieldValue("name", e.target.value)}
							placeholder="Support tedi"
						/>

						<Input
							label="Display name"
							description="Optional friendly name shown throughout Tedix."
							name="displayName"
							value={state.displayName}
							onChange={(e) =>
								form.setFieldValue("displayName", e.target.value)
							}
							placeholder="Optional friendly name"
						/>

						<div className="grid gap-4 md:grid-cols-2">
							<div className="min-w-0 space-y-2">
								<KumoSelect<string>
									label="Model"
									description="Choose an allowed model from the organization catalog."
									className="w-full"
									value={state.model}
									disabled={models.length === 0}
									onValueChange={(value) =>
										form.setFieldValue("model", value ?? "")
									}
								>
									{models.map((model) => (
										<KumoSelect.Option
											key={model.ref}
											value={model.ref}
											disabled={!model.allowed}
										>
											{model.label}
											{model.allowed ? "" : " — unavailable"}
										</KumoSelect.Option>
									))}
								</KumoSelect>
								{modelCatalog.isPending ? (
									<Text role="label" tone="secondary">
										Loading the model catalog…
									</Text>
								) : modelCatalog.error ? (
									<Text role="label" className="text-kumo-danger">
										The model catalog could not be read, so no model can be
										selected.
									</Text>
								) : selectedModel && !selectedModel.allowed ? (
									<Text role="label" className="text-kumo-danger">
										{modelDenialText(selectedModel)}
									</Text>
								) : null}
							</div>

							<div className="min-w-0">
								<KumoSelect<CreateTediChannel>
									label="Connection"
									description="Connect a channel now or launch without one."
									className="w-full"
									value={state.channel}
									onValueChange={(value) => {
										if (!value) return;
										const next = value as CreateTediChannel;
										form.setFieldValue("channel", next);
										onChannelChange(next);
									}}
								>
									<KumoSelect.Option value="telegram">
										Telegram
									</KumoSelect.Option>
									<KumoSelect.Option value="webchat">
										Webchat only
									</KumoSelect.Option>
									<KumoSelect.Option value="none">
										Launch now, connect later
									</KumoSelect.Option>
								</KumoSelect>
							</div>
						</div>

						{state.channel === "telegram" ? (
							<Surface className="space-y-4 p-4">
								<div className="space-y-2">
									<Label htmlFor="telegramBotToken">Telegram bot token</Label>
									<SensitiveInput
										id="telegramBotToken"
										value={state.telegramBotToken}
										onValueChange={(value) => {
											form.setFieldValue("telegramBotToken", value);
											setValidationResults((prev) => ({
												...prev,
												telegram: undefined,
											}));
										}}
										placeholder="123456:ABC-DEF..."
										className="font-mono"
									/>
									<Text role="label" tone="secondary">
										Required for immediate Telegram connectivity.
									</Text>
									<ChannelTestButton
										channel="telegram"
										token={state.telegramBotToken}
									/>
								</div>

								<div className="grid gap-4 md:grid-cols-2">
									<div className="space-y-2">
										<Label htmlFor="telegram-dm-policy">DM access</Label>
										<Select
											value={state.telegramDmPolicy}
											onValueChange={(value) =>
												form.setFieldValue(
													"telegramDmPolicy",
													value as TelegramDmPolicy,
												)
											}
										>
											<SelectTrigger id="telegram-dm-policy">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="pairing">
													Pairing (recommended)
												</SelectItem>
												<SelectItem value="open">Open DMs</SelectItem>
												<SelectItem value="disabled">Disable DMs</SelectItem>
											</SelectContent>
										</Select>
										<Text role="label" tone="secondary">
											{state.telegramDmPolicy === "pairing"
												? "Users must DM the bot and wait for you to approve their pairing request."
												: state.telegramDmPolicy === "open"
													? "Anyone who finds the bot can start chatting with your tedi."
													: "Direct messages are disabled until you change this later."}
										</Text>
									</div>

									<div className="space-y-2">
										<Label htmlFor="telegram-group-policy">Group access</Label>
										<Select
											value={state.telegramGroupPolicy}
											onValueChange={(value) =>
												form.setFieldValue(
													"telegramGroupPolicy",
													value as TelegramGroupPolicy,
												)
											}
										>
											<SelectTrigger id="telegram-group-policy">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="open">Open in groups</SelectItem>
												<SelectItem value="allowlist">
													Allowlist only
												</SelectItem>
												<SelectItem value="disabled">Disable groups</SelectItem>
											</SelectContent>
										</Select>
										<Text role="label" tone="secondary">
											{state.telegramGroupPolicy === "open"
												? "Anyone in a group can interact with the tedi."
												: state.telegramGroupPolicy === "allowlist"
													? "Only listed Telegram user IDs can use the tedi in groups."
													: "The tedi ignores Telegram groups."}
										</Text>
									</div>
								</div>

								<Surface className="flex items-center justify-between gap-4 px-3 py-2">
									<div>
										<Label
											htmlFor="telegram-require-mention"
											className="font-medium"
										>
											Require @mention in groups
										</Label>
										<Text role="label" tone="secondary">
											Recommended for busy chats and safer launch defaults.
										</Text>
									</div>
									<Switch
										id="telegram-require-mention"
										checked={state.telegramRequireMention}
										onCheckedChange={(checked) =>
											form.setFieldValue("telegramRequireMention", checked)
										}
										size="sm"
									/>
								</Surface>

								{!state.telegramRequireMention &&
								state.telegramGroupPolicy !== "disabled" ? (
									<Alert variant="warning">
										<ShieldWarning aria-hidden />
										<AlertTitle>Telegram privacy mode required</AlertTitle>
										<AlertDescription>
											For the bot to see full group traffic, disable privacy
											mode in @BotFather or make the bot a group admin, then
											re-add it to the group.
										</AlertDescription>
									</Alert>
								) : null}

								{state.telegramGroupPolicy === "allowlist" ? (
									<div className="space-y-2">
										<Label htmlFor="telegramGroupAllowFrom">
											Allowed Telegram user IDs
										</Label>
										<Textarea
											id="telegramGroupAllowFrom"
											value={state.telegramGroupAllowFrom}
											onChange={(e) =>
												form.setFieldValue(
													"telegramGroupAllowFrom",
													e.target.value,
												)
											}
											placeholder={"123456789\n987654321"}
											rows={3}
											className="font-mono"
										/>
										<div className="space-y-1 text-kumo-subtle type-tedix-label">
											<p>
												Enter one numeric Telegram user ID per line. Required
												when group access uses allowlist.
											</p>
											<p>Parsed IDs: {parsedTelegramAllowlist.length}</p>
											{invalidTelegramAllowlist.length > 0 ? (
												<Text role="label" tone="error">
													Invalid entries: {invalidTelegramAllowlist.join(", ")}
												</Text>
											) : null}
										</div>
									</div>
								) : null}
							</Surface>
						) : null}

						{state.channel === "webchat" ? (
							<Text role="body" tone="secondary">
								No extra secrets needed — the tedi launches with built-in
								webchat only.
							</Text>
						) : null}

						{state.channel === "none" ? (
							<Text role="body" tone="secondary">
								Launch now with no channel token. You can connect Telegram or
								pair devices later.
							</Text>
						) : null}

						<Collapsible open={advanced} onOpenChange={onAdvancedChange}>
							<CollapsibleTrigger className="flex min-h-9 w-full items-center gap-2 rounded-lg border border-kumo-line px-3 py-2 text-left hover:bg-kumo-tint coarse:min-h-11">
								<Text as="span" role="body" weight="medium">
									Advanced options
								</Text>
								<CaretDown
									className={`ml-auto h-4 w-4 text-kumo-subtle transition-transform ${advanced ? "rotate-180" : "rotate-0"}`}
								/>
							</CollapsibleTrigger>
							<CollapsibleContent className="pt-4">
								<div className="space-y-4">
									<Textarea
										label="Personality"
										description="Optional working style and tone; authority is governed separately."
										value={state.personality}
										onChange={(e) =>
											form.setFieldValue("personality", e.target.value)
										}
										placeholder="Optional SOUL.md-style personality prompt"
										rows={5}
									/>
									<div className="grid gap-4 md:grid-cols-2">
										<KumoSelect<string>
											label="Language"
											description="Preferred response language."
											className="w-full"
											value={state.language}
											onValueChange={(value) =>
												value && form.setFieldValue("language", value)
											}
										>
											{LANGUAGES.map((language) => (
												<KumoSelect.Option
													key={language.value}
													value={language.value}
												>
													{language.label}
												</KumoSelect.Option>
											))}
										</KumoSelect>
										<KumoSelect<string>
											label="Timezone"
											description="Local-time context for schedules and coordination."
											className="w-full"
											value={state.timezone}
											onValueChange={(value) =>
												value && form.setFieldValue("timezone", value)
											}
										>
											{TIMEZONES.map((timezone) => (
												<KumoSelect.Option key={timezone} value={timezone}>
													{timezone}
												</KumoSelect.Option>
											))}
										</KumoSelect>
									</div>
								</div>
							</CollapsibleContent>
						</Collapsible>

						<section
							aria-labelledby="launch-readiness-title"
							className="grid gap-4 border-kumo-line border-t pt-5 sm:grid-cols-2"
						>
							<div className="sm:col-span-2">
								<Text
									as="h2"
									id="launch-readiness-title"
									role="section"
									weight="semibold"
								>
									Ready to launch?
								</Text>
								<Text role="body" tone="secondary" className="mt-1">
									Confirm the model, connection, and authority checks before
									creating this durable worker.
								</Text>
							</div>
							<div className="grid gap-3">
								<div>
									<Text role="label" tone="secondary">
										Model
									</Text>
									<Text weight="medium">
										{selectedModel?.label ?? (state.model || "Not selected")}
									</Text>
								</div>
								<div>
									<Text role="label" tone="secondary">
										Connection
									</Text>
									<Text weight="medium" className="capitalize">
										{state.channel === "none" ? "Connect later" : state.channel}
									</Text>
									{state.channel === "telegram" ? (
										<Text role="label" tone="secondary" className="mt-1">
											DMs: {state.telegramDmPolicy} · Groups:{" "}
											{state.telegramGroupPolicy} · Mention-only:{" "}
											{state.telegramRequireMention ? "on" : "off"}
										</Text>
									) : null}
								</div>
							</div>
							<div className="grid gap-3">
								<div>
									<Text role="label" tone="secondary">
										Readiness
									</Text>
									<div className="mt-1 space-y-1 text-kumo-subtle type-tedix-label">
										<p>Name: {state.name.trim() ? "ready" : "missing"}</p>
										<p>
											Channel inputs:{" "}
											{channelPresenceReady ? "ready" : "needs attention"}
										</p>
										<p>
											Token test:{" "}
											{state.channel === "none" || state.channel === "webchat"
												? "not required"
												: selectedValidation?.valid
													? "verified"
													: "not verified"}
										</p>
									</div>
								</div>
								<div>
									<Text role="label" tone="secondary">
										Secrets to store
									</Text>
									<Text weight="medium">{secretCount}</Text>
								</div>
							</div>
						</section>

						{error ? (
							<Text role="body" tone="error" as="p">
								{error}
							</Text>
						) : null}

						{!canCreateTedis ? (
							<p className="text-kumo-subtle text-sm" role="note">
								{TEDIS_CREATE_DENIED_REASON}
							</p>
						) : null}

						<Button
							type="submit"
							disabled={!canLaunch || createMutation.isPending}
							className="w-full"
							title={!canCreateTedis ? TEDIS_CREATE_DENIED_REASON : undefined}
						>
							<RocketLaunch className="mr-2 h-4 w-4" />
							{createMutation.isPending ? "Launching..." : "Launch tedi"}
						</Button>
					</CardContent>
				</Card>
			</form>
		</Page>
	);
}
