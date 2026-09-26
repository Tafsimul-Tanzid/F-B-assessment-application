/**
 * Adds the `companies` table.
 *
 * The scenario is explicitly "a single company operates multiple outlets," so
 * this is one row and a plain FK from `outlets` - no join table, because a
 * many-to-many would model a relationship that does not exist here. It exists
 * as its own table (rather than a hardcoded name in application code) so the
 * schema matches the entity list the brief's ERD asks for, and so multi-tenant
 * support later is a data change, not a schema change.
 */

export async function up({ context: queryInterface }) {
  const sql = queryInterface.sequelize;

  await sql.query(`
    CREATE TABLE companies (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name       text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT companies_name_key UNIQUE (name)
    );

    -- Nullable for the ALTER, then backfilled and locked to NOT NULL below -
    -- an existing outlets table cannot have a NOT NULL FK added in one step
    -- without a value to backfill it with.
    ALTER TABLE outlets ADD COLUMN company_id uuid;

    INSERT INTO companies (name) VALUES ('Demo F&B Company');

    UPDATE outlets SET company_id = (SELECT id FROM companies LIMIT 1);

    ALTER TABLE outlets
      ALTER COLUMN company_id SET NOT NULL,
      ADD CONSTRAINT outlets_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE RESTRICT;

    -- Every outlet query is already scoped by outlet id, never by company, so
    -- this is a lookup index rather than a hot-path one - kept simple (btree,
    -- no covering columns) because there is exactly one company today.
    CREATE INDEX outlets_company_id_idx ON outlets (company_id);
  `);
}

export async function down({ context: queryInterface }) {
  const sql = queryInterface.sequelize;
  await sql.query(`
    DROP INDEX IF EXISTS outlets_company_id_idx;
    ALTER TABLE outlets DROP CONSTRAINT IF EXISTS outlets_company_id_fkey;
    ALTER TABLE outlets DROP COLUMN IF EXISTS company_id;
    DROP TABLE IF EXISTS companies;
  `);
}
