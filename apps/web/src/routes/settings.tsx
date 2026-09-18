import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "../components/layout";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Skeleton, useToast } from "../components/ui";
import { api, type Me } from "../lib/api";

/** Instance settings, plus the security posture an operator should be able to see at a glance. */
export function SettingsPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isPending } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");

  useEffect(() => {
    if (data) {
      setName(data.instance.name);
      setOrganizationName(data.instance.organizationName);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.saveSettings({ name, organizationName }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Settings saved");
    },
    onError: (error) => toast.error("Could not save", (error as Error).message),
  });

  if (isPending || !data) return <Skeleton className="h-64" />;

  const isOwner = me.user.role === "owner";
  const posture = [
    {
      label: "Sign-in handled by Entra ID (EasyAuth)",
      ok: data.runtime.authMode === "easyauth",
      detail:
        data.runtime.authMode === "easyauth"
          ? "Requests are authenticated by the platform before they reach the app."
          : "AUTH_MODE=dev trusts every request. Fine locally, never in production.",
    },
    {
      label: "Id token signature verified",
      ok: data.runtime.tokenValidation,
      detail: data.runtime.tokenValidation
        ? "The forwarded id token is checked against Entra's keys."
        : "Optional. Set EASYAUTH_VALIDATE_TOKEN=true with the token store enabled for defence in depth.",
    },
    {
      label: "Connection secrets in Key Vault",
      ok: data.runtime.keyVault,
      detail: data.runtime.keyVault
        ? "Secrets are read at runtime with the managed identity; only names are stored."
        : data.runtime.encryptionKey
          ? "No Key Vault configured — secrets are AES-256-GCM encrypted in Postgres instead."
          : "Neither Key Vault nor APP_ENCRYPTION_KEY is configured, so secrets cannot be stored at all.",
    },
    {
      label: "User names pseudonymized",
      ok: data.runtime.pseudonymizeUsers,
      detail: data.runtime.pseudonymizeUsers
        ? "UPNs are hashed with a per-instance salt before they are stored."
        : "PSEUDONYMIZE_USERS=false — real user names are stored and shown in drill-through.",
    },
    {
      label: "Sign-in restricted to specific tenants",
      ok: data.runtime.allowedTenants.length > 0,
      detail:
        data.runtime.allowedTenants.length > 0
          ? `${data.runtime.allowedTenants.length} tenant(s) allowed.`
          : "ALLOWED_TENANT_IDS is empty, so any tenant EasyAuth admits can sign in.",
    },
  ];

  return (
    <>
      <PageHeader title="Settings" description="How this instance is configured, and what it is trusting." />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Instance" subtitle="Shown in the app and on customer-facing dashboards" />
          <div className="space-y-3 px-4 pb-4">
            <Field label="Instance name">
              <Input value={name} disabled={!isOwner} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Your organization" hint="Appears on customer reports. Leave empty to omit it.">
              <Input
                value={organizationName}
                disabled={!isOwner}
                placeholder="Contoso Managed Services"
                onChange={(event) => setOrganizationName(event.target.value)}
              />
            </Field>
            {isOwner ? (
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            ) : (
              <Alert tone="neutral">Only an owner can change these.</Alert>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Security posture" subtitle="Each line is a real setting, not a recommendation" />
          <ul className="space-y-2.5 px-4 pb-4">
            {posture.map((item) => (
              <li key={item.label} className="flex gap-2.5">
                {item.ok ? (
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[var(--good)]" />
                ) : (
                  <XCircle size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
                )}
                <div>
                  <p className="text-[13px] font-medium text-[var(--text-primary)]">{item.label}</p>
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">{item.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Runtime" />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 pb-4 text-[13px]">
            <Row label="Version" value={data.runtime.version} />
            <Row label="Commit" value={data.runtime.commit || "—"} />
            <Row label="Role" value={data.runtime.appRole} />
            <Row label="Demo data" value={data.runtime.demoMode ? "on" : "off"} />
            <Row label="Connections" value={String(data.counts.connections)} />
            <Row label="Customers" value={String(data.counts.customers)} />
            <Row label="Dashboards" value={String(data.counts.dashboards)} />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Data protection" />
          <div className="space-y-2 px-4 pb-4 text-sm text-[var(--text-secondary)]">
            <p className="flex items-start gap-2">
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" />
              DashFlow only ever makes read calls to Microsoft and Nerdio. Nothing is written back to your
              tenants, and no telemetry leaves this container.
            </p>
            <p>
              Retention is set per connection, and a daily job deletes facts past it. Turning a customer off
              keeps their history but hides it from dashboards.
            </p>
            {data.runtime.demoMode ? (
              <Alert tone="warning" title="Demo mode is on">
                A synthetic connection is generating fake customers. Set <code>DEMO_MODE=false</code> and
                delete that connection before this instance is used for real work.
              </Alert>
            ) : null}
          </div>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="text-right">
        <Badge>{value}</Badge>
      </dd>
    </>
  );
}
