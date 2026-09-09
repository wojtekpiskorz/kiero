/**
 * Contact and contact-role rules (C1 domain half, pure).
 *
 * Vocabulary ("Kontakt", "Klient", CONTEXT.md): a person or organization
 * described in the firm's catalog, able to appear in projects as a client,
 * executor or supplier. A contact is distinct from a user account and from
 * company membership; linking a contact to a user stays explicit and is not
 * part of this lane's operations.
 *
 * Rules encoded here:
 *
 * - One identity, many roles: the SAME contact may be client, executor and
 *   supplier of the same project without any per-role identity duplication.
 *   Roles are rows that reference the contact; the contact is the identity.
 * - (project, contact, role) is unique: commanding an already-held role is
 *   an idempotent no-op returning the existing row, never a duplicate.
 * - Names are catalog text: bounded, non-empty, and deliberately NOT unique
 *   (two people may both be called "Kowalski"; the identity is the row id).
 */

import type { ContactKind, ContactRole } from "@kiero/contracts";
import type { Validated } from "./result";

/** Bounded catalog display name for a contact. */
export const MAX_CONTACT_NAME_LENGTH = 200;

/** Polish product rendering of the contact kinds (CONTEXT.md "Kontakt"). */
export const CONTACT_KIND_LABELS: Readonly<Record<ContactKind, string>> = {
  person: "Osoba",
  organization: "Organizacja",
};

/** Polish product rendering of the project roles a contact may hold. */
export const CONTACT_ROLE_LABELS: Readonly<Record<ContactRole, string>> = {
  client: "Klient",
  executor: "Wykonawca",
  supplier: "Dostawca",
};

/** Contact names carry words; whitespace-only is not a name. */
export function validateContactName(name: string): Validated<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "contact_name_empty" };
  }
  if (trimmed.length > MAX_CONTACT_NAME_LENGTH) {
    return { ok: false, code: "contact_name_too_long" };
  }
  return { ok: true, value: trimmed };
}

/** The rows of one (project, contact) pair the role decision consumes. */
export interface ContactRoleRowView {
  readonly contactRoleId: string;
  readonly role: ContactRole;
}

/** What one role assignment command does. */
export type ContactRoleDecision =
  /** The pair already holds this role: idempotent no-op. */
  | { readonly kind: "existing"; readonly contactRoleId: string }
  /** A new role row for the same contact identity. */
  | { readonly kind: "assign" };

/**
 * Decides one role assignment over the roles one contact already holds in
 * one project. Different roles coexist (multiplicity without identity
 * duplication); only the exact same role is idempotent.
 */
export function decideContactRoleAssignment(
  existing: readonly ContactRoleRowView[],
  role: ContactRole,
): ContactRoleDecision {
  for (const row of existing) {
    if (row.role === role) {
      return { kind: "existing", contactRoleId: row.contactRoleId };
    }
  }
  return { kind: "assign" };
}
