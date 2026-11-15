import type { ApiItemDto } from "../types/index.js";
import { normalizedCustodyStatus } from "./custody.js";

type ItemSource = Record<string, unknown> & {
  toObject?: () => Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const item = value as ItemSource;
  return typeof item.toObject === "function" ? item.toObject() : item;
}

function asIso(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function idString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

export type ItemStateClassification = Pick<ApiItemDto, "reportType" | "lifecycleStatus" | "status">;

function hasItemHandoverRecord(item: Record<string, unknown>): boolean {
  const handoverAt = asIso(item.handoverAt);
  const handoverBy = item.handoverBy;
  const reservedClaimId = item.reservedClaimId;
  const handoverClaimId = item.handoverClaimId;
  return handoverAt !== null &&
    handoverBy !== undefined && handoverBy !== null && String(handoverBy).length > 0 &&
    reservedClaimId !== undefined && reservedClaimId !== null &&
    handoverClaimId !== undefined && handoverClaimId !== null &&
    String(reservedClaimId) === String(handoverClaimId);
}

export function classifyItemState(value: unknown): ItemStateClassification {
  const item = asRecord(value);
  const legacyStatus = item.status === "lost" || item.status === "found" || item.status === "claimed"
    ? item.status
    : "unknown";
  const canonicalType = item.reportType === "lost" || item.reportType === "found" ? item.reportType : null;
  const canonicalLifecycle = item.lifecycleStatus === "open" ||
    item.lifecycleStatus === "reserved" ||
    item.lifecycleStatus === "returned" ||
    item.lifecycleStatus === "resolved"
    ? item.lifecycleStatus
    : null;
  const isPureLegacy = item.reportType === undefined && item.lifecycleStatus === undefined;
  let reportType: ItemStateClassification["reportType"] = "unknown";
  let lifecycleStatus: ItemStateClassification["lifecycleStatus"] = "unknown";
  let status: ItemStateClassification["status"] = "unknown";

  if (isPureLegacy && (legacyStatus === "lost" || legacyStatus === "found")) {
    reportType = legacyStatus;
    lifecycleStatus = "open";
    status = legacyStatus;
  } else if (isPureLegacy && legacyStatus === "claimed") {
    status = "claimed";
  } else if (canonicalType && canonicalLifecycle) {
    const statusMatchesLifecycle = canonicalType === "lost"
      ? (canonicalLifecycle === "open" || canonicalLifecycle === "resolved") && legacyStatus === "lost"
      : canonicalLifecycle === "open"
        ? legacyStatus === "found"
        : canonicalLifecycle === "reserved"
          ? legacyStatus === "claimed"
          : canonicalLifecycle === "returned" && legacyStatus === "claimed" && hasItemHandoverRecord(item);
    if (statusMatchesLifecycle) {
      reportType = canonicalType;
      lifecycleStatus = canonicalLifecycle;
      status = legacyStatus;
    }
  }

  return { reportType, lifecycleStatus, status };
}

/**
 * Convert canonical and pre-Phase-2 documents to a stable API shape. Historical
 * `claimed` records intentionally remain unknown: their report type and any
 * physical handover cannot be inferred from that legacy status.
 */
export function toItemDto(
  value: unknown,
  options: { includeStaffFields?: boolean } = {},
): ApiItemDto {
  const item = asRecord(value);
  const { reportType, lifecycleStatus, status } = classifyItemState(item);
  const consistentFoundReport = reportType === "found" &&
    (lifecycleStatus === "open" || lifecycleStatus === "reserved" || lifecycleStatus === "returned");

  const dto: ApiItemDto = {
    id: String(item.id ?? item._id ?? ""),
    title: String(item.title ?? ""),
    description: String(item.description ?? ""),
    location: String(item.location ?? ""),
    dateReported: asIso(item.dateReported) ?? "",
    reportType,
    lifecycleStatus,
    eventAt: asIso(item.eventAt),
    category: typeof item.category === "string" ? item.category as ApiItemDto["category"] : null,
    custodyStatus: normalizedCustodyStatus(item, consistentFoundReport),
    status,
    ownerId: String(item.ownerId ?? ""),
    archivedAt: asIso(item.archivedAt),
  };

  if (options.includeStaffFields) {
    dto.resolvedAt = asIso(item.resolvedAt);
    dto.resolvedBy = idString(item.resolvedBy);
    dto.reservedAt = asIso(item.reservedAt);
    dto.reservedBy = idString(item.reservedBy);
    dto.reservedClaimId = idString(item.reservedClaimId);
    dto.handoverAt = asIso(item.handoverAt);
    dto.handoverBy = idString(item.handoverBy);
    dto.handoverClaimId = idString(item.handoverClaimId);
    dto.handoverInternalNote = typeof item.handoverInternalNote === "string"
      ? item.handoverInternalNote
      : null;
    dto.custodyConfirmedAt = asIso(item.custodyConfirmedAt);
    dto.custodyConfirmedBy = idString(item.custodyConfirmedBy);
  }

  return dto;
}
