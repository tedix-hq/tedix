/**
 * The tedix template's own React copy. Its admin pages import this copy, so
 * tests must render them with it; hooks fail across two React instances.
 * The template install ships without type declarations, so reuse the
 * workspace's identical React types.
 */
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
