import { z } from "zod";

export const reportTypeSchema = z.enum(["lost", "found"]);
export const categorySchema = z.enum([
  "electronics",
  "clothing",
  "bags",
  "keys",
  "documents",
  "accessories",
  "other",
]);

const commonReportFields = {
  title: z.string().trim().min(2).max(100),
  description: z.string().trim().min(5).max(1000),
  location: z.string().trim().min(2).max(200),
  eventAt: z.iso.datetime({ offset: true }).refine(
    (value) => new Date(value).getTime() <= Date.now(),
    "Event time cannot be in the future.",
  ).optional(),
  category: categorySchema.optional(),
};

export const createReportSchema = z.discriminatedUnion("reportType", [
  z.object({
    ...commonReportFields,
    reportType: z.literal("lost"),
  }),
  z.object({
    ...commonReportFields,
    reportType: z.literal("found"),
    custodyStatus: z.enum(["finder_reported", "security_reported"]).optional(),
  }),
]);

export const updateReportSchema = z.object({
  title: commonReportFields.title.optional(),
  description: commonReportFields.description.optional(),
  location: commonReportFields.location.optional(),
  eventAt: commonReportFields.eventAt.optional(),
  category: categorySchema.nullable().optional(),
  custodyStatus: z.enum(["finder_reported", "security_reported"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required.");

export const resolveReportSchema = z.object({
  confirmed: z.literal(true),
});

export const itemListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  reportType: reportTypeSchema.optional(),
  category: categorySchema.optional(),
  location: z.string().trim().max(100).optional(),
  lifecycleStatus: z.enum(["open", "reserved", "returned", "resolved"]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  q: z.string().trim().max(100).optional(),
}).superRefine((value, context) => {
  if (value.from && value.to && new Date(value.from).getTime() > new Date(value.to).getTime()) {
    context.addIssue({ code: "custom", path: ["to"], message: "End date must be on or after start date." });
  }
});
