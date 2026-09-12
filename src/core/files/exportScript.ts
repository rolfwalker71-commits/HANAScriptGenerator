import type { ExportConfig, GeneratedFile } from '../types.js';
import {
  HEAVY_RULE,
  OFFLOAD_SCRIPT_NAME,
  RULE,
  archiveExtension,
  baseName,
  compressionLabel,
  dirName,
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
  const offloadScript = `${dirName(config.scriptPath)}/${OFFLOAD_SCRIPT_NAME}`;

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

# Auslagerung auf die StorageBox nach dem Lauf
OFFLOAD_ENABLED="${config.offload.enabled ? 'yes' : 'no'}"
OFFLOAD_AFTER_EXPORT="${config.offload.runAfterExport ? 'yes' : 'no'}"
OFFLOAD_SCRIPT="${offloadScript}"

# Jedes Schema wird getrennt exportiert. Weitere Schemas hier ergaenzen.
${schemaArray(config)}

${RULE}
#  SAP-Umgebung laden
#
#  Cron startet ohne Anmeldeprofil; ohne die SAP-Umgebung findet hdbsql seine
#  Bibliotheken unter Umstaenden nicht. Interaktiv ist sie dagegen laengst
#  geladen, deshalb wird nur nachgeladen, wenn kein Terminal vorhanden ist.
#
#  Der Unterschied ist nicht kosmetisch: ein Profil wird mit "." in die
#  laufende Shell gelesen. Steht darin ein "exit", endet dieses Skript
#  sofort und ohne Ausgabe. Beim manuellen Lauf soll das nicht passieren
#  koennen, und die Zeile davor zeigt im Cron-Fall, wo es geklemmt hat.
${RULE}

echo "SAP HANA Schema-Export startet..."

if [ -t 1 ]; then
    echo "Interaktiver Lauf, SAP-Umgebung wird als geladen angenommen."
elif [ -f "\${HOME}/.sapenv.sh" ]; then
    echo "Kein Terminal, lade SAP-Umgebung aus \${HOME}/.sapenv.sh ..."

    # Das Profil wird in einer Subshell gelesen; uebernommen werden nur PATH
    # und LD_LIBRARY_PATH. Ein "exit" im Profil beendet damit nur die
    # Subshell und nicht diesen Lauf.
    SAPENV="$( . "\${HOME}/.sapenv.sh" >/dev/null 2>&1
               printf '%s\\n%s\\n' "\${PATH}" "\${LD_LIBRARY_PATH:-}" )"

    SAPENV_PATH="$(printf '%s' "\${SAPENV}" | sed -n '1p')"
    SAPENV_LIB="$(printf '%s' "\${SAPENV}" | sed -n '2p')"

    if [ -n "\${SAPENV_PATH}" ]; then
        PATH="\${SAPENV_PATH}"
        export PATH
    fi

    if [ -n "\${SAPENV_LIB}" ]; then
        LD_LIBRARY_PATH="\${SAPENV_LIB}"
        export LD_LIBRARY_PATH
    fi

    echo "SAP-Umgebung geladen."
fi

${RULE}
#  Laufzeitwerte
${RULE}

DATE="$(date +%Y-%m-%d)"
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"

# Alles eines Tages liegt beisammen. Dadurch ist ein Lauf eine Einheit:
# genau dieser Ordner wird ausgelagert und genau dieser faellt beim
# Aufraeumen als Ganzes weg.
DAY_DIR="\${EXPORT_BASE}/\${DATE}"

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

mkdir -p "\${LOG_DIR}" 2>/dev/null

if [ ! -d "\${LOG_DIR}" ]; then
    echo "FEHLER: Log-Verzeichnis konnte nicht angelegt werden: \${LOG_DIR}" >&2
    echo "Zuerst 02_prepare_dirs.sh als $(whoami) ausfuehren." >&2
    exit 1
fi

