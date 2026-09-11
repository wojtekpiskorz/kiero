/**
 * The company time context (CONTEXT.md "Strefa czasu firmy"): the one IANA
 * zone every wall-clock input on the client interprets against. Reminder
 * times are "pory przypomnień" in the company's zone and do not follow the
 * boss's phone, so a boss phoning from another zone still snoozes to the
 * moment the FIRM means.
 *
 * Pure module (Intl only): node-importable like the rest of the company
 * helpers. The offset is derived at read time for the CURRENT instant, the
 * same simplification the /dodatkowe temporal editor ships.
 */

/** The temporal editor's company context: zone plus its current UTC offset. */
export interface CompanyTemporalContext {
  readonly companyZone: string;
  readonly zoneOffset: string;
}

/** The zone's current UTC offset (e.g. "+02:00"), or "" when unresolvable. */
export function zoneOffsetOf(companyZone: string, atMs: number = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: companyZone, timeZoneName: "longOffset" })
      .formatToParts(new Date(atMs))
      .find((piece) => piece.type === "timeZoneName");
    const match = part === undefined ? null : /GMT([+-]\d{2}:\d{2})/.exec(part.value);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

/** The company temporal context of one zone (offset derived at read time). */
export function temporalContextOf(companyZone: string): CompanyTemporalContext {
  return { companyZone, zoneOffset: zoneOffsetOf(companyZone) };
}
