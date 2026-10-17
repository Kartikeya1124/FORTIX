CREATE TABLE IF NOT EXISTS "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"route_id" text NOT NULL,
	"profile" text NOT NULL,
	"status" text NOT NULL,
	"params" jsonb NOT NULL,
	"timeline" jsonb NOT NULL,
	"deterministic_verdict" jsonb,
	"ai_analysis" jsonb,
	"evidence_summary" jsonb,
	"cleanup_status" text DEFAULT 'NOT_REQUIRED' NOT NULL,
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "workflow_runs_route_id_api_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "api_routes"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_project_idx" ON "workflow_runs" USING btree ("project_id","created_at");
