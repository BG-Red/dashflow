CREATE TABLE "app_groups" (
	"resource_id" text PRIMARY KEY NOT NULL,
	"customer_tenant_id" uuid NOT NULL,
	"host_pool_id" text,
	"name" text NOT NULL,
	"group_type" text DEFAULT 'Desktop' NOT NULL,
	"workspace_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autoscale_events" (
	"key" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"tenant_id" uuid NOT NULL,
	"host_pool_id" text,
	"action" text NOT NULL,
	"hosts_before" integer,
	"hosts_after" integer,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "connection_facts" (
	"correlation_id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"host_pool_id" text,
	"ts" timestamp with time zone NOT NULL,
	"user_key" text NOT NULL,
	"session_host" text,
	"client_os" text,
	"client_type" text,
	"client_version" text,
	"gateway_region" text,
	"state" text NOT NULL,
	"connect_ms" integer,
	"rtt_ms" integer,
	"bandwidth_kbps" integer,
	"duration_sec" integer
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"secret_id" uuid,
	"refresh_secret_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test" jsonb,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "cost_daily" (
	"key" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"tenant_id" uuid NOT NULL,
	"host_pool_id" text,
	"meter_category" text DEFAULT 'Other' NOT NULL,
	"cost" numeric(18, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"estimated_savings" numeric(18, 4)
);
--> statement-breakpoint
CREATE TABLE "customer_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"domain" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tenants_conn_tenant" UNIQUE("connection_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"goal" text DEFAULT 'blank' NOT NULL,
	"widgets" jsonb NOT NULL,
	"default_preset" text DEFAULT '7d' NOT NULL,
	"tenant_scope" jsonb,
	"visibility" text DEFAULT 'private' NOT NULL,
	"shared_with_role" text DEFAULT 'viewer' NOT NULL,
	"owner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_facts" (
	"key" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"host_pool_id" text,
	"ts" timestamp with time zone NOT NULL,
	"correlation_id" text,
	"code" text NOT NULL,
	"source" text,
	"message" text,
	"service_error" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_health" (
	"ts" timestamp with time zone NOT NULL,
	"session_host" text NOT NULL,
	"host_pool_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text NOT NULL,
	"healthy" boolean NOT NULL,
	"drain" boolean DEFAULT false NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "host_health_ts_host_pool_id_session_host_pk" PRIMARY KEY("ts","host_pool_id","session_host")
);
--> statement-breakpoint
CREATE TABLE "host_pools" (
	"resource_id" text PRIMARY KEY NOT NULL,
	"customer_tenant_id" uuid NOT NULL,
	"connection_id" uuid,
	"subscription_id" text,
	"name" text NOT NULL,
	"friendly_name" text,
	"location" text DEFAULT 'unknown' NOT NULL,
	"pool_type" text DEFAULT 'Pooled' NOT NULL,
	"load_balancer" text,
	"max_sessions" integer,
	"start_vm_on_connect" boolean,
	"validation_environment" boolean,
	"preferred_app_group_type" text,
	"autoscale_enabled" boolean,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"dedupe_key" text,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_dedupe_unique" UNIQUE NULLS NOT DISTINCT("dedupe_key","status")
);
--> statement-breakpoint
CREATE TABLE "log_analytics_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_tenant_id" uuid NOT NULL,
	"resource_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"host_pool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "la_workspaces_tenant_resource" UNIQUE("customer_tenant_id","resource_id")
);
--> statement-breakpoint
CREATE TABLE "perf_hourly" (
	"ts" timestamp with time zone NOT NULL,
	"session_host" text NOT NULL,
	"host_pool_id" text,
	"tenant_id" uuid NOT NULL,
	"cpu_pct" double precision,
	"mem_available_mb" double precision,
	CONSTRAINT "perf_hourly_ts_session_host_pk" PRIMARY KEY("ts","session_host")
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"customer_tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "scaling_plans" (
	"resource_id" text PRIMARY KEY NOT NULL,
	"customer_tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"time_zone" text,
	"host_pool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedules" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text,
	"iv" text,
	"auth_tag" text,
	"key_vault_secret_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_hosts" (
	"resource_id" text PRIMARY KEY NOT NULL,
	"host_pool_id" text NOT NULL,
	"customer_tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"vm_resource_id" text,
	"status" text DEFAULT 'Unknown' NOT NULL,
	"allow_new_session" boolean DEFAULT true NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"agent_version" text,
	"os_version" text,
	"last_heart_beat" timestamp with time zone,
	"update_state" text,
	"source" text DEFAULT 'azure' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_snapshots" (
	"ts" timestamp with time zone NOT NULL,
	"host_pool_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"active_sessions" integer DEFAULT 0 NOT NULL,
	"disconnected_sessions" integer DEFAULT 0 NOT NULL,
	"capacity" integer DEFAULT 0 NOT NULL,
	"available_hosts" integer DEFAULT 0 NOT NULL,
	"total_hosts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "session_snapshots_ts_host_pool_id_pk" PRIMARY KEY("ts","host_pool_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_tenant_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "subscriptions_tenant_sub" UNIQUE("customer_tenant_id","subscription_id")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"customer_tenant_id" uuid,
	"stream" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"oid" text NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_oid_unique" UNIQUE("oid")
);
--> statement-breakpoint
CREATE TABLE "watermarks" (
	"connection_id" uuid NOT NULL,
	"customer_tenant_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"value" timestamp with time zone NOT NULL,
	CONSTRAINT "watermarks_connection_id_customer_tenant_id_stream_pk" PRIMARY KEY("connection_id","customer_tenant_id","stream")
);
--> statement-breakpoint
ALTER TABLE "app_groups" ADD CONSTRAINT "app_groups_customer_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("customer_tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_groups" ADD CONSTRAINT "app_groups_host_pool_id_host_pools_resource_id_fk" FOREIGN KEY ("host_pool_id") REFERENCES "public"."host_pools"("resource_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autoscale_events" ADD CONSTRAINT "autoscale_events_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autoscale_events" ADD CONSTRAINT "autoscale_events_host_pool_id_host_pools_resource_id_fk" FOREIGN KEY ("host_pool_id") REFERENCES "public"."host_pools"("resource_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_facts" ADD CONSTRAINT "connection_facts_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_facts" ADD CONSTRAINT "connection_facts_host_pool_id_host_pools_resource_id_fk" FOREIGN KEY ("host_pool_id") REFERENCES "public"."host_pools"("resource_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_refresh_secret_id_secrets_id_fk" FOREIGN KEY ("refresh_secret_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_daily" ADD CONSTRAINT "cost_daily_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_daily" ADD CONSTRAINT "cost_daily_host_pool_id_host_pools_resource_id_fk" FOREIGN KEY ("host_pool_id") REFERENCES "public"."host_pools"("resource_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tenants" ADD CONSTRAINT "customer_tenants_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_facts" ADD CONSTRAINT "error_facts_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_facts" ADD CONSTRAINT "error_facts_host_pool_id_host_pools_resource_id_fk" FOREIGN KEY ("host_pool_id") REFERENCES "public"."host_pools"("resource_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_health" ADD CONSTRAINT "host_health_host_pool_id_host_pools_resource_id_fk" FOREIGN KEY ("host_pool_id") REFERENCES "public"."host_pools"("resource_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_health" ADD CONSTRAINT "host_health_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_pools" ADD CONSTRAINT "host_pools_customer_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("customer_tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_pools" ADD CONSTRAINT "host_pools_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_analytics_workspaces" ADD CONSTRAINT "log_analytics_workspaces_customer_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("customer_tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perf_hourly" ADD CONSTRAINT "perf_hourly_host_pool_id_host_pools_resource_id_fk" FOREIGN KEY ("host_pool_id") REFERENCES "public"."host_pools"("resource_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perf_hourly" ADD CONSTRAINT "perf_hourly_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_customer_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("customer_tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scaling_plans" ADD CONSTRAINT "scaling_plans_customer_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("customer_tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_hosts" ADD CONSTRAINT "session_hosts_host_pool_id_host_pools_resource_id_fk" FOREIGN KEY ("host_pool_id") REFERENCES "public"."host_pools"("resource_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_hosts" ADD CONSTRAINT "session_hosts_customer_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("customer_tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_snapshots" ADD CONSTRAINT "session_snapshots_host_pool_id_host_pools_resource_id_fk" FOREIGN KEY ("host_pool_id") REFERENCES "public"."host_pools"("resource_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_snapshots" ADD CONSTRAINT "session_snapshots_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("customer_tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_customer_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("customer_tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watermarks" ADD CONSTRAINT "watermarks_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watermarks" ADD CONSTRAINT "watermarks_customer_tenant_id_customer_tenants_id_fk" FOREIGN KEY ("customer_tenant_id") REFERENCES "public"."customer_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autoscale_events_tenant_ts" ON "autoscale_events" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "connection_facts_tenant_ts" ON "connection_facts" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "connection_facts_pool_ts" ON "connection_facts" USING btree ("host_pool_id","ts");--> statement-breakpoint
CREATE INDEX "cost_daily_tenant_ts" ON "cost_daily" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "dashboards_owner_idx" ON "dashboards" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "error_facts_tenant_ts" ON "error_facts" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "error_facts_code" ON "error_facts" USING btree ("code");--> statement-breakpoint
CREATE INDEX "host_health_tenant_ts" ON "host_health" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "host_pools_tenant_idx" ON "host_pools" USING btree ("customer_tenant_id");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "perf_hourly_tenant_ts" ON "perf_hourly" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "role_assignments_user_idx" ON "role_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_hosts_pool_idx" ON "session_hosts" USING btree ("host_pool_id");--> statement-breakpoint
CREATE INDEX "session_snapshots_tenant_ts" ON "session_snapshots" USING btree ("tenant_id","ts");--> statement-breakpoint
CREATE INDEX "sync_runs_recent_idx" ON "sync_runs" USING btree ("started_at");