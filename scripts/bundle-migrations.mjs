// Une migraciones en un solo script para pegarlo en Supabase → SQL Editor.
//
//   npm run db:bundle -- 0008          → desde la 0008 hasta la última
//   npm run db:bundle -- 0008 0012     → de la 0008 a la 0012
//
// El resultado va en una transacción (todo o nada) y se escribe en supabase/scripts/aplicar.sql
// (ignorado por git: se regenera cuando haga falta). Las migraciones deben poder repetirse sin error.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "supabase", "migrations");
const [from = "0000", to = "9999"] = process.argv.slice(2);

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => f.slice(0, 4) >= from.padStart(4, "0") && f.slice(0, 4) <= to.padStart(4, "0"));

if (files.length === 0) {
  console.error(`No hay migraciones entre ${from} y ${to}.`);
  process.exit(1);
}

// Los ANALYZE de cada migración se agrupan al final, cuando ya existen todas las tablas e índices.
const analyze = [];
const body = files
  .map((f) => {
    const sql = fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n").replace(/^analyze\s[^;]+;\s*$/gim, (m) => {
      analyze.push(m.trim());
      return "";
    });
    return `-- ───────────────────────────── ${f}\n\n${sql.trim()}\n`;
  })
  .join("\n");

const out = [
  "-- ═══════════════════════════════════════════════════════════════════════════",
  `-- Migraciones ${files.map((f) => f.slice(0, 4)).join(", ")} · generado con npm run db:bundle`,
  "-- Pega TODO este archivo en Supabase → SQL Editor → Run.",
  "-- Va en una transacción: si algo falla, no se aplica nada a medias.",
  "-- ═══════════════════════════════════════════════════════════════════════════",
  "",
  "begin;",
  "",
  body,
  "commit;",
  "",
  ...analyze,
  "",
].join("\n");

const target = path.join(root, "supabase", "scripts", "aplicar.sql");
fs.writeFileSync(target, out);
console.log(`${path.relative(root, target)}: ${files.join(", ")}`);
