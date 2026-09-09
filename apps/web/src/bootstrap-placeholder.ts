import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { SignInFeature } from "./features/sign-in/SignInFeature";

/**
 * Bootstrap entry for the Kiero PWA shell.
 *
 * The app starts at the barebones sign-in feature (B1): Google and
 * email-code sign-in with live sessions. The feature owns its Convex
 * client/provider wiring; later features register sibling routes and the
 * router grows with the product. Nothing here is visual design.
 */

const rootRoute = createRootRoute({
  component: () => createElement("div", { lang: "pl" }, createElement(Outlet)),
});

// The sign-in feature is the index screen until authenticated routing
// (later joins) takes over.
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => createElement(SignInFeature),
});

const router = createRouter({ routeTree: rootRoute.addChildren([signInRoute]) });

const container = document.getElementById("root");
if (!(container instanceof HTMLDivElement)) {
  throw new Error("bootstrap-placeholder: #root container not found");
}

createRoot(container).render(createElement(RouterProvider, { router }));
