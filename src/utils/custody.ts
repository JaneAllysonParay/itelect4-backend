export type ReportedCustodyStatus = "finder_reported" | "security_reported";
export type CustodyStatus = ReportedCustodyStatus | "security_confirmed";

const REPORTED_CUSTODY_STATUSES: ReportedCustodyStatus[] = ["finder_reported", "security_reported"];

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function hasValidActor(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("toHexString" in value)) return false;
  const toHexString = (value as { toHexString?: unknown }).toHexString;
  return typeof toHexString === "function" && /^[a-f\d]{24}$/i.test(String(toHexString.call(value)));
}

function hasValidTimestamp(value: unknown): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function hasCompleteStaffCustodyConfirmation(item: Record<string, unknown>): boolean {
  return item.custodyStatus === "security_confirmed" &&
    hasValidTimestamp(item.custodyConfirmedAt) &&
    hasValidActor(item.custodyConfirmedBy);
}

/**
 * Return only internally consistent custody facts. Reporter-entered custody is
 * useful context, while staff-confirmed custody requires both staff evidence
 * fields. Confirmation evidence alongside a reporter status is contradictory.
 */
export function normalizedCustodyStatus(
  item: Record<string, unknown>,
  isConsistentFoundReport: boolean,
): CustodyStatus | null {
  if (!isConsistentFoundReport) return null;

  const hasConfirmationEvidence = hasValue(item.custodyConfirmedAt) || hasValue(item.custodyConfirmedBy);
  if (item.custodyStatus === "security_confirmed") {
    return hasCompleteStaffCustodyConfirmation(item) ? "security_confirmed" : null;
  }
  if (item.custodyStatus === "finder_reported" || item.custodyStatus === "security_reported") {
    return hasConfirmationEvidence ? null : item.custodyStatus;
  }
  return null;
}

/** The same conservative rule used by the Claim preflight and write predicate. */
export function hasSufficientFoundCustody(item: Record<string, unknown>): boolean {
  const hasConsistentFoundState =
    (item.reportType === "found" && item.lifecycleStatus === "open" && item.status === "found") ||
    (item.reportType === undefined && item.lifecycleStatus === undefined && item.status === "found");
  return normalizedCustodyStatus(item, hasConsistentFoundState) !== null;
}

/** MongoDB predicate corresponding to hasSufficientFoundCustody. */
export const sufficientFoundCustodyFilter = {
  $or: [
    {
      custodyStatus: { $in: REPORTED_CUSTODY_STATUSES },
      custodyConfirmedAt: null,
      custodyConfirmedBy: null,
    },
    {
      custodyStatus: "security_confirmed",
      custodyConfirmedAt: { $type: "date" },
      custodyConfirmedBy: { $type: "objectId" },
    },
  ],
};

/**
 * A report owner may add missing reporter-entered custody, but cannot alter a
 * staff confirmation or overwrite inconsistent confirmation metadata.
 */
export const ownerMaySetReportedCustodyFilter = {
  $and: [
    {
      $or: [
        { custodyStatus: { $in: REPORTED_CUSTODY_STATUSES } },
        { custodyStatus: { $exists: false } },
        { custodyStatus: null },
      ],
    },
    { custodyConfirmedAt: null },
    { custodyConfirmedBy: null },
  ],
};

/** Staff may confirm a reported or missing custody state after physical review. */
export const staffMayConfirmCustodyFilter = {
  $and: [
    {
      $or: [
        { custodyStatus: { $in: REPORTED_CUSTODY_STATUSES } },
        { custodyStatus: { $exists: false } },
        { custodyStatus: null },
      ],
    },
    { custodyConfirmedAt: null },
    { custodyConfirmedBy: null },
  ],
};
