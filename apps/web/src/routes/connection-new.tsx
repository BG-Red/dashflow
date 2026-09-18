import { CONNECTION_TYPE_INFO, type ConnectionType, type DiagnosticCheck } from "@dashflow/core";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { PageHeader } from "../components/layout";
import { Alert, Badge, Button, Card, Field, Input, Select, Stepper, Switch } from "../components/ui";
import { api, type Me } from "../lib/api";
import { ChecksList, Prerequisites } from "./connections";

const STEPS = [
  { id: "type", label: "Connection type" },
  { id: "prereq", label: "Prerequisites" },
  { id: "credentials", label: "Credentials" },
  { id: "test", label: "Test" },
  { id: "sync", label: "First sync" },
];

type SecretMode = "managed-identity" | "inline" | "keyvault";

interface FormState {
  name: string;
  tenantId: string;
  clientId: string;
  subscriptionIds: string;
  secretMode: SecretMode;
  secretValue: string;
  keyVaultName: string;
  includeHomeTenant: boolean;
  // Nerdio
  edition: "msp" | "enterprise";
  baseUrl: string;
  scope: string;
}

const EMPTY: FormState = {
  name: "",
  tenantId: "",
  clientId: "",
  subscriptionIds: "",
  secretMode: "inline",
  secretValue: "",
  keyVaultName: "",
  includeHomeTenant: false,
  edition: "msp",
  baseUrl: "",
  scope: "",
};

/**
 * Adding a connection is where most self-hosted tools lose people: the credential is easy,
 * the permissions are not. So the wizard generates the exact commands first, then proves the
 * access with a checklist before anything is synced.
 */
