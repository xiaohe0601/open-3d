import { z } from "zod";

export const taskPlanSchema = z
  .strictObject({
    steps: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(80),
          label: z.string().trim().min(1).max(240),
          status: z.enum(["pending", "active", "completed", "blocked", "cancelled"]),
        }),
      )
      .min(1)
      .max(20),
  })
  .refine(({ steps }) => new Set(steps.map((step) => step.id)).size === steps.length);

export type TaskPlan = z.infer<typeof taskPlanSchema>;

export function validateTaskPlan(input: unknown, previous?: TaskPlan): TaskPlan {
  const plan = taskPlanSchema.parse(input);
  if (previous?.steps.some((step, index) => plan.steps[index]?.id !== step.id))
    throw new Error("plan-step-identity-changed");
  return plan;
}