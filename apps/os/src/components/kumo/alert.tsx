import { Banner } from "@cloudflare/kumo/components/banner";
import { WarningCircle } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { errorMessage, orpcErrorCode } from "../../lib/orpc-error";
import { Button } from "./button";
import { cn } from "../../lib/utils";

type AlertVariant = "default" | "destructive" | "info" | "warning";

const ALERT_VARIANTS = {
	default: "secondary",
	destructive: "error",
	info: "default",
	warning: "alert",
} as const;

type AlertProps = Omit<
	ComponentProps<typeof Banner>,
	"description" | "title" | "variant"
> & {
	action?: ReactNode;
	description?: ReactNode;
	icon?: ReactNode;
	title?: string;
	variant?: AlertVariant;
};

/** Kumo Banner behavior with Tedix's existing compositional alert anatomy. */
function Alert({
	children,
	className,
	variant = "default",
	...props
}: AlertProps) {
	return (
		<Banner
			data-slot="alert"
			data-variant={variant}
			role={variant === "destructive" ? "alert" : undefined}
			variant={ALERT_VARIANTS[variant]}
			className={cn(
				"group/alert relative grid w-full gap-0.5 text-left has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 has-data-[slot=alert-action]:pr-18 *:[svg:not([class*='size-'])]:size-4 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current",
				variant === "destructive" && "text-kumo-danger",
				className,
			)}
			{...props}
		>
			{/* Keep compositional title/description slots out of Banner's paragraph fallback. */}
			<>{children}</>
		</Banner>
	);
}

function AlertTitle({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-title"
			className={cn(
				"font-medium type-tedix-control group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-kumo-strong",
				className,
			)}
			{...props}
		/>
	);
}

function AlertDescription({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-description"
			className={cn(
				"text-balance text-kumo-subtle type-tedix-body group-data-[variant=destructive]/alert:text-kumo-danger [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-kumo-strong [&_p:not(:last-child)]:mb-4",
				className,
			)}
			{...props}
		/>
	);
}

function AlertAction({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-action"
			className={cn("absolute top-0 right-0", className)}
			{...props}
		/>
	);
}

const LOAD_ERROR_HELP: Record<string, string> = {
	SERVICE_UNAVAILABLE:
		"This is taking longer than usual. Try again in a moment.",
	TIMEOUT: "This is taking longer than usual. Try again in a moment.",
	GATEWAY_TIMEOUT: "This is taking longer than usual. Try again in a moment.",
	TOO_MANY_REQUESTS:
		"There are too many requests right now. Try again in a moment.",
	INTERNAL_SERVER_ERROR:
		"Something went wrong while loading. Try again in a moment.",
	UNAUTHORIZED: "Your session may have ended. Sign in again to continue.",
	FORBIDDEN:
		"You don't have access to this. Ask an organization admin for help.",
	NOT_FOUND: "This may have been removed, or the link may have changed.",
};

type LoadErrorProps = Omit<ComponentProps<"div">, "title"> & {
	title?: ReactNode;
	help?: ReactNode;
	error?: unknown;
	details?: ReactNode;
	traceId?: string;
	onRetry?: () => unknown;
	retrying?: boolean;
	retryDisabled?: boolean;
};

/** One load-failure composition; retry callbacks must only repeat reads. */
function LoadError({
	title = "This couldn't be loaded",
	help,
	error,
	details,
	traceId,
	onRetry,
	retrying = false,
	retryDisabled = false,
	className,
	...props
}: LoadErrorProps) {
	const code = orpcErrorCode(error);
	const message = errorMessage(error, "");
	const record =
		error && typeof error === "object"
			? (error as { traceId?: unknown; data?: { traceId?: unknown } })
			: undefined;
	const trace = traceId ?? record?.traceId ?? record?.data?.traceId;
	return (
		<Alert
			variant="destructive"
			className={cn("block min-w-0", className)}
			{...props}
		>
			<div
				data-slot="load-error"
				className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 text-kumo-default sm:grid-cols-[auto_minmax(0,1fr)_auto]"
			>
				<WarningCircle aria-hidden className="mt-0.5 size-5 text-kumo-danger" />
				<div className="min-w-0 [overflow-wrap:anywhere]">
					<AlertTitle>{title}</AlertTitle>
					<div
						data-slot="load-error-help"
						className="text-kumo-subtle type-tedix-body"
					>
						{help ||
							(code && LOAD_ERROR_HELP[code]) ||
							"Try again in a moment."}
					</div>
					{(message || details || typeof trace === "string") && (
						<details className="mt-2 text-kumo-subtle type-tedix-caption">
							<summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2">
								Details
							</summary>
							<div className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
								{message && <div>{message}</div>}
								{details}
								{typeof trace === "string" && <div>Trace ID: {trace}</div>}
							</div>
						</details>
					)}
				</div>
				{onRetry && (
					<Button
						type="button"
						variant="outline"
						onClick={() => void onRetry()}
						disabled={retrying || retryDisabled}
						aria-busy={retrying}
						className="col-span-2 w-full sm:col-span-1 sm:w-auto"
					>
						{retrying ? "Trying again…" : "Retry"}
					</Button>
				)}
			</div>
		</Alert>
	);
}

export {
	Alert,
	AlertAction,
	AlertDescription,
	type AlertProps,
	AlertTitle,
	LoadError,
	type LoadErrorProps,
};
