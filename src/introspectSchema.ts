import type { SqlStorage } from './types.js';

export interface ColumnInfo {
  name: string;
  /** SQLite declared type as written in CREATE TABLE (e.g. "INTEGER", "TEXT", ""). */
  declaredType: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export interface TableSchema {
  name: string;
  columns: ColumnInfo[];
}

/**
 * Read every user table out of a Durable Object's SQLite storage. Skips
 * SQLite system tables and Cloudflare's internal `_cf_*` tables.
 *
 * Intended as a one-shot migration aid: run this from inside a DO, capture
 * the result, then feed it through `generateKyselyDbInterface()` to bootstrap
 * a Kysely `DB` interface from a hand-rolled schema.
 */
export function introspectSchema(sql: SqlStorage): TableSchema[] {
  const tables = sql
    .exec<{ name: string }>(
      `select name from sqlite_master
       where type = 'table'
         and name not like 'sqlite_%'
         and name not like '_cf_%'
       order by name`,
    )
    .toArray();

  return tables.map(({ name }) => ({
    name,
    columns: readColumns(sql, name),
  }));
}

function readColumns(sql: SqlStorage, table: string): ColumnInfo[] {
  // PRAGMA can't take a bound parameter, so identifier-quote the name.
  const quoted = `"${table.replace(/"/g, '""')}"`;
  const rows = sql
    .exec<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>(`pragma table_info(${quoted})`)
    .toArray();

  return rows.map((r) => ({
    name: r.name,
    declaredType: r.type ?? '',
    notNull: r.notnull === 1,
    primaryKey: r.pk > 0,
    defaultValue: r.dflt_value,
  }));
}

/**
 * Convert an introspected schema into a Kysely `DB` interface as a string.
 * Maps SQLite type affinities to TypeScript types:
 *
 *   INTEGER → number
 *   REAL    → number
 *   TEXT    → string
 *   BLOB    → Uint8Array
 *   (other) → unknown
 *
 * Nullable columns are emitted as `T | null`.
 */
export function generateKyselyDbInterface(
  tables: TableSchema[],
  options: { interfaceName?: string } = {},
): string {
  const interfaceName = options.interfaceName ?? 'DB';
  const tableTypes = tables.map((t) => emitTable(t)).join('\n\n');
  const dbFields = tables
    .map((t) => `  ${quoteKeyIfNeeded(t.name)}: ${pascal(t.name)};`)
    .join('\n');

  return `${tableTypes}\n\nexport interface ${interfaceName} {\n${dbFields}\n}\n`;
}

function emitTable(table: TableSchema): string {
  const fields = table.columns
    .map((col) => {
      const tsType = sqliteTypeToTs(col.declaredType);
      const optional = col.notNull ? tsType : `${tsType} | null`;
      return `  ${quoteKeyIfNeeded(col.name)}: ${optional};`;
    })
    .join('\n');
  return `export interface ${pascal(table.name)} {\n${fields}\n}`;
}

function sqliteTypeToTs(declared: string): string {
  const t = declared.toUpperCase();
  if (t.includes('INT')) return 'number';
  if (t.includes('CHAR') || t.includes('TEXT') || t.includes('CLOB')) return 'string';
  if (t.includes('BLOB')) return 'Uint8Array';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'number';
  if (t.includes('NUM') || t.includes('DEC')) return 'number';
  return 'unknown';
}

function pascal(name: string): string {
  return name
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function quoteKeyIfNeeded(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
}
