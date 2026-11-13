import { z } from "zod";

export const taskValuesSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000),
  status: z.enum(["todo", "inProgress", "done", "cancelled"]),
  priority: z.enum(["low", "normal", "high"]),
  assigneeId: z.string().min(1),
  dueAt: z.number().finite().nonnegative(),
  archived: z.boolean(),
});
export type TaskValues = z.infer<typeof taskValuesSchema>;
export const messageBodySchema = z.string().trim().min(1).max(10000);
const common = {
  key: z.string().min(1),
  clientId: z.uuid(),
  projectClientId: z.uuid(),
  revision: z.number().int().positive(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  delivery: z.enum(["local", "confirmed"]),
};
export const workRecordSchema = z.discriminatedUnion("entity", [
  taskValuesSchema.extend({ ...common, entity: z.literal("task") }),
  z.object({
    ...common,
    entity: z.literal("message"),
    body: z.string().max(10000),
    deleted: z.boolean(),
  }),
]);
export type WorkRecord = z.infer<typeof workRecordSchema>;
export const workCommandSchema = z.discriminatedUnion("entity", [
  z.object({
    expectedRevision: z.number().int().nonnegative(),
    entity: z.literal("task"),
    clientId: z.uuid(),
    projectClientId: z.uuid(),
    values: taskValuesSchema,
  }),
  z.object({
    expectedRevision: z.number().int().nonnegative(),
    entity: z.literal("message"),
    clientId: z.uuid(),
    projectClientId: z.uuid(),
    action: z.enum(["create", "update", "delete"]),
    body: z.string().max(10000),
  }),
]);
export type WorkCommand = z.infer<typeof workCommandSchema>;