# Das Schreibrecht wird geprueft, bevor irgendetwas protokolliert wird.
# Sonst scheitert jede einzelne Logzeile an tee, und der Lauf laeuft unter
# einem Wust von Fehlermeldungen weiter, statt einmal klar abzubrechen.
if ! : > "\${LOG_FILE}" 2>/dev/null; then
    echo "FEHLER: In das Log-Verzeichnis kann nicht geschrieben werden." >&2
    echo >&2
    ls -ld "\${EXPORT_BASE}" "\${LOG_DIR}" >&2 2>/dev/null
    echo >&2
    echo "Haeufige Ursache: die Verzeichnisse wurden als root angelegt," >&2
    echo "der Export laeuft aber als $(whoami)." >&2
    echo >&2
    echo "Abhilfe als root:" >&2
    echo "  chown -R ${config.osUser}:sapsys \${EXPORT_BASE}" >&2
    echo "  chmod -R u+rwX \${EXPORT_BASE}" >&2
    exit 1
fi

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
    WORK_DIR="\${DAY_DIR}/\${SCHEMA}"
    ARCHIVE="\${DAY_DIR}/\${SCHEMA}_\${DATE}.\${ARCHIVE_EXT}"

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

    tar -C "\${DAY_DIR}" "\${TAR_CREATE[@]}" "\${ARCHIVE}.tmp" "\${SCHEMA}" >> "\${LOG_FILE}" 2>&1
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
#  Auslagern auf die StorageBox
#
#  Ausgelagert wird auch dann, wenn einzelne Schemas gescheitert sind: acht
#  von neun Archiven extern zu haben ist besser als keines. Was fehlt, steht
#  im Log und im Ordner selbst.
${RULE}

if [ "\${OFFLOAD_ENABLED}" = "yes" ] && [ "\${OFFLOAD_AFTER_EXPORT}" = "yes" ]; then

    log "${RULE.slice(2)}"

    if [ ! -x "\${OFFLOAD_SCRIPT}" ]; then
        log "FEHLER: Auslagerungsskript fehlt oder ist nicht ausfuehrbar:"
        log "  \${OFFLOAD_SCRIPT}"
        EXITCODE=1
    else
        log "Lagere \${DATE} auf die StorageBox aus..."

        "\${OFFLOAD_SCRIPT}" "\${DATE}" >> "\${LOG_FILE}" 2>&1
        RC=$?

        if [ \${RC} -eq 0 ]; then
            log "Auslagerung abgeschlossen."
        else
            log "FEHLER: Auslagerung fehlgeschlagen (RC \${RC}). Einzelheiten im Log oben."
            EXITCODE=1
        fi
    fi
fi

${RULE}
#  Aufbewahrung
#
#  Verglichen wird der Ordnername, nicht die Aenderungszeit. Ein Zugriff
#  auf einen Ordner – etwa beim Auslagern oder bei einem zweiten Lauf –
#  wuerde dessen Zeitstempel verschieben und die Frist stillschweigend
#  verlaengern. Der Name aendert sich nie.
${RULE}

CUTOFF="$(date -d "\${RETENTION_DAYS} days ago" +%Y-%m-%d 2>/dev/null)"

log "${RULE.slice(2)}"

if [ -z "\${CUTOFF}" ]; then
    log "WARNUNG: Stichtag konnte nicht berechnet werden, es wird nichts entfernt."
else
    log "Entferne Tagesordner aelter als \${CUTOFF} (\${RETENTION_DAYS} Tage)..."

    for ENTRY in "\${EXPORT_BASE}"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]
    do
        [ -d "\${ENTRY}" ] || continue

        ENTRY_DATE="$(basename "\${ENTRY}")"

        # Zeichenweiser Vergleich genuegt, weil JJJJ-MM-TT sortierbar ist.
        # [[ ]] statt [ ]: dort ist < ein Textvergleich, in [ ] eine Umleitung.
        if [[ "\${ENTRY_DATE}" < "\${CUTOFF}" ]]; then
            log "  entferne \${ENTRY_DATE}"
            rm -rf "\${ENTRY}"
        fi
    done

    find "\${LOG_DIR}" \\
        -type f -name 'schema_export_*.log' \\
        -mtime +$((RETENTION_DAYS - 1)) \\
        -delete >> "\${LOG_FILE}" 2>&1
fi

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
