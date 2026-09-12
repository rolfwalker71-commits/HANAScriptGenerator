import type { ExportConfig, GeneratedFile } from '../types.js';
import { OFFLOAD_SCRIPT_NAME, RULE, archiveExtension, scriptHeader, userGuard } from './common.js';

/**
 * Kopiert die Tagesarchive per rsync über SSH auf eine Hetzner StorageBox.
 *
 * Kopiert, nicht verschoben: lokal bleibt der Bestand bis zum Ablauf der
 * örtlichen Aufbewahrung. Eine unbemerkt fehlgeschlagene Übertragung kostet
 * dadurch nicht den Tag.
 *
 * Übertragen werden nur die Archive, nicht die Rohexporte. Dadurch liegen auf
 * der Box ausschließlich Dateien in einer Ebene, was das Aufräumen dort über
 * sftp möglich macht – eine Storage Box hat keine vollwertige Shell.
 */
export function generateOffloadScript(config: ExportConfig): GeneratedFile {
  const box = config.offload;
  const ext = archiveExtension(config.compression);

  const content = `${scriptHeader(config, 'Tagesarchive auf die StorageBox auslagern', [
    `Ziel: ${box.user || '<benutzer>'}@${box.host || '<box>'}:${box.remotePath || '<pfad>'}`,
    '',
    'Aufruf:',
    '  ./' + OFFLOAD_SCRIPT_NAME + '                 heutigen Tagesordner',
    '  ./' + OFFLOAD_SCRIPT_NAME + ' JJJJ-MM-TT      einen bestimmten Tag',
    '  ./' + OFFLOAD_SCRIPT_NAME + ' --pending       alles Nichtuebertragene',
    '  ./' + OFFLOAD_SCRIPT_NAME + ' --check         nur Verbindung pruefen',
    '  ./' + OFFLOAD_SCRIPT_NAME + ' --setup-key     Schluesselpaar anlegen und zeigen',
    '',
    'Kopiert, nicht verschoben: lokal bleibt alles bis zum Ablauf der',
    'oertlichen Aufbewahrung liegen.',
  ])}

set -u

${RULE}
#  Konfiguration
${RULE}

EXPORT_BASE="${config.exportBase}"

BOX_HOST="${box.host}"
BOX_USER="${box.user}"

# Hetzner betreibt SSH auf einer Storage Box auf Port 23, nicht 22.
BOX_PORT=${box.port}

# Zielverzeichnis auf der Box. Darunter entsteht je Tag ein Ordner.
BOX_PATH="${box.remotePath}"

# Privater Schluessel dieses Servers. Ein Cronlauf kann kein Passwort
# eintippen, deshalb Schluesselanmeldung.
SSH_KEY="${box.keyPath}"

# Aufbewahrung auf der Box in Tagen. 0 = nichts dort loeschen.
REMOTE_RETENTION_DAYS=${box.remoteRetentionDays}

ARCHIVE_EXT="${ext}"

${RULE}
#  Laufzeitwerte
${RULE}

TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
LOG_DIR="\${EXPORT_BASE}/logs"
LOG_FILE="\${LOG_DIR}/offload_\${TIMESTAMP}.log"

# Vermerk je uebertragenem Tag, ausserhalb der Tagesordner. Dadurch findet
# --pending nach einer gescheiterten Nacht nach, was liegengeblieben ist.
MARKER_DIR="\${EXPORT_BASE}/.offloaded"

EXITCODE=0

${RULE}
#  Anmeldeverfahren
#
#  StrictHostKeyChecking=accept-new: der erste Verbindungsaufbau soll nicht
#  auf eine Bestaetigung warten, ein geaenderter Hostschluessel aber weiterhin
#  abgelehnt werden. Ein blosses "no" wuerde auch einen Austausch schlucken.
${RULE}

COMMON_OPTS="-o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"

SSH_OPTS="-p \${BOX_PORT} -i \${SSH_KEY} \${COMMON_OPTS} -o BatchMode=yes"
SFTP_OPTS="-P \${BOX_PORT} -i \${SSH_KEY} \${COMMON_OPTS} -o BatchMode=yes"

# Alle sftp-Aufrufe laufen hierueber, damit die Optionen nur an einer
# Stelle stehen.
box_sftp()
{
    sftp \${SFTP_OPTS} "\${BOX_USER}@\${BOX_HOST}"
}

mkdir -p "\${LOG_DIR}" "\${MARKER_DIR}" 2>/dev/null

if ! : > "\${LOG_FILE}" 2>/dev/null; then
    echo "FEHLER: In \${LOG_DIR} kann nicht geschrieben werden." >&2
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

for TOOL in rsync ssh sftp
do
    if ! command -v "\${TOOL}" >/dev/null 2>&1; then
        log "FEHLER: \${TOOL} wurde nicht gefunden, wird aber gebraucht."
        exit 1
    fi
done

if [ -z "\${BOX_HOST}" ] || [ -z "\${BOX_USER}" ] || [ -z "\${BOX_PATH}" ]; then
    log "FEHLER: Die StorageBox ist nicht vollstaendig konfiguriert."
    exit 1
fi

if [ ! -r "\${SSH_KEY}" ] && [ "\${1:-}" != "--setup-key" ]; then
    log "FEHLER: SSH-Schluessel nicht lesbar: \${SSH_KEY}"
    log
    log "Einmalig anlegen mit:"
    log "  $0 --setup-key"
    exit 1
fi

# Ein zu weit offener Schluessel wird von ssh abgelehnt.
KEY_MODE="$(stat -c '%a' "\${SSH_KEY}" 2>/dev/null)"
if [ -n "\${KEY_MODE}" ] && [ "\${KEY_MODE}" != "600" ] && [ "\${KEY_MODE}" != "400" ]; then
    log "WARNUNG: \${SSH_KEY} hat Rechte \${KEY_MODE}. ssh verlangt 600."
    log "Abhilfe: chmod 600 \${SSH_KEY}"
fi

${RULE}
#  Schluesselpaar anlegen
#
#  Je Kunde ein eigenes Paar, erzeugt auf diesem Server. Der private Teil
#  verlaesst ihn nie. Derselbe Schluessel auf mehreren Kundensystemen waere
#  ein geteiltes Geheimnis: ein kompromittiertes System oeffnete dann die
#  Backups aller anderen auf derselben Box.
#
#  Ohne Passphrase, weil ein Cronlauf keine eingeben kann. Der Schutz ist
#  die Dateiberechtigung 600 und der Besitz durch ${config.osUser}.
${RULE}

setup_key()
{
    if [ -f "\${SSH_KEY}" ]; then
        log "Vorhandener Schluessel wird verwendet: \${SSH_KEY}"
    else
        log "Erzeuge Schluesselpaar: \${SSH_KEY}"

        mkdir -p "$(dirname "\${SSH_KEY}")" || {
            log "FEHLER: Verzeichnis fuer den Schluessel konnte nicht angelegt werden."
            return 1
        }
        chmod 700 "$(dirname "\${SSH_KEY}")" 2>/dev/null

        ssh-keygen -t ed25519 -N "" -f "\${SSH_KEY}" \\
            -C "hana-export ${config.sid} $(hostname)" >> "\${LOG_FILE}" 2>&1 || {
            log "FEHLER: Schluessel konnte nicht erzeugt werden."
            return 1
        }
    fi

    chmod 600 "\${SSH_KEY}" 2>/dev/null
    chmod 644 "\${SSH_KEY}.pub" 2>/dev/null

    echo
    echo "${'='.repeat(60)}"
    echo "Oeffentlicher Schluessel dieses Servers:"
    echo
    cat "\${SSH_KEY}.pub"
    echo
    echo "${'='.repeat(60)}"
    echo
    echo "Diesen Schluessel auf der StorageBox hinterlegen. Zwei Wege:"
    echo
    echo "1. Im Hetzner Robot beim Unterkonto \${BOX_USER} einfuegen."
    echo
    echo "2. Von hier aus, mit dem Passwort der Box:"
    echo "     ssh-copy-id -s -p \${BOX_PORT} -i \${SSH_KEY}.pub \${BOX_USER}@\${BOX_HOST}"
    echo
    echo "   Das -s ist noetig: eine Storage Box hat keine normale Shell,"
    echo "   ssh-copy-id muss den Schluessel ueber SFTP ablegen."
    echo
    echo "Danach pruefen:"
    echo "  $0 --check"
    echo

    return 0
}

${RULE}
#  Verbindung pruefen
${RULE}

check_connection()
{
    log "Pruefe Verbindung zu \${BOX_USER}@\${BOX_HOST}:\${BOX_PORT} ..."

    # Eine Storage Box antwortet auf SSH, bietet aber keine Shell. Deshalb
    # wird mit sftp geprueft und nicht mit einem Kommando.
    printf 'pwd\\nquit\\n' | box_sftp >> "\${LOG_FILE}" 2>&1
    RC=$?

    if [ \${RC} -ne 0 ]; then
        log "FEHLER: Keine Verbindung zur StorageBox (RC \${RC})."
        log "Zu pruefen: Port \${BOX_PORT}, hinterlegter Schluessel, Firewall."
        return 1
    fi

    log "Verbindung steht."
    return 0
}

${RULE}
#  Einen Tagesordner uebertragen
${RULE}

offload_day()
{
    DAY="$1"
    DAY_DIR="\${EXPORT_BASE}/\${DAY}"

    if [ ! -d "\${DAY_DIR}" ]; then
        log "FEHLER: Tagesordner fehlt: \${DAY_DIR}"
        return 1
    fi

    COUNT="$(find "\${DAY_DIR}" -maxdepth 1 -type f -name "*.\${ARCHIVE_EXT}" | wc -l)"

    if [ "\${COUNT}" -eq 0 ]; then
        log "FEHLER: In \${DAY} liegt kein einziges Archiv."
        return 1
    fi

    SIZE="$(du -sh "\${DAY_DIR}" 2>/dev/null | awk '{print $1}')"
    log "\${DAY}: \${COUNT} Archive, \${SIZE:-unbekannt}"

    # Das Zielverzeichnis muss vorhanden sein, rsync legt auf der Box keine
    # tieferen Pfade an.
    printf 'mkdir %s\\nmkdir %s/%s\\nquit\\n' "\${BOX_PATH}" "\${BOX_PATH}" "\${DAY}" \\
        | box_sftp >> "\${LOG_FILE}" 2>&1

    log "\${DAY}: uebertrage ..."

    # Nur Archive, keine Rohexporte: die Box bekommt eine flache Ablage,
    # und genau das macht spaeteres Aufraeumen ueber sftp moeglich.
    rsync -a --partial --human-readable \\
        --include="*.\${ARCHIVE_EXT}" --exclude='*' \\
        -e "ssh \${SSH_OPTS}" \\
        "\${DAY_DIR}/" "\${BOX_USER}@\${BOX_HOST}:\${BOX_PATH}/\${DAY}/" \\
        >> "\${LOG_FILE}" 2>&1
    RC=$?

    if [ \${RC} -ne 0 ]; then
        log "FEHLER: Uebertragung von \${DAY} fehlgeschlagen (RC \${RC})."
        return 1
    fi

    # Gegenzaehlen statt dem Rueckgabewert allein zu vertrauen.
    REMOTE_COUNT="$(printf 'ls -1 %s/%s\\nquit\\n' "\${BOX_PATH}" "\${DAY}" \\
        | box_sftp 2>/dev/null \\
        | grep -c "\\.\${ARCHIVE_EXT}\$")"

    if [ "\${REMOTE_COUNT}" -lt "\${COUNT}" ]; then
        log "FEHLER: Auf der Box liegen \${REMOTE_COUNT} von \${COUNT} Archiven."
        return 1
    fi

    date '+%Y-%m-%d %H:%M:%S' > "\${MARKER_DIR}/\${DAY}"
    log "\${DAY}: \${REMOTE_COUNT} Archive auf der Box, lokal bleibt alles liegen."
    return 0
}

${RULE}
#  Auf der Box aufraeumen
${RULE}

prune_remote()
{
    [ "\${REMOTE_RETENTION_DAYS}" -gt 0 ] || return 0

    CUTOFF="$(date -d "\${REMOTE_RETENTION_DAYS} days ago" +%Y-%m-%d 2>/dev/null)"

    if [ -z "\${CUTOFF}" ]; then
        log "WARNUNG: Stichtag nicht berechenbar, auf der Box wird nichts entfernt."
        return 0
    fi

    log "${RULE.slice(2)}"
    log "Entferne auf der Box Tagesordner aelter als \${CUTOFF} ..."

    REMOTE_DAYS="$(printf 'ls -1 %s\\nquit\\n' "\${BOX_PATH}" \\
        | box_sftp 2>/dev/null \\
        | tr -d '\\r' | sed 's#.*/##' \\
        | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\$')"

    for DAY in \${REMOTE_DAYS}
    do
        # [[ ]] statt [ ]: dort ist < ein Textvergleich, in [ ] eine Umleitung.
        [[ "\${DAY}" < "\${CUTOFF}" ]] || continue

        log "  entferne \${DAY}"

        # sftp kennt kein rekursives rm. Die Tagesordner auf der Box
        # enthalten nur Dateien, deshalb genuegen rm und rmdir.
        printf 'rm %s/%s/*\\nrmdir %s/%s\\nquit\\n' \\
            "\${BOX_PATH}" "\${DAY}" "\${BOX_PATH}" "\${DAY}" \\
            | box_sftp >> "\${LOG_FILE}" 2>&1 || \\
            log "  WARNUNG: \${DAY} liess sich nicht vollstaendig entfernen."
    done

    return 0
}

${RULE}
#  Ablauf
${RULE}

log "${'='.repeat(60)}"
log "Auslagerung auf die StorageBox gestartet"
log "Ziel: \${BOX_USER}@\${BOX_HOST}:\${BOX_PATH}"
log "${'='.repeat(60)}"

MODE="\${1:-$(date +%Y-%m-%d)}"

if [ "\${MODE}" = "--setup-key" ]; then
    setup_key || exit 1
    exit 0
fi

check_connection || exit 1

case "\${MODE}" in

    --check)
        log "Nur Verbindungspruefung, es wird nichts uebertragen."
        exit 0
        ;;

    --pending)
        DAYS="$(for ENTRY in "\${EXPORT_BASE}"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]
                do
                    [ -d "\${ENTRY}" ] || continue
                    DAY="$(basename "\${ENTRY}")"
                    [ -f "\${MARKER_DIR}/\${DAY}" ] || echo "\${DAY}"
                done)"

        if [ -z "\${DAYS}" ]; then
            log "Nichts offen, alle Tagesordner sind uebertragen."
            exit 0
        fi
        ;;

    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
        DAYS="\${MODE}"
        ;;

    *)
        log "FEHLER: Unbekannter Aufruf: \${MODE}"
        log "Erwartet: JJJJ-MM-TT, --pending, --check, --setup-key oder gar nichts."
        exit 1
        ;;
esac

for DAY in \${DAYS}
do
    offload_day "\${DAY}" || EXITCODE=1
done

prune_remote

log "${'='.repeat(60)}"

if [ \${EXITCODE} -eq 0 ]; then
    log "Auslagerung erfolgreich abgeschlossen."
else
    log "Auslagerung mit Fehlern abgeschlossen."
fi

log "Logdatei: \${LOG_FILE}"
log "${'='.repeat(60)}"

exit \${EXITCODE}
`;

  return {
    name: OFFLOAD_SCRIPT_NAME,
    title: '6 · Auslagern',
    purpose: `Kopiert die Tagesarchive per rsync auf ${box.host || 'die StorageBox'}. Läuft nach dem Export und lässt lokal alles liegen.`,
    language: 'bash',
    executable: true,
    content,
  };
}
