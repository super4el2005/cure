import { z } from "zod";

export const membershipRequestValuesSchema = z.object({
  role: z.enum(["doctor", "researcher"]),
  message: z.string().trim().min(1).max(2000),
});
export const membershipChangeSchema = z.object({
  role: z.enum(["doctor", "researcher", "admin"]),
  active: z.boolean(),
  reason: z.string().trim().min(1).max(1000),
});
export const membershipReviewSchema = z.object({
  approved: z.boolean(),
  reason: z.string().trim().min(1).max(1000),
});
