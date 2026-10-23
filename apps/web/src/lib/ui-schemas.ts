import { z } from "zod";

export const finiteNumberSchema = z.number().finite();
export const projectNameSchema = z.string().trim().min(1);