import type { ExportConfig, GeneratedFile } from '../types.js';
import {
  HEAVY_RULE,
  RULE,
  archiveExtension,
  baseName,
  compressionLabel,
  schemaArray,
  scriptHeader,
  userGuard,
} from './common.js';

/**
 * Das Hauptskript: exportiert jedes Schema einzeln, archiviert jeden Export
 * einzeln als tar und räumt alte Archive und Logs nach Aufbewahrungsfrist auf.
 */
export function generateExportScript(config: ExportConfig): GeneratedFile {
  const name = baseName(config.scriptPath);
  const ext = archiveExtension(config.compression);

  const content = `${scriptHeader(config, 'SAP HANA Schema-Export', [
    'Jedes Schema wird einzeln exportiert und einzeln archiviert.',
    `Archivformat: ${compressionLabel(config.compression)} (*.${ext})`,
    `Aufbewahrung: ${config.retentionDays} Tage`,
    `Aufruf: ${config.scriptPath}`,
  ])}

set -u

${RULE}
#  Konfiguration
${RULE}

RUN_AS_USER="${config.osUser}"
HANA_KEY="${config.userstoreKey}"
HDBSQL="${config.hdbsqlPath}"
EXPORT_BASE="${config.exportBase}"

THREADS=${config.threads}
RETENTION_DAYS=${config.retentionDays}

# gz | zst | none
COMPRESSION="${config.compression}"

# yes = unkomprimiertes Exportverzeichnis zusaetzlich behalten
KEEP_RAW_EXPORT="${config.keepRawExport ? 'yes' : 'no'}"

# Mindestens freier Speicher in GB vor dem Export, 0 = Pruefung aus
MIN_FREE_GB=${config.minFreeGb}

MAIL_ENABLED="${config.mail.enabled ? 'yes' : 'no'}"
MAIL_RECIPIENT="${config.mail.recipient}"
MAIL_ONLY_ON_ERROR="${config.mail.onlyOnError ? 'yes' : 'no'}"
MAIL_COMMAND="${config.mail.command}"

# Jedes Schema wird getrennt exportiert. Weitere Schemas hier ergaenzen.
${schemaArray(config)}

${RULE}
#  SAP-Umgebung laden
#
#  Cron startet ohne Anmeldeprofil. Ohne die SAP-Umgebung findet hdbsql seine
#  Bibliotheken unter Umstaenden nicht. Interaktiv ist das Laden wirkungslos.
${RULE}

if [ -f "\${HOME}/.sapenv.sh" ]; then
    . "\${HOME}/.sapenv.sh" >/dev/null 2>&1 || true
fi

${RULE}
#  Laufzeitwerte
${RULE}

DATE="$(date +%Y-%m-%d)"
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"

LOG_DIR="\${EXPORT_BASE}/logs"
LOG_FILE="\${LOG_DIR}/schema_export_\${TIMESTAMP}.log"
LOCK_FILE="\${EXPORT_BASE}/.schema_export.lock"

EXITCODE=0
OK_SCHEMAS=()
FAILED_SCHEMAS=()

case "\${COMPRESSION}" in
    gz)
        TAR_CREATE=(-czf)
        TAR_TEST=(-tzf)
        ARCHIVE_EXT="tar.gz"
        ;;
    zst)
        TAR_CREATE=(--zstd -cf)
        TAR_TEST=(--zstd -tf)
        ARCHIVE_EXT="tar.zst"
        ;;
    none)
        TAR_CREATE=(-cf)
        TAR_TEST=(-tf)
        ARCHIVE_EXT="tar"
        ;;
    *)
        echo "FEHLER: Unbekannter Wert fuer COMPRESSION: \${COMPRESSION}" >&2
        exit 1
        ;;
esac

${RULE}
#  Logging
${RULE}

mkdir -p "\${LOG_DIR}" || {
    echo "FEHLER: Log-Verzeichnis konnte nicht angelegt werden: \${LOG_DIR}" >&2
    exit 1
}

log()
{
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $*" | tee -a "\${LOG_FILE}"
}

${RULE}
#  Vorabpruefungen
${RULE}

${userGuard(config)}

log "${HEAVY_RULE.slice(2)}"
log "SAP HANA Schema-Export gestartet"
log "Host: $(hostname)"
log "Linux-Benutzer: $(whoami)"
log "Datum: \${DATE}"
log "Schemas: \${SCHEMAS[*]}"
log "${HEAVY_RULE.slice(2)}"

if [ ! -x "\${HDBSQL}" ]; then
    log "FEHLER: hdbsql nicht gefunden oder nicht ausfuehrbar: \${HDBSQL}"
    log "Hinweis: 'which hdbsql' ausfuehren und HDBSQL im Skript anpassen."
    exit 1
fi

if [ ! -d "\${EXPORT_BASE}" ]; then
    log "FEHLER: Exportverzeichnis existiert nicht: \${EXPORT_BASE}"
    exit 1
fi

if [ ! -w "\${EXPORT_BASE}" ]; then
    log "FEHLER: Exportverzeichnis ist nicht beschreibbar: \${EXPORT_BASE}"
    exit 1
fi

# Parallel laufende Exporte verhindern. Ein Lauf, der laenger als das
# Cron-Intervall dauert, wuerde sonst mit sich selbst um die Dateien streiten.
exec 9>"\${LOCK_FILE}" || {
    log "FEHLER: Lockdatei konnte nicht geoeffnet werden: \${LOCK_FILE}"
    exit 1
}

if ! flock -n 9; then
    log "ABBRUCH: Ein Export laeuft bereits (Lock: \${LOCK_FILE})."
    exit 1
fi

if [ "\${MIN_FREE_GB}" -gt 0 ]; then
    FREE_GB="$(df -BG --output=avail "\${EXPORT_BASE}" 2>/dev/null | tail -1 | tr -dc '0-9')"
    if [ -z "\${FREE_GB}" ]; then
        log "WARNUNG: Freier Speicherplatz konnte nicht ermittelt werden."
    elif [ "\${FREE_GB}" -lt "\${MIN_FREE_GB}" ]; then
        log "FEHLER: Nur \${FREE_GB} GB frei, benoetigt werden \${MIN_FREE_GB} GB."
        exit 1
    else
        log "Freier Speicherplatz: \${FREE_GB} GB."
    fi
fi

log "Teste Verbindung zur HANA-Datenbank..."

"\${HDBSQL}" -U "\${HANA_KEY}" "SELECT CURRENT_USER FROM DUMMY;" >> "\${LOG_FILE}" 2>&1
RC=$?

if [ \${RC} -ne 0 ]; then
    log "FEHLER: Verbindung ueber hdbuserstore-Key \${HANA_KEY} fehlgeschlagen (RC \${RC})."
    exit 1
fi

log "HANA-Verbindung erfolgreich."

${RULE}
#  Export und Archivierung eines einzelnen Schemas
${RULE}

export_schema()
{
    SCHEMA="$1"
    SCHEMA_DIR="\${EXPORT_BASE}/\${SCHEMA}"
    WORK_DIR="\${SCHEMA_DIR}/\${DATE}"
    ARCHIVE="\${SCHEMA_DIR}/\${SCHEMA}_\${DATE}.\${ARCHIVE_EXT}"

    log "${RULE.slice(2)}"
    log "Schema \${SCHEMA}: Export nach \${WORK_DIR}"

    if ! mkdir -p "\${WORK_DIR}"; then
        log "FEHLER: Exportverzeichnis konnte nicht angelegt werden: \${WORK_DIR}"
        return 1
    fi

    # WITH REPLACE erlaubt einen erneuten Lauf am selben Tag.
    SQL="EXPORT \\"\${SCHEMA}\\".\\"*\\" AS BINARY INTO '\${WORK_DIR}' WITH REPLACE THREADS \${THREADS};"

    "\${HDBSQL}" -U "\${HANA_KEY}" "\${SQL}" >> "\${LOG_FILE}" 2>&1
    RC=$?

    if [ \${RC} -ne 0 ]; then
        log "FEHLER: Export von \${SCHEMA} fehlgeschlagen (RC \${RC})."
        return 1
    fi

    RAW_SIZE="$(du -sh "\${WORK_DIR}" 2>/dev/null | awk '{print $1}')"
    log "Schema \${SCHEMA}: Export erfolgreich (Rohgroesse \${RAW_SIZE:-unbekannt})."

    # Archivierung: erst in eine .tmp-Datei, dann umbenennen. So liegt nie
    # ein halb geschriebenes Archiv im Aufbewahrungsbestand.

    log "Schema \${SCHEMA}: Archiviere nach \${ARCHIVE}"

    rm -f "\${ARCHIVE}.tmp"

    tar -C "\${SCHEMA_DIR}" "\${TAR_CREATE[@]}" "\${ARCHIVE}.tmp" "\${DATE}" >> "\${LOG_FILE}" 2>&1
    RC=$?

    if [ \${RC} -ne 0 ]; then
        log "FEHLER: Archivierung von \${SCHEMA} fehlgeschlagen (RC \${RC})."
        rm -f "\${ARCHIVE}.tmp"
        return 1
    fi

    tar "\${TAR_TEST[@]}" "\${ARCHIVE}.tmp" >/dev/null 2>> "\${LOG_FILE}"
    RC=$?

    if [ \${RC} -ne 0 ]; then
        log "FEHLER: Archiv von \${SCHEMA} ist nicht lesbar (RC \${RC}). Rohexport bleibt erhalten."
        rm -f "\${ARCHIVE}.tmp"
        return 1
    fi

    mv -f "\${ARCHIVE}.tmp" "\${ARCHIVE}"

    ARCHIVE_SIZE="$(du -sh "\${ARCHIVE}" 2>/dev/null | awk '{print $1}')"
    log "Schema \${SCHEMA}: Archiv erstellt (\${ARCHIVE_SIZE:-unbekannt})."

    if [ "\${KEEP_RAW_EXPORT}" = "yes" ]; then
        log "Schema \${SCHEMA}: Rohexport bleibt unter \${WORK_DIR} erhalten."
    else
        rm -rf "\${WORK_DIR}"
        log "Schema \${SCHEMA}: Rohexport entfernt, es bleibt nur das Archiv."
    fi

    return 0
}

${RULE}
#  Alle Schemas nacheinander abarbeiten
${RULE}

for SCHEMA in "\${SCHEMAS[@]}"
do
    if export_schema "\${SCHEMA}"; then
        OK_SCHEMAS+=("\${SCHEMA}")
    else
        FAILED_SCHEMAS+=("\${SCHEMA}")
        EXITCODE=1
    fi
done

${RULE}
#  Aufbewahrung
#
#  -mtime +N liefert Dateien, die aelter als N+1 Tage sind. Fuer
#  RETENTION_DAYS Tage Aufbewahrung ist deshalb N = RETENTION_DAYS - 1.
${RULE}

PRUNE_MTIME=$((RETENTION_DAYS - 1))

log "${RULE.slice(2)}"
log "Entferne Archive aelter als \${RETENTION_DAYS} Tage..."

for SCHEMA in "\${SCHEMAS[@]}"
do
    SCHEMA_DIR="\${EXPORT_BASE}/\${SCHEMA}"

    [ -d "\${SCHEMA_DIR}" ] || continue

    find "\${SCHEMA_DIR}" \\
        -mindepth 1 -maxdepth 1 \\
        -type f -name "\${SCHEMA}_*.\${ARCHIVE_EXT}" \\
        -mtime +\${PRUNE_MTIME} \\
        -print -delete >> "\${LOG_FILE}" 2>&1

    # Rohexport-Verzeichnisse aus frueheren Laeufen ebenfalls bereinigen.
    find "\${SCHEMA_DIR}" \\
        -mindepth 1 -maxdepth 1 \\
        -type d \\
        -mtime +\${PRUNE_MTIME} \\
        -print -exec rm -rf {} + >> "\${LOG_FILE}" 2>&1
done

find "\${LOG_DIR}" \\
    -type f -name 'schema_export_*.log' \\
    -mtime +\${PRUNE_MTIME} \\
    -delete >> "\${LOG_FILE}" 2>&1

${RULE}
#  Abschluss
${RULE}

log "${HEAVY_RULE.slice(2)}"

if [ \${#OK_SCHEMAS[@]} -gt 0 ]; then
    log "Erfolgreich: \${OK_SCHEMAS[*]}"
fi

if [ \${#FAILED_SCHEMAS[@]} -gt 0 ]; then
    log "Fehlgeschlagen: \${FAILED_SCHEMAS[*]}"
    log "Schema-Export mit Fehlern abgeschlossen."
else
    log "Alle Schema-Exporte erfolgreich abgeschlossen."
fi

log "Logdatei: \${LOG_FILE}"
log "${HEAVY_RULE.slice(2)}"

if [ "\${MAIL_ENABLED}" = "yes" ]; then
    if [ "\${MAIL_ONLY_ON_ERROR}" = "no" ] || [ \${EXITCODE} -ne 0 ]; then
        if [ \${EXITCODE} -eq 0 ]; then
            SUBJECT="[HANA ${config.sid}] Schema-Export erfolgreich auf $(hostname)"
        else
            SUBJECT="[HANA ${config.sid}] Schema-Export FEHLGESCHLAGEN auf $(hostname)"
        fi
        "\${MAIL_COMMAND}" -s "\${SUBJECT}" "\${MAIL_RECIPIENT}" < "\${LOG_FILE}"
    fi
fi

exit \${EXITCODE}
`;

  return {
    name,
    title: 'Hauptskript',
    purpose: `Der eigentliche Export. Wird nach ${config.scriptPath} kopiert und von Cron aufgerufen.`,
    language: 'bash',
    executable: true,
    content,
  };
}
