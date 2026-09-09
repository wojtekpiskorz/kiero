/**
 * The barebones application shell (A4).
 *
 * Plain semantic chrome only (execution charter: "The unstyled UI uses
 * semantic forms, buttons, lists and plain status/error text"): a header
 * with the app title and a navigation built from the feature registry, a
 * status/error area (connection + authentication, politely announced), a
 * skip link and the main region every feature screen renders into. No
 * styling system, no classes: default block layout keeps the shell
 * responsive without overflow and fully keyboard-operable (real anchors,
 * one tab stop per control).
 */

import { Link, Outlet } from "@tanstack/react-router";
import { appFeatures } from "./app-features";
import { ConnectionStatus } from "./health-status";

export function AppShell() {
  return (
    <>
      <a href="#main-content">Przejdź do treści głównej</a>
      <header>
        <p>
          <strong>Kiero</strong>
        </p>
        <nav aria-label="Funkcje">
          <ul>
            {appFeatures.map((feature) => (
              <li key={feature.featureId}>
                <Link to={feature.routePath}>{feature.navLabel}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <div aria-live="polite">
          <ConnectionStatus />
          <p>Nie zalogowano — logowanie jest w przygotowaniu.</p>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
