import { z } from "zod";

const credentialsSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "At least 8 characters."),
});

export const loginBodySchema = credentialsSchema;

export const registerBodySchema = credentialsSchema.extend({
  name: z.string().trim().min(1, "Enter your name."),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type RegisterBody = z.infer<typeof registerBodySchema>;
