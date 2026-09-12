import type { ExportConfig } from '../types.js';
import { shCommentSafe } from '../sh.js';

export const GENERATOR_NAME = 'HANAScriptGenerator';

/** Dateiname des Auslagerungsskripts, an mehreren Stellen gebraucht. */
export const OFFLOAD_SCRIPT_NAME = '06_offload_storagebox.sh';

/** Trennlinie in Skriptkommentaren. */
export const RULE = '# ------------------------------------------------------------';
export const HEAVY_RULE = '# ============================================================';

/** Basisname einer Datei, z. B. `schema_export.sh` aus dem Zielpfad. */
export function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Verzeichnisanteil eines Pfades ohne abschließenden Slash. */
export function dirName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/** Für Dateinamen verwendbarer Kundenschlüssel. */
export function customerSlug(customer: string, fallback: string): string {
  const slug = customer
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return slug.length > 0 ? slug : fallback.toUpperCase();
}

/** Dateiendung des Archivs zur gewählten Komprimierung. */
export function archiveExtension(compression: ExportConfig['compression']): string {
  switch (compression) {
    case 'gz':
      return 'tar.gz';
    case 'zst':
      return 'tar.zst';
    case 'none':
      return 'tar';
  }
}

/** Klartextbezeichnung der Komprimierung für Kommentare und Anleitung. */
export function compressionLabel(compression: ExportConfig['compression']): string {
  switch (compression) {
    case 'gz':
      return 'tar + gzip';
    case 'zst':
      return 'tar + zstd';
    case 'none':
      return 'tar ohne Komprimierung';
  }
}

/**
 * Gemeinsamer Kommentarkopf aller generierten Skripte. `lines` ergänzt den
 * Block um skriptspezifische Hinweise.
 */
export function scriptHeader(config: ExportConfig, title: string, lines: string[] = []): string {
  const header = [
    '#!/bin/bash',
    '#',
    HEAVY_RULE,
    `#  ${title}`,
    '#',
    `#  Kunde       : ${shCommentSafe(config.customer) || '-'}`,
    `#  Tenant      : ${config.sid} (Instanz ${config.instance})`,
    `#  Host        : ${config.host}:${config.port}`,
    `#  DB-Benutzer : ${config.dbUser} über hdbuserstore-Key ${config.userstoreKey}`,
    `#  Linux-User  : ${config.osUser}`,
    '#',
    ...lines.map((line) => `#  ${line}`),
    ...(lines.length > 0 ? ['#'] : []),
    `#  Generiert durch ${GENERATOR_NAME}.`,
    HEAVY_RULE,
  ];
  return header.join('\n');
}

/**
 * Prüft zur Laufzeit, dass das Skript unter dem vorgesehenen Linux-Benutzer
 * läuft. Der hdbuserstore ist benutzerspezifisch, deshalb schlägt ein Lauf
 * unter root oder einem anderen Benutzer sonst erst bei der Anmeldung fehl.
 */
export function userGuard(config: ExportConfig, indent = ''): string {
  return [
    `if [ "$(whoami)" != "${config.osUser}" ]; then`,
    `    echo "FEHLER: Dieses Skript muss als ${config.osUser} laufen (aktuell: $(whoami))." >&2`,
    `    echo "Hinweis: der hdbuserstore-Key ${config.userstoreKey} existiert nur für ${config.osUser}." >&2`,
    '    exit 1',
    'fi',
  ]
    .map((line) => (line.length > 0 ? indent + line : line))
    .join('\n');
}

/** Bash-Array-Literal der Schemaliste. */
export function schemaArray(config: ExportConfig, variable = 'SCHEMAS'): string {
  const entries = config.schemas.map((schema) => `    "${schema}"`).join('\n');
  return `${variable}=(\n${entries}\n)`;
}

/** Kommaseparierte, SQL-taugliche Liste der Schemanamen. */
export function schemaSqlList(config: ExportConfig): string {
  return config.schemas.map((schema) => `'${schema}'`).join(',');
}
