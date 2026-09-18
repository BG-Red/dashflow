import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Alert, Button, Card, CodeBlock, Field, Input } from "../components/ui";
import { api, type Me } from "../lib/api";

/**
 * First run. The one-time code is printed to the container logs, so whoever can read the
 * logs — the person who deployed this — becomes the owner. Nobody else can claim it.
 */
export function ClaimPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const claim = useMutation({
    mutationFn: () => api.claim(code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--accent)] text-sm font-bold text-[var(--accent-ink)]">
          AVD
        </span>
        <div>
          <h1 className="text-base font-semibold tracking-tight">DashFlow</h1>
          <p className="text-xs text-[var(--text-muted)]">Self-hosted Azure Virtual Desktop insight</p>
        </div>
      </div>

      <Card className="space-y-4 p-5">
        <div className="flex gap-3">
          <ShieldCheck size={20} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          <div>
            <h2 className="text-sm font-semibold">Claim this instance</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              You are signed in as{" "}
              <span className="font-medium text-[var(--text-primary)]">{me.user.email}</span>. Enter the
              one-time setup code from the container logs to become the owner.
            </p>
          </div>
        </div>

        <CodeBlock
          label="find the code"
          code={`# Azure Container Apps
az containerapp logs show -n <app-name> -g <resource-group> --tail 200 | grep -A3 "first-run setup"

# Docker
docker compose logs app | grep -A3 "first-run setup"`}
        />

        <Field label="Setup code">
          <Input
            value={code}
            autoFocus
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter" && code.length > 3) claim.mutate();
            }}
          />
        </Field>

        {claim.isError ? <Alert tone="critical">{(claim.error as Error).message}</Alert> : null}

        <Button
          size="lg"
          className="w-full"
          onClick={() => claim.mutate()}
          disabled={claim.isPending || code.length < 4}
        >
          <KeyRound size={16} /> {claim.isPending ? "Checking…" : "Claim ownership"}
        </Button>

        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
          Deploying with infrastructure as code? Set <code>BOOTSTRAP_OWNER_OIDS</code> to the Entra object IDs
          that should become owners, and this step is skipped entirely.
        </p>
      </Card>
    </div>
  );
}

/** Shown to a signed-in user who has no role yet. */
export function NoAccessPage({ me }: { me: Me }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <Card className="space-y-3 p-5">
        <h1 className="text-sm font-semibold">You do not have access yet</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Your sign-in worked, but nobody has granted you a role in this instance. An admin can do that under
          Users & roles.
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          Signed in as {me.user.email}. Ask them to search for that address.
        </p>
      </Card>
    </div>
  );
}
