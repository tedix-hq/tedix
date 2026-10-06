import { SignUpOrInFlow } from "@descope/react-sdk/flows";
import type { ComponentProps } from "react";
import { useCallback, useState } from "react";
import { resolveThemeMode, useOsTheme } from "@/lib/theme";
import {
	descopeStyleProps,
	installTedixDescopeSurfaceTokens,
	TEDIX_DESCOPE_THEME_OVERRIDE_JSON,
} from "@/shared/descope-theme";
import {
	isTedixByosLoginScreen,
	TedixByosLoginScreen,
} from "./descope-byos-login-screen";
import {
	DESCOPE_LOGIN_INTERACTIONS,
	resolveDescopePasswordScreen,
	type DescopeByosContext,
	type DescopeFlowNext,
} from "@/shared/descope-byos-contract";
import {
	TedixByosPasswordScreen,
	type ByosPasswordScreenContract,
} from "@/shared/descope-byos-password-screen";

type SignUpOrInFlowProps = ComponentProps<typeof SignUpOrInFlow>;

/** Keep Descope's shadow-DOM flow synchronized with the Tedix OS appearance. */
export function TedixSignUpOrInFlow(props: SignUpOrInFlowProps) {
	const { preference } = useOsTheme();
	const [loginScreen, setLoginScreen] = useState<{
		context: DescopeByosContext;
		next: DescopeFlowNext;
	} | null>(null);
	const [passwordScreen, setPasswordScreen] = useState<{
		contract: ByosPasswordScreenContract;
		context: DescopeByosContext;
		next: DescopeFlowNext;
	} | null>(null);
	const onReady = useCallback(
		(event: Parameters<NonNullable<SignUpOrInFlowProps["onReady"]>>[0]) => {
			installTedixDescopeSurfaceTokens(event.currentTarget as HTMLElement);
			props.onReady?.(event);
		},
		[props.onReady],
	);
	const onScreenUpdate = useCallback<
		NonNullable<SignUpOrInFlowProps["onScreenUpdate"]>
	>(
		(screenName, context, next, ref) => {
			const contract = resolveDescopePasswordScreen(
				"sign-up-or-in",
				screenName,
			);
			if (contract) {
				setLoginScreen(null);
				setPasswordScreen({ contract, context, next });
				return true;
			}
			setPasswordScreen(null);
			if (isTedixByosLoginScreen(screenName)) {
				setLoginScreen({
					context: context as DescopeByosContext,
					next: next as DescopeFlowNext,
				});
				return true;
			}
			setLoginScreen(null);
			return props.onScreenUpdate?.(screenName, context, next, ref) ?? false;
		},
		[props.onScreenUpdate],
	);

	return (
		<>
			<div hidden={Boolean(loginScreen || passwordScreen)}>
				<SignUpOrInFlow
					{...props}
					{...descopeStyleProps()}
					onReady={onReady}
					onScreenUpdate={onScreenUpdate}
					theme={resolveThemeMode(preference)}
					themeOverride={
						TEDIX_DESCOPE_THEME_OVERRIDE_JSON as unknown as SignUpOrInFlowProps["themeOverride"]
					}
				/>
			</div>
			{loginScreen ? (
				<TedixByosLoginScreen
					context={loginScreen.context}
					interactions={DESCOPE_LOGIN_INTERACTIONS["sign-up-or-in"]}
					next={loginScreen.next}
				/>
			) : null}
			{passwordScreen ? (
				<TedixByosPasswordScreen
					key={passwordScreen.contract.mode}
					{...passwordScreen}
				/>
			) : null}
		</>
	);
}
