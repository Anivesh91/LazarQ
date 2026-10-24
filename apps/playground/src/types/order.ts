import { z } from "zod";

export const OrderPayloadSchema = z.object({
  orderId: z.string(),
  userId: z.string({ required_error: "userId is required" }),
  amount: z.number().positive(),
  channel: z.enum(["SMS", "EMAIL"]).default("SMS"),
  email: z.string().email().optional(),
  simulateDbTimeout: z.boolean().optional(),
});

export type OrderPayload = z.infer<typeof OrderPayloadSchema>;
