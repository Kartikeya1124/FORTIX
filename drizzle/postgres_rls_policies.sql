-- PostgreSQL Defense-in-Depth Row-Level Security (RLS) Policies for FortiX
-- Enforces tenant isolation when app.current_user_id is set on pooled database transactions,
-- while permitting explicit migration/maintenance sessions where app.current_user_id is unset.

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fortix_organizations_tenant_isolation" ON "organizations";
CREATE POLICY "fortix_organizations_tenant_isolation" ON "organizations"
  USING (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR "owner_id" = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR "owner_id" = current_setting('app.current_user_id', true)
  );

ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fortix_projects_tenant_isolation" ON "projects";
CREATE POLICY "fortix_projects_tenant_isolation" ON "projects"
  USING (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR EXISTS (
      SELECT 1 FROM "organizations" o
      WHERE o."id" = "projects"."org_id"
        AND o."owner_id" = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR EXISTS (
      SELECT 1 FROM "organizations" o
      WHERE o."id" = "projects"."org_id"
        AND o."owner_id" = current_setting('app.current_user_id', true)
    )
  );

ALTER TABLE "api_routes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fortix_api_routes_tenant_isolation" ON "api_routes";
CREATE POLICY "fortix_api_routes_tenant_isolation" ON "api_routes"
  USING (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR EXISTS (
      SELECT 1 FROM "projects" p
      JOIN "organizations" o ON o."id" = p."org_id"
      WHERE p."id" = "api_routes"."project_id"
        AND o."owner_id" = current_setting('app.current_user_id', true)
    )
  );

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fortix_api_keys_tenant_isolation" ON "api_keys";
CREATE POLICY "fortix_api_keys_tenant_isolation" ON "api_keys"
  USING (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR EXISTS (
      SELECT 1 FROM "projects" p
      JOIN "organizations" o ON o."id" = p."org_id"
      WHERE p."id" = "api_keys"."project_id"
        AND o."owner_id" = current_setting('app.current_user_id', true)
    )
  );

ALTER TABLE "webhooks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fortix_webhooks_tenant_isolation" ON "webhooks";
CREATE POLICY "fortix_webhooks_tenant_isolation" ON "webhooks"
  USING (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR EXISTS (
      SELECT 1 FROM "projects" p
      JOIN "organizations" o ON o."id" = p."org_id"
      WHERE p."id" = "webhooks"."project_id"
        AND o."owner_id" = current_setting('app.current_user_id', true)
    )
  );

ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fortix_workflow_runs_tenant_isolation" ON "workflow_runs";
CREATE POLICY "fortix_workflow_runs_tenant_isolation" ON "workflow_runs"
  USING (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR EXISTS (
      SELECT 1 FROM "projects" p
      JOIN "organizations" o ON o."id" = p."org_id"
      WHERE p."id" = "workflow_runs"."project_id"
        AND o."owner_id" = current_setting('app.current_user_id', true)
    )
  );