export function ConnectionNew({ me }: { me: Me }) {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [type, setType] = useState<ConnectionType | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [checks, setChecks] = useState<DiagnosticCheck[] | null>(null);

  const redirectUri = `${window.location.origin}/api/connections/consent/callback`;
  const set = (next: Partial<FormState>) => setForm((current) => ({ ...current, ...next }));

  const create = useMutation({
    mutationFn: async () => {
      const config = buildConfig(type!, form);
      const secret =
        form.secretMode === "inline" && form.secretValue
          ? ({ kind: "inline", value: form.secretValue } as const)
          : form.secretMode === "keyvault" && form.keyVaultName
            ? ({ kind: "keyvault", secretName: form.keyVaultName } as const)
            : ({ kind: "none" } as const);
      return api.createConnection({ name: form.name || defaultName(type!), config, secret });
    },
    onSuccess: (result) => {
      setConnectionId(result.id);
      setStep(3);
      test.mutate(result.id);
    },
  });

  const test = useMutation({
    mutationFn: api.testConnection,
    onSuccess: (result) => setChecks(result.checks),
  });

  const discover = useMutation({ mutationFn: api.discover });
  const sync = useMutation({ mutationFn: (id: string) => api.syncConnection(id, true) });
  const consent = useMutation({
    mutationFn: api.consentUrl,
    onSuccess: (result) => window.open(result.url, "_blank", "noopener"),
  });

  const worstStatus = checks?.some((check) => check.status === "fail")
    ? "fail"
    : checks?.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  return (
    <>
      <PageHeader
        title="Add a connection"
        description="Nothing is synced until you have seen the permission checks pass."
        actions={
          <Button variant="ghost" onClick={() => navigate("/connections")}>
            Cancel
          </Button>
        }
      />
      <div className="mb-4">
        <Stepper steps={STEPS} current={step} onSelect={(index) => index <= step && setStep(index)} />
      </div>

      {step === 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {(Object.keys(CONNECTION_TYPE_INFO) as Exclude<ConnectionType, "demo">[]).map((key) => {
            const info = CONNECTION_TYPE_INFO[key];
            return (
              <button
                type="button"
                key={key}
                onClick={() => {
                  setType(key);
                  setForm({
                    ...EMPTY,
                    name: defaultName(key),
                    secretMode: key === "azure" ? "inline" : "inline",
                  });
                  setStep(1);
                }}
                className="text-left"
              >
                <Card className="h-full p-4 transition-all hover:-translate-y-0.5 hover:shadow-md">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold tracking-tight">{info.label}</h3>
                    {info.multiTenant ? <Badge tone="accent">multi-tenant</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">{info.tagline}</p>
                  <p className="mt-2 text-[11px] text-[var(--text-muted)]">Best for: {info.bestFor}</p>
                </Card>
              </button>
            );
          })}
        </div>
      ) : null}

      {step === 1 && type ? (
        <Card className="max-w-3xl space-y-4 p-4">
          <Prerequisites
            type={type}
            values={{
              tenantId: form.tenantId,
              clientId: form.clientId,
              subscriptionId: form.subscriptionIds.split(",")[0]?.trim(),
              baseUrl: form.baseUrl,
              redirectUri,
            }}
          />
          <div className="flex justify-between border-t border-[var(--border)] pt-3">
            <Button variant="ghost" onClick={() => setStep(0)}>
              <ArrowLeft size={15} /> Back
            </Button>
            <Button onClick={() => setStep(2)}>
              I have done this <ArrowRight size={15} />
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 2 && type ? (
        <Card className="max-w-2xl space-y-4 p-4">
          <Field label="Connection name">
            <Input value={form.name} onChange={(event) => set({ name: event.target.value })} />
          </Field>

          {type === "nerdio" ? (
            <>
              <Field label="Edition">
                <Select
                  value={form.edition}
                  onChange={(event) => set({ edition: event.target.value as "msp" | "enterprise" })}
                >
                  <option value="msp">Nerdio Manager for MSP</option>
                  <option value="enterprise">Nerdio Manager for Enterprise</option>
                </Select>
              </Field>
              <Field label="Instance URL" hint="No trailing slash.">
                <Input
                  value={form.baseUrl}
                  placeholder="https://nmw-app-example.azurewebsites.net"
                  onChange={(event) => set({ baseUrl: event.target.value })}
                />
              </Field>
              <Field label="API scope" hint="From Nerdio Settings → Integrations → REST API.">
                <Input
                  value={form.scope}
                  placeholder="api://00000000-0000-0000-0000-000000000000/.default"
                  onChange={(event) => set({ scope: event.target.value })}
                />
              </Field>
            </>
          ) : null}

          <Field
            label={
              type === "partner-center"
                ? "Partner tenant ID"
                : type === "lighthouse"
                  ? "Managing tenant ID"
                  : "Tenant ID"
            }
          >
            <Input
              value={form.tenantId}
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => set({ tenantId: event.target.value.trim() })}
            />
          </Field>

          {type === "azure" ? (
            <Field label="Credential" hint="A managed identity avoids storing a secret at all.">
              <Select
                value={form.secretMode}
                onChange={(event) => set({ secretMode: event.target.value as SecretMode })}
              >
                <option value="managed-identity">This container's managed identity</option>
                <option value="inline">Client secret (encrypted in the database)</option>
                <option value="keyvault">Client secret from Key Vault</option>
              </Select>
            </Field>
          ) : null}

          {form.secretMode !== "managed-identity" || type !== "azure" ? (
            <Field label="Client ID">
              <Input
                value={form.clientId}
                placeholder="00000000-0000-0000-0000-000000000000"
                onChange={(event) => set({ clientId: event.target.value.trim() })}
              />
            </Field>
          ) : null}

          {type !== "azure" ? (
            <Field label="Credential source">
              <Select
                value={form.secretMode}
                onChange={(event) => set({ secretMode: event.target.value as SecretMode })}
              >
                <option value="inline">Client secret (encrypted in the database)</option>
                <option value="keyvault">Client secret from Key Vault</option>
              </Select>
            </Field>
          ) : null}

          {form.secretMode === "inline" ? (
            <Field
              label="Client secret"
              hint={
                me.instance.canStoreSecrets
                  ? "Encrypted with AES-256-GCM before it is stored. It is never returned by the API or written to logs."
                  : "APP_ENCRYPTION_KEY is not set on this instance, so secrets cannot be stored. Generate one with: openssl rand -base64 32"
              }
            >
              <Input
                type="password"
                autoComplete="off"
                value={form.secretValue}
                disabled={!me.instance.canStoreSecrets}
                onChange={(event) => set({ secretValue: event.target.value })}
              />
            </Field>
          ) : null}

          {form.secretMode === "keyvault" ? (
            <Field
              label="Key Vault secret name"
              hint={
                me.instance.canUseKeyVault
                  ? "Only the name is stored. The value is read at runtime with this app's managed identity."
                  : "KEY_VAULT_URI is not configured on this instance."
              }
            >
              <Input
                value={form.keyVaultName}
                disabled={!me.instance.canUseKeyVault}
                placeholder="dashflow-client-secret"
                onChange={(event) => set({ keyVaultName: event.target.value.trim() })}
              />
            </Field>
          ) : null}

          {type === "azure" ? (
            <Field
              label="Subscriptions"
              hint="Comma separated. Leave empty to use every subscription the identity can see."
            >
              <Input
                value={form.subscriptionIds}
                onChange={(event) => set({ subscriptionIds: event.target.value })}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </Field>
          ) : null}

          {type === "lighthouse" ? (
            <div className="flex items-center gap-2">
              <Switch
                checked={form.includeHomeTenant}
                onChange={(value) => set({ includeHomeTenant: value })}
              />
              <span className="text-sm text-[var(--text-secondary)]">
                Also include subscriptions in the managing tenant itself
              </span>
            </div>
          ) : null}

          {create.isError ? <Alert tone="critical">{(create.error as Error).message}</Alert> : null}

          <div className="flex justify-between border-t border-[var(--border)] pt-3">
            <Button variant="ghost" onClick={() => setStep(1)}>
              <ArrowLeft size={15} /> Back
            </Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? "Saving…" : "Save and test"} <ArrowRight size={15} />
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 3 && connectionId ? (
        <Card className="max-w-3xl space-y-4 p-4">
          {type === "partner-center" ? (
            <Alert tone="neutral" title="Partner consent required">
              <p className="mb-2">
                Sign in as a partner admin with the AdminAgents role to grant consent. The refresh token is
                stored as a secret and used to get per-customer tokens.
              </p>
              <Button size="sm" variant="outline" onClick={() => consent.mutate(connectionId)}>
                <ExternalLink size={14} /> Grant consent
              </Button>
            </Alert>
          ) : null}

          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Permission checks</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => test.mutate(connectionId)}
              disabled={test.isPending}
            >
              <CheckCircle2 size={14} /> {test.isPending ? "Testing…" : "Run again"}
            </Button>
          </div>

          {test.isPending && !checks ? (
            <p className="text-sm text-[var(--text-muted)]">Probing the APIs this connection needs…</p>
          ) : checks ? (
            <>
              <ChecksList checks={checks} />
              {worstStatus === "fail" ? (
                <Alert tone="critical" title="Something is blocking this connection">
                  Fix the failing checks above, then run the test again. The most common cause is a role
                  assignment that has not propagated yet — it can take a few minutes.
                </Alert>
              ) : worstStatus === "warn" ? (
                <Alert tone="warning" title="Usable, with gaps">
                  The connection works, but some data will be missing until the warnings are addressed.
                </Alert>
              ) : (
                <Alert tone="good" title="All good">
                  Everything this connection needs is in place.
                </Alert>
              )}
            </>
          ) : null}

          <div className="flex justify-between border-t border-[var(--border)] pt-3">
            <Button variant="ghost" onClick={() => setStep(2)}>
              <ArrowLeft size={15} /> Change credentials
            </Button>
            <Button
              onClick={() => {
                discover.mutate(connectionId);
                setStep(4);
              }}
              disabled={worstStatus === "fail"}
            >
              <Search size={15} /> Discover customers
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 4 && connectionId ? (
        <Card className="max-w-3xl space-y-4 p-4">
          {discover.isPending ? (
            <p className="text-sm text-[var(--text-muted)]">
              Enumerating customers, subscriptions, host pools and Log Analytics workspaces…
            </p>
          ) : discover.isError ? (
            <Alert tone="critical" title="Discovery failed">
              {(discover.error as Error).message}
            </Alert>
          ) : discover.data ? (
            <>
              <Alert tone="good" title="Discovery complete">
                {discover.data.tenants} customer(s), {discover.data.subscriptions} subscription(s),{" "}
                {discover.data.workspaces} Log Analytics workspace(s), {discover.data.hostPools} host pool(s).
              </Alert>
              <p className="text-sm text-[var(--text-secondary)]">
                Everything discovered is enabled by default. Use{" "}
                <Link href="/customers" className="underline">
                  Customers
                </Link>{" "}
                to narrow it down before the first backfill, or start syncing now — the backfill pulls the
                last 30 days by default.
              </p>
              {sync.isSuccess ? (
                <Alert tone="good">
                  Queued {sync.data.queued} jobs. Watch progress on the{" "}
                  <Link href="/sync" className="underline">
                    sync health
                  </Link>{" "}
                  page — the first pass can take a few minutes.
                </Alert>
              ) : null}
              <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
                <Link href="/customers">
                  <Button variant="outline">Choose what to sync</Button>
                </Link>
                <Button onClick={() => sync.mutate(connectionId)} disabled={sync.isPending || sync.isSuccess}>
                  {sync.isPending ? "Queueing…" : "Start the first sync"}
                </Button>
                {sync.isSuccess ? (
                  <Link href="/dashboards/new" className="ml-auto">
                    <Button>
                      <Sparkles size={15} /> Build a dashboard
                    </Button>
                  </Link>
                ) : null}
              </div>
            </>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

function defaultName(type: ConnectionType): string {
  switch (type) {
    case "azure":
      return "Azure";
    case "lighthouse":
      return "Lighthouse";
    case "partner-center":
      return "Partner Center";
    case "nerdio":
      return "Nerdio Manager";
    default:
      return "Connection";
  }
}

function buildConfig(type: ConnectionType, form: FormState): Record<string, unknown> {
  const credentialMode =
    form.secretMode === "managed-identity" ? "managed-identity" : ("client-secret" as const);
  switch (type) {
    case "azure":
      return {
        type: "azure",
        tenantId: form.tenantId,
        credentialMode,
        clientId: form.clientId || undefined,
        subscriptionIds: form.subscriptionIds
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      };
    case "lighthouse":
      return {
        type: "lighthouse",
        tenantId: form.tenantId,
        credentialMode,
        clientId: form.clientId || undefined,
        includeHomeTenant: form.includeHomeTenant,
      };
    case "partner-center":
      return {
        type: "partner-center",
        partnerTenantId: form.tenantId,
        clientId: form.clientId,
        credentialMode: "client-secret",
      };
    case "nerdio":
      return {
        type: "nerdio",
        edition: form.edition,
        baseUrl: form.baseUrl,
        tenantId: form.tenantId,
        clientId: form.clientId,
        scope: form.scope,
        credentialMode: "client-secret",
        endpoints: {},
      };
    default:
      return { type: "demo", tenants: 4 };
  }
}
