import { z } from "zod";
import { accessModes } from "../shared/workspace";

export const preferenceDefaults = {
  auto: true, clipboard: false, catalogUpdates: true, theme: "system", fontSize: "normal",
  defaultAccess: "ask", fullAccessConfirmed: false, busyEnter: "queue",
  notifications: true, notificationSound: true, keepAwake: false, panelWidth: 360, agentSteps: 0, webSearch: false
} as const;

export const preferencesSchema = z.object({
  directory: z.string().min(1), auto: z.boolean(), clipboard: z.boolean(), catalogUpdates: z.boolean(),
  theme: z.enum(["system", "dark", "light"]), fontSize: z.enum(["small", "normal", "large"]),
  defaultAccess: z.enum(accessModes), fullAccessConfirmed: z.boolean(), busyEnter: z.enum(["queue", "interrupt"]),
  notifications: z.boolean(), notificationSound: z.boolean(), keepAwake: z.boolean(),
  panelWidth: z.number().int().min(260).max(700), agentSteps: z.number().int().min(0).max(200), webSearch: z.boolean()
});

export function migratePreferences(input: Partial<z.infer<typeof preferencesSchema>>, directory: string) {
  return { ...preferenceDefaults, directory, ...input };
}
