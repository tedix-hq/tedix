/**
 * The tedix template's own React copy. Its admin pages import this copy, so
 * tests must render them with it; hooks fail across two React instances.
 * The template install ships without type declarations, so reuse the
 * workspace's identical React types.
 */
import { i18n } from "../../templates/tedix/node_modules/@lingui/core/dist/index.mjs";
import { I18nProvider } from "../../templates/tedix/node_modules/@lingui/react/dist/index.mjs";
import type * as ReactTypes from "react";
import type * as ReactDomClientTypes from "react-dom/client";
import type * as ReactDomServerTypes from "react-dom/server";
// @ts-expect-error -- untyped template install; typed through the casts below
import * as react from "../../templates/tedix/node_modules/react";
// @ts-expect-error -- untyped template install; typed through the casts below
import * as client from "../../templates/tedix/node_modules/react-dom/client";
// @ts-expect-error -- untyped template install; typed through the casts below
import * as server from "../../templates/tedix/node_modules/react-dom/server";

export const { act, createElement } = react as typeof ReactTypes;
export const { createRoot } = client as typeof ReactDomClientTypes;
export const { renderToStaticMarkup } = server as typeof ReactDomServerTypes;

export const templateI18n = i18n;
export function withTemplateI18n(children: ReactTypes.ReactNode) {
	return createElement(I18nProvider, { i18n: templateI18n }, children);
}
