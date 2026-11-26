import { voiceDefaults, voiceLanguages, voiceModels } from "../shared/voice";
import { z } from "zod";
import { accessModes } from "../shared/workspace";

export const preferenceDefaults = {
  ...voiceDefaults,
  auto: true, clipboard: false, catalogUpdates: true, theme: "system", fontSize: "normal",
  defaultAccess: "ask", fullAccessConfirmed: false, busyEnter: "queue",
  connectionWizardSeen: false, openAtLogin: false, autoUpdate: true, trayHintShown: false, notifications: true, notificationSound: true, keepAwake: false, panelWidth: 360, agentSteps: 0, webSearch: false
} as const;

export const preferencesSchema = z.object({
  directory: z.string().min(1), auto: z.boolean(), clipboard: z.boolean(), catalogUpdates: z.boolean(),
  theme: z.enum(["system", "dark", "light"]), fontSize: z.enum(["small", "normal", "large"]),
  defaultAccess: z.enum(accessModes), fullAccessConfirmed: z.boolean(), busyEnter: z.enum(["queue", "interrupt"]),
  connectionWizardSeen: z.boolean().optional(),
  closeToTray: z.boolean().optional(), openAtLogin: z.boolean().optional(), autoUpdate: z.boolean().optional(), trayHintShown: z.boolean().optional(),
  notifications: z.boolean(), notificationSound: z.boolean(), keepAwake: z.boolean(),
  panelWidth: z.number().int().min(260).max(700), agentSteps: z.number().int().min(0).max(200), webSearch: z.boolean(),
  voiceModel: z.enum(voiceModels).optional(),
  voiceLanguage: z.string().refine(value => value === "auto" || voiceLanguages.includes(value)).optional(),
  voiceSilence: z.union([z.literal(0), z.literal(10), z.literal(30)]).optional(),
  voiceDevice: z.string().max(512).optional(),
  voiceGroq: z.boolean().optional()
});

export function migratePreferences(input: Partial<z.infer<typeof preferencesSchema>>, directory: string) {
  return { ...preferenceDefaults, directory, ...input };
}
