import type { ExportConfig } from '../types.js';
import { shCommentSafe } from '../sh.js';

export const GENERATOR_NAME = 'HANAScriptGenerator';

/**
 * Stand des Generators. Der typeof-Test faengt den Fall ab, dass der Wert
 * nicht eingesetzt wurde – dann steht dort ein ehrliches "unbekannt" statt
 * eines Absturzes.
 */
export const GENERATOR_VERSION =
  typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'Stand unbekannt';

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
    `#  Erzeugt durch ${GENERATOR_NAME}, Stand ${GENERATOR_VERSION}.`,
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

/** Die Liste der zu sichernden Schemas, auf dem Server neben den Skripten. */
export const SCHEMA_FILE_NAME = 'export_schemas.txt';

/** Die Betriebswerte, auf dem Server neben den Skripten. */
export const EXPORT_CONF_NAME = 'export.conf';

/**
 * Bash-Block, der die Schemaliste neben dem Skript liest. Er definiert nur;
 * gelesen wird mit `read_schema_file`, damit jedes Skript selbst entscheidet,
 * wie es auf eine fehlende Datei reagiert.
 *
 * Gesucht wird neben dem laufenden Skript und nicht unter einem fest
 * eingetragenen Pfad: Skripte und Liste werden immer gemeinsam abgelegt.
 */
export function schemaFileReader(): string {
  return `${RULE}
#  Schemaliste
#
#  Die Schemas stehen nicht im Skript, sondern in ${SCHEMA_FILE_NAME} im
#  selben Verzeichnis. Ein Schema pro Zeile; Leerzeilen und Kommentare mit
#  # werden uebergangen. Aenderungen dort gelten ab dem naechsten Lauf.
${RULE}

SCHEMA_FILE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/${SCHEMA_FILE_NAME}"
SCHEMAS=()
SCHEMA_FILE_ISSUES=()

# Liest SCHEMA_FILE nach SCHEMAS. Unbrauchbare Zeilen landen mit ihrer
# Nummer in SCHEMA_FILE_ISSUES, doppelte werden still uebergangen.
# Endet mit 1, wenn die Datei fehlt oder nicht lesbar ist.
read_schema_file()
{
    local LINE NAME KNOWN DUPLICATE
    local NUMBER=0
    local PATTERN='^[A-Za-z_][A-Za-z0-9_#$]*$'

    SCHEMAS=()
    SCHEMA_FILE_ISSUES=()

    [ -r "\${SCHEMA_FILE}" ] || return 1

    while IFS= read -r LINE || [ -n "\${LINE}" ]
    do
        NUMBER=$((NUMBER + 1))

        # Windows-Zeilenende, falls die Datei dort bearbeitet wurde.
        LINE="\${LINE%$'\\r'}"

        # Fuehrenden Leerraum entfernen, dann Leer- und Kommentarzeilen
        # uebergehen.
        NAME="\${LINE#"\${LINE%%[![:space:]]*}"}"
        case "\${NAME}" in
            ''|'#'*) continue ;;
        esac

        # Kommentar hinter dem Namen abschneiden. Ein # darf Teil eines
        # Schemanamens sein, deshalb zaehlt es nur mit Leerraum davor.
        NAME="\${NAME%%[[:space:]]#*}"
        NAME="\${NAME%"\${NAME##*[![:space:]]}"}"

        # Der Name landet spaeter in SQL. Was nicht passt, wird nie benutzt.
        if ! [[ "\${NAME}" =~ \${PATTERN} ]]; then
            SCHEMA_FILE_ISSUES+=("Zeile \${NUMBER}: '\${NAME}' ist kein gueltiger Schemaname")
            continue
        fi

        DUPLICATE="no"
        for KNOWN in \${SCHEMAS[@]+"\${SCHEMAS[@]}"}
        do
            [ "\${KNOWN}" = "\${NAME}" ] && DUPLICATE="yes"
        done
        [ "\${DUPLICATE}" = "yes" ] || SCHEMAS+=("\${NAME}")
    done < "\${SCHEMA_FILE}"

    return 0
}`;
}
