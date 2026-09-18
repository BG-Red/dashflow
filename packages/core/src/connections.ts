import { z } from "zod";

export const CONNECTION_TYPES = ["azure", "lighthouse", "partner-center", "nerdio", "demo"] as const;
export const connectionTypeSchema = z.enum(CONNECTION_TYPES);
export type ConnectionType = z.infer<typeof connectionTypeSchema>;

const guid = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Must be a GUID");

/** How a connection authenticates to Microsoft Entra. Secrets are never part of config. */
export const credentialModeSchema = z.enum(["managed-identity", "client-secret", "client-certificate"]);
export type CredentialMode = z.infer<typeof credentialModeSchema>;

export const syncScheduleSchema = z.object({
  inventoryMinutes: z.number().int().min(15).max(1440).default(60),
  sessionsMinutes: z.number().int().min(5).max(60).default(5),
  logsMinutes: z.number().int().min(5).max(240).default(15),
  costHours: z.number().int().min(6).max(48).default(24),
  backfillDays: z.number().int().min(1).max(90).default(30),
  retentionDays: z.number().int().min(7).max(730).default(180),
});
export type SyncSchedule = z.infer<typeof syncScheduleSchema>;
export const DEFAULT_SCHEDULE: SyncSchedule = syncScheduleSchema.parse({});

const entraAppConfig = z.object({
  tenantId: guid,
  credentialMode: credentialModeSchema,
  /** Required for client-secret / client-certificate; optional user-assigned MI client id otherwise. */
  clientId: guid.optional(),
});

export const azureConfigSchema = entraAppConfig.extend({
  type: z.literal("azure"),
  /** Empty = every subscription the identity can see. */
  subscriptionIds: z.array(guid).default([]),
});

export const lighthouseConfigSchema = entraAppConfig.extend({
  type: z.literal("lighthouse"),
  /** Also include subscriptions in the managing tenant itself. */
  includeHomeTenant: z.boolean().default(false),
});

export const partnerCenterConfigSchema = z.object({
  type: z.literal("partner-center"),
  partnerTenantId: guid,
  clientId: guid,
  credentialMode: z.literal("client-secret"),
  /** Set by the consent flow; the refresh token itself is stored as a secret. */
  consentedBy: z.string().optional(),
  consentedAt: z.string().optional(),
});

export const nerdioConfigSchema = z.object({
  type: z.literal("nerdio"),
  edition: z.enum(["msp", "enterprise"]),
  /** e.g. https://nmw-app-xxxx.azurewebsites.net — no trailing slash. */
  baseUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "Must be https")
    .transform((u) => u.replace(/\/+$/, "")),
  tenantId: guid,
  clientId: guid,
  /** API scope shown in Nerdio Settings → Integrations → REST API, e.g. api://<guid>/.default */
  scope: z.string().min(3),
  credentialMode: z.enum(["client-secret", "client-certificate"]),
  /** Optional overrides when an instance's API paths differ from the defaults. */
  endpoints: z.record(z.string(), z.string()).default({}),
});

export const demoConfigSchema = z.object({
  type: z.literal("demo"),
  tenants: z.number().int().min(1).max(12).default(4),
});

export const connectionConfigSchema = z.discriminatedUnion("type", [
  azureConfigSchema,
  lighthouseConfigSchema,
  partnerCenterConfigSchema,
  nerdioConfigSchema,
  demoConfigSchema,
]);
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;
export type AzureConfig = z.infer<typeof azureConfigSchema>;
export type LighthouseConfig = z.infer<typeof lighthouseConfigSchema>;
export type PartnerCenterConfig = z.infer<typeof partnerCenterConfigSchema>;
export type NerdioConfig = z.infer<typeof nerdioConfigSchema>;

/** How the secret for a connection is provided. */
export const secretInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("inline"), value: z.string().min(1).max(16_000) }),
  z.object({
    kind: z.literal("keyvault"),
    secretName: z
      .string()
      .regex(/^[0-9a-zA-Z-]{1,127}$/, "Key Vault secret names use letters, digits and dashes"),
  }),
]);
export type SecretInput = z.infer<typeof secretInputSchema>;

export const CONNECTION_TYPE_INFO: Record<
  Exclude<ConnectionType, "demo">,
  { label: string; tagline: string; bestFor: string; multiTenant: boolean }
> = {
  azure: {
    label: "Azure (direct)",
    tagline: "Service principal or managed identity in one tenant.",
    bestFor: "Internal IT teams, or a single customer environment.",
    multiTenant: false,
  },
  lighthouse: {
    label: "Azure Lighthouse",
    tagline: "One identity in your managing tenant sees every delegated subscription.",
    bestFor: "MSPs that already onboard customers with Lighthouse.",
    multiTenant: true,
  },
  "partner-center": {
    label: "Partner Center (GDAP)",
    tagline: "Enumerate CSP customers and access them with delegated admin relationships.",
    bestFor: "CSP partners managing customers through GDAP.",
    multiTenant: true,
  },
  nerdio: {
    label: "Nerdio Manager",
    tagline: "Read host pools, hosts and autoscale from Nerdio Manager's REST API.",
    bestFor: "Environments managed with Nerdio Manager for MSP or Enterprise.",
    multiTenant: true,
  },
};

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail?: string;
  fix?: string;
}
