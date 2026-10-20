import { z } from "zod";

export const aiRequestSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(20, "Describe the item report in at least 20 characters.")
    .max(2000, "Keep the description under 2000 characters."),
});

export const itemReportReviewSchema = z.object({
  summary: z
    .string()
    .describe(
      "One concise sentence restating the lost or found report in plain English, using only facts supplied by the user.",
    ),
  keyDetails: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe(
      "One to three useful identifying details that are genuinely present in the user's description.",
    ),
  suggestions: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe(
      "One to three concrete details or clarifications that would make the report easier to identify or match.",
    ),
  readiness: z
    .enum(["ready", "almost", "not-yet"])
    .describe(
      '"ready" means enough useful identifying information is present; "almost" means useful information exists but one or two important clarifications would help; "not-yet" means the description is too vague to identify the item.',
    ),
});

export type ItemReportReview = z.infer<typeof itemReportReviewSchema>;

export const itemReportReviewJsonSchema = z.toJSONSchema(
  itemReportReviewSchema,
);
