"use client";

import { AlertCircle } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../alert";
import { Button } from "../button";

export interface LayoutErrorProps {
	/**
	 * Error content to display. Can be a string, Error object, or ReactNode.
	 */
	error?: React.ReactNode;

	/**
	 * Error title (overrides default "Something went wrong")
	 */
	title?: string;

	/**
	 * Retry button handler
	 */
	onRetry?: () => void;

	/**
	 * Custom retry button label (overrides default "Try again")
	 * Use this for i18n/localization via brand's widgetConfig.strings.retryButton
	 */
	retryLabel?: string;

	/**
	 * Custom className
	 */
	className?: string;
}

/**
 * LayoutError - Error state component for layouts
 *
 * Displays an error alert with optional retry button.
 * Supports configurable labels for i18n via props.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <LayoutError
 *   error={error}
 *   title="Failed to load products"
 *   onRetry={handleRetry}
 * />
 *
 * // With localized strings from brand config
 * const strings = useWidgetStrings();
 * <LayoutError
 *   error={error}
 *   title={strings.errorTitle}
 *   retryLabel={strings.retryButton}
 *   onRetry={handleRetry}
 * />
 * ```
 */
export function LayoutError({
	error,
	title,
	onRetry,
	retryLabel,
	className,
	...props
}: LayoutErrorProps) {
	// Handle different error types: Error objects, strings, or ReactNode
	const errorMessage =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: error || "An error occurred";
	const errorTitle = title || "Something went wrong";

	return (
		<div
			data-slot="layout-error"
			className={cn("flex items-center justify-center p-6", className)}
			{...props}
		>
			<Alert color="danger" variant="soft" className="max-w-md">
				<AlertCircle className="h-4 w-4" />
				<AlertTitle>{errorTitle}</AlertTitle>
				<AlertDescription>{errorMessage}</AlertDescription>
				{onRetry && (
					<Button
						onClick={onRetry}
						variant="outline"
						size="sm"
						className="mt-4"
					>
						{retryLabel ?? "Try again"}
					</Button>
				)}
			</Alert>
		</div>
	);
}
