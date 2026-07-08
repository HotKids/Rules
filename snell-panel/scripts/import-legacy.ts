#!/usr/bin/env bun
/*
 * Import nodes from the legacy Gin panel into the new D1 schema.
 *
 * Fetches the old `/entries` API, drops V5 nodes (the legacy USIT7 node), keeps
 * the original `node_id` (uuid) for continuity, and lets D1 assign fresh
 * integer ids starting at 1. Emits SQL to stdout (progress to stderr).
 *
 * Usage:
 *   bun scripts/import-legacy.ts "https://old-panel/entries?token=..." > import.sql
 *   bunx wrangler d1 execute snell-panel --remote --file=import.sql   # from repo root
 */

interface LegacyEntry {
  ip: string;
  port: number;
  psk: string;
  country_code: string | null;
  isp: string | null;
  asn: number | null;
  node_id: string;
  node_name: string;
  version: string;
  tfo: boolean;
}

const url = process.argv[2];
if (!url) {
  console.error('usage: bun scripts/import-legacy.ts "<legacy_entries_url_with_token>"');
  process.exit(1);
}

const res = await fetch(url, { headers: { "User-Agent": "snell-panel-import" } });
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const json = (await res.json()) as unknown;
const entries: LegacyEntry[] = Array.isArray(json)
  ? (json as LegacyEntry[])
  : ((json as { data?: LegacyEntry[]; entries?: LegacyEntry[] }).data ??
     (json as { entries?: LegacyEntry[] }).entries ??
     []);

// Drop V5 nodes (V5↔V6 are not interoperable; the only V5 node is the legacy USIT7).
const keep = entries.filter((e) => String(e.version) !== "5");
const dropped = entries.length - keep.length;

const now = Math.floor(Date.now() / 1000);
const s = (v: string | null | undefined) =>
  v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const n = (v: number | null | undefined) =>
  v === null || v === undefined || (v as unknown) === "" ? "NULL" : Number(v);
const b = (v: unknown) => (v ? 1 : 0);

const cols =
  "node_id, node_name, version, status, ip, port, psk, country_code, isp, asn, tfo, ip_prefilled, port_prefilled, created_at, registered_at";

const sql = keep
  .map((e) =>
    `INSERT INTO nodes (${cols}) VALUES (${[
      s(e.node_id),
      s(e.node_name),
      s(String(e.version)),
      "'active'",
      s(e.ip),
      n(e.port),
      s(e.psk),
      s(e.country_code),
      s(e.isp),
      n(e.asn),
      b(e.tfo),
      0,
      0,
      now,
      now,
    ].join(", ")});`,
  )
  .join("\n");

console.error(
  `Importing ${keep.length} of ${entries.length} entries (dropped ${dropped} V5). ` +
    `Integer ids will auto-assign from 1; node_id (uuid) preserved.`,
);
console.log(sql);
