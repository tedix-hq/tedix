import type { ReactNode } from "react";

/** Shared loading, error, empty and retry props for widget components. */
export interface StatefulComponentProps {
	/** Loading state - shows skeleton UI when true */
	isLoading?: boolean;
	/** Error message to display (undefined/null = no error, ReactNode = error content shown) */
	error?: ReactNode;
	/** Empty state flag - shows empty message when true and no items */
	isEmpty?: boolean;
	/** Retry callback for error state */
	onRetry?: () => void;
}
