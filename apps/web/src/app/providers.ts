/**
 * Application services context (A4).
 *
 * Carries the typed config seam and the connection flag to every host
 * component. Written with `createElement` (no JSX) so the composed feature
 * registry stays importable from the root node test program, which has no
 * JSX flag; JSX modules (shell, router, health) consume this context.
 */

import { createContext, createElement, useContext, type ReactNode } from "react";
import type { AppConfig } from "./config";

/** What every host component can rely on. */
export interface AppServices {
  readonly config: AppConfig;
}

const AppServicesContext = createContext<AppServices | null>(null);

/** Mounts the services once, above the router. */
export function AppServicesProvider({
  services,
  children,
}: {
  services: AppServices;
  children: ReactNode;
}): ReactNode {
  return createElement(AppServicesContext.Provider, { value: services }, children);
}

/** Reads the application services; throws if the provider is missing. */
export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (services === null) {
    throw new Error("app: useAppServices called outside AppServicesProvider");
  }
  return services;
}
