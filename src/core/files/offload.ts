import type { ExportConfig, GeneratedFile } from '../types.js';
import {
  EXPORT_CONF_NAME,
  OFFLOAD_SCRIPT_NAME,
  RULE,
  archiveExtension,
  scriptHeader,
  userGuard,
} from './common.js';
import { OFFLOAD_SCRIPT_KEYS, confReader } from './exportConf.js';

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
    `Ziel und Zugang: BOX_* in ${EXPORT_CONF_NAME}`,
    '',
    'Aufruf:',
    '  ./' + OFFLOAD_SCRIPT_NAME + '                 heutigen Tagesordner',
    '  ./' + OFFLOAD_SCRIPT_NAME + ' JJJJ-MM-TT      einen bestimmten Tag',
    '  ./' + OFFLOAD_SCRIPT_NAME + ' --pending       alles Nichtuebertragene',
    '  ./' + OFFLOAD_SCRIPT_NAME + ' --check         nur Verbindung pruefen',
    '  ./' + OFFLOAD_SCRIPT_NAME + ' --setup         einmalige Einrichtung: Schluessel',
    '                                         anlegen, auf der Box ablegen, pruefen',
    '',
    'Kopiert, nicht verschoben: lokal bleibt alles bis zum Ablauf der',
    'oertlichen Aufbewahrung liegen.',
  ])}

set -u

${RULE}
#  Konfiguration
${RULE}

EXPORT_BASE="${config.exportBase}"

# Privater Schluessel dieses Servers. Ein Cronlauf kann kein Passwort
# eintippen, deshalb Schluesselanmeldung.
SSH_KEY="${box.keyPath}"

ARCHIVE_EXT="${ext}"

${confReader(config)}

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

# SSH_OPTS und SFTP_OPTS entstehen erst, wenn die Einstellungen gelesen
# sind: der Port steht in ${EXPORT_CONF_NAME}.

# Alle sftp-Aufrufe laufen hierueber, damit die Optionen nur an einer
# Stelle stehen.
box_sftp()
{
    sftp \${SFTP_OPTS} "\${BOX_USER}@\${BOX_HOST}"
}

# Die Befehlsfolgen stehen als Here-Dokument und nicht als printf mit \\n:
# ein Here-Dokument kennt keine Maskierung, es kann unterwegs nichts
# verlorengehen oder sich in einen echten Zeilenumbruch verwandeln.

box_pwd()
{
    box_sftp <<SFTP_BATCH
pwd
quit
SFTP_BATCH
}

# sftp kennt kein "mkdir -p". Ein Zielpfad mit mehreren Ebenen entsteht
# deshalb Ebene fuer Ebene; bereits vorhandene melden nur einen Fehler,
# den die Gegenpruefung spaeter ohnehin abfaengt.
box_mkdir_path()
{
    (
        IFS='/'
        LEVEL=""
        for PART in $1
        do
            [ -n "\${PART}" ] || continue
            LEVEL="\${LEVEL}/\${PART}"
            echo "mkdir \${LEVEL}"
        done
        echo "quit"
    ) | box_sftp
}

# Wie box_sftp, nur gespraechig. Nur fuer die Fehlersuche.
box_sftp_verbose()
{
    sftp -vvv \${SFTP_OPTS} "\${BOX_USER}@\${BOX_HOST}"
}

box_list()
{
    box_sftp <<SFTP_BATCH 2>/dev/null
ls -1 $1
quit
SFTP_BATCH
}

box_remove_day()
{
    # sftp kennt kein rekursives rm. Die Tagesordner auf der Box enthalten
    # nur Dateien, deshalb genuegen rm und rmdir.
    box_sftp <<SFTP_BATCH
rm $1/*
rmdir $1
quit
SFTP_BATCH
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

read_export_conf ${OFFLOAD_SCRIPT_KEYS.join(' ')}
RC=$?

if [ \${RC} -eq 1 ]; then
    log "FEHLER: Einstellungen fehlen oder sind nicht lesbar: \${EXPORT_CONF}"
    exit 1
fi

for ISSUE in \${CONF_ISSUES[@]+"\${CONF_ISSUES[@]}"}
do
    log "HINWEIS: ${EXPORT_CONF_NAME}, \${ISSUE}."
done

if [ \${RC} -ne 0 ]; then
    for ERROR in "\${CONF_ERRORS[@]}"
    do
        log "FEHLER: ${EXPORT_CONF_NAME}: \${ERROR}"
    done
    exit 1
fi

# Das Aufraeumen loescht Tagesordner unter BOX_PATH. In der Wurzel oder
# direkt in /home kaeme es dem uebrigen Inhalt der Box zu nahe.
case "\${BOX_PATH%/}" in
    ''|/home)
        log "FEHLER: BOX_PATH=\${BOX_PATH} ist zu allgemein, bitte einen eigenen Ordner angeben."
        exit 1
        ;;
esac

SSH_OPTS="-p \${BOX_PORT} -i \${SSH_KEY} \${COMMON_OPTS} -o BatchMode=yes"
SFTP_OPTS="-P \${BOX_PORT} -i \${SSH_KEY} \${COMMON_OPTS} -o BatchMode=yes"

case "\${1:-}" in
    --setup|--setup-key|--install-key) KEY_OPTIONAL=yes ;;
    *)                                 KEY_OPTIONAL=no ;;
esac

if [ ! -r "\${SSH_KEY}" ] && [ "\${KEY_OPTIONAL}" = "no" ]; then
    log "FEHLER: SSH-Schluessel nicht lesbar: \${SSH_KEY}"
    log
    log "Einmalig einrichten mit:"
    log "  $0 --setup"
    exit 1
fi

# Ein zu weit offener Schluessel wird von ssh abgelehnt.
KEY_MODE="$(stat -c '%a' "\${SSH_KEY}" 2>/dev/null)"
if [ -n "\${KEY_MODE}" ] && [ "\${KEY_MODE}" != "600" ] && [ "\${KEY_MODE}" != "400" ]; then
    log "WARNUNG: \${SSH_KEY} hat Rechte \${KEY_MODE}. ssh verlangt 600."
    log "Abhilfe: chmod 600 \${SSH_KEY}"
fi

${RULE}
#  Einrichtung: Schluessel anlegen, ablegen, pruefen
#
#  Je Kunde ein eigenes Paar, erzeugt auf diesem Server. Der private Teil
#  verlaesst ihn nie. Derselbe Schluessel auf mehreren Kundensystemen waere
#  ein geteiltes Geheimnis: ein kompromittiertes System oeffnete dann die
#  Backups aller anderen auf derselben Box.
#
#  Ohne Passphrase, weil ein Cronlauf keine eingeben kann. Der Schutz ist
#  die Dateiberechtigung 600 und der Besitz durch ${config.osUser}.
${RULE}

# Fuer das Ablegen wird das Passwort gebraucht, also ohne BatchMode.
box_sftp_password()
{
    sftp -P "\${BOX_PORT}" -o StrictHostKeyChecking=accept-new \\
        "\${BOX_USER}@\${BOX_HOST}"
}

ensure_key()
{
    if [ -f "\${SSH_KEY}" ]; then
        log "Schluessel vorhanden: \${SSH_KEY}"
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

    log "Fingerabdruck:"
    ssh-keygen -lf "\${SSH_KEY}.pub" 2>&1 | while read -r LINE
    do
        log "  \${LINE}"
    done

    return 0
}

#  Legt den oeffentlichen Schluessel auf der Box ab.
#
#  Vorhandene Schluessel werden zuerst geholt und der eigene angehaengt.
#  Ein blosses Ueberschreiben wuerde bei einer Box, die mehrere Kunden
#  bedient, den Zugang aller anderen loeschen. Das kostet eine zweite
#  Passwortabfrage, weil eine Storage Box keine Shell hat und Holen und
#  Schreiben deshalb nicht in einer Sitzung gehen.
install_key()
{
    if [ ! -r "\${SSH_KEY}.pub" ]; then
        log "FEHLER: Kein oeffentlicher Schluessel: \${SSH_KEY}.pub"
        return 1
    fi

    REMOTE_AK="\${LOG_DIR}/.authorized_keys.remote.$$"
    MERGED="\${LOG_DIR}/.authorized_keys.neu.$$"
    KEY_BODY="$(awk '{print $2}' "\${SSH_KEY}.pub")"

    rm -f "\${REMOTE_AK}" "\${MERGED}"

    log ""
    log "Hole vorhandene Schluessel von der Box. Das Passwort wird gebraucht."

    box_sftp_password <<SFTP_BATCH >> "\${LOG_FILE}" 2>&1
get .ssh/authorized_keys \${REMOTE_AK}
quit
SFTP_BATCH

    if [ -s "\${REMOTE_AK}" ]; then

        if grep -qF "\${KEY_BODY}" "\${REMOTE_AK}"; then
            log "Der Schluessel liegt bereits auf der Box, es bleibt alles wie es ist."
            rm -f "\${REMOTE_AK}"
            return 0
        fi

        log "Auf der Box liegen $(grep -c . "\${REMOTE_AK}") Schluessel. Unserer kommt dazu."

        # Die Ersetzung stellt sicher, dass die letzte Zeile abgeschlossen
        # ist – sonst klebte unser Schluessel an der vorigen.
        printf '%s\\n' "$(cat "\${REMOTE_AK}")" > "\${MERGED}"
        cat "\${SSH_KEY}.pub" >> "\${MERGED}"
    else
        log "Auf der Box liegt noch kein Schluessel."
        cat "\${SSH_KEY}.pub" > "\${MERGED}"
    fi

    log ""
    log "Lege den Schluessel ab. Das Passwort wird ein zweites Mal gebraucht."

    box_sftp_password <<SFTP_BATCH >> "\${LOG_FILE}" 2>&1
mkdir .ssh
chmod 700 .ssh
put \${MERGED} .ssh/authorized_keys
chmod 600 .ssh/authorized_keys
quit
SFTP_BATCH

    rm -f "\${REMOTE_AK}" "\${MERGED}"
    return 0
}

#  Der ganze Weg in einem Aufruf, und zwar wiederholbar: was schon steht,
#  wird nicht noch einmal gemacht.
setup()
{
    ensure_key || return 1

    if box_pwd >> "\${LOG_FILE}" 2>&1; then
        log ""
        log "Die Anmeldung ohne Passwort funktioniert bereits. Nichts zu tun."
        return 0
    fi

    install_key || return 1

    log ""
    log "Pruefe die Anmeldung ohne Passwort ..."

    if box_pwd >> "\${LOG_FILE}" 2>&1; then
        log "Geschafft. Die Auslagerung ist einsatzbereit."
        log ""
        log "Naechster Schritt: ${config.scriptPath}"
        return 0
    fi

    log ""
    log "FEHLER: Die Anmeldung ohne Passwort klappt weiterhin nicht."
    log ""
    log "Nachsehen, was auf der Box liegt:"
    log "  sftp -P \${BOX_PORT} \${BOX_USER}@\${BOX_HOST}"
    log "  sftp> ls -la .ssh"
    return 1
}

${RULE}
#  Verbindung pruefen
${RULE}

check_connection()
{
    log "Pruefe Verbindung zu \${BOX_USER}@\${BOX_HOST}:\${BOX_PORT} ..."

    # Eine Storage Box antwortet auf SSH, bietet aber keine Shell. Deshalb
    # wird mit sftp geprueft und nicht mit einem Kommando.
    box_pwd >> "\${LOG_FILE}" 2>&1
    RC=$?

    if [ \${RC} -eq 0 ]; then
        log "Verbindung steht."
        return 0
    fi

    log "FEHLER: Keine Verbindung zur StorageBox (RC \${RC})."
    log ""

    if [ -r "\${SSH_KEY}.pub" ]; then
        log "Angebotener Schluessel:"
        ssh-keygen -lf "\${SSH_KEY}.pub" 2>&1 | while read -r LINE
        do
            log "  \${LINE}"
        done
    fi

    # Die ausfuehrliche Ausgabe sagt, ob der Schluessel ueberhaupt angeboten
    # und warum er abgelehnt wurde. Nur die aussagekraeftigen Zeilen.
    log ""
    log "Aus dem Verbindungsversuch:"

    box_sftp_verbose </dev/null 2>&1 \\
        | grep -E 'Connecting to|Offering public key|Server accepts key|Authentications that can continue|Permission denied|Connection refused|No route to host|Connection timed out|key_verify failed|not accessible' \\
        | head -12 \\
        | while read -r LINE
          do
              log "  \${LINE}"
          done

    log ""
    log "Zu pruefen:"
    log "  - Ist der Schluessel beim Konto \${BOX_USER} hinterlegt? Ein"
    log "    Schluessel am Hauptkonto gilt nicht fuer ein Unterkonto."
    log "  - Ist fuer dieses Konto der SSH-Zugang freigeschaltet? Bei"
    log "    Unterkonten ist er einzeln zu erlauben."
    log "  - Port \${BOX_PORT} richtig? Hetzner verwendet 23, nicht 22."
    log "  - Passt der Fingerabdruck oben zu dem, was im Robot steht?"
    log ""
    log "  Gegenprobe mit Passwort. Klappt sie, stimmen Host, Benutzer und"
    log "  Port, und es liegt allein am Schluessel:"
    log "      sftp -P \${BOX_PORT} \${BOX_USER}@\${BOX_HOST}"

    return 1
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
    box_mkdir_path "\${BOX_PATH}/\${DAY}" >> "\${LOG_FILE}" 2>&1

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
    REMOTE_COUNT="$(box_list "\${BOX_PATH}/\${DAY}" | grep -c "\\.\${ARCHIVE_EXT}\$")"

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

    REMOTE_DAYS="$(box_list "\${BOX_PATH}" \\
        | tr -d '\\r' | sed 's#.*/##' \\
        | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\$')"

    for DAY in \${REMOTE_DAYS}
    do
        # [[ ]] statt [ ]: dort ist < ein Textvergleich, in [ ] eine Umleitung.
        [[ "\${DAY}" < "\${CUTOFF}" ]] || continue

        log "  entferne \${DAY}"

        box_remove_day "\${BOX_PATH}/\${DAY}" >> "\${LOG_FILE}" 2>&1 || \\
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

# Ein Aufruf fuer die ganze Einrichtung. Die alten Namen bleiben gueltig,
# damit aeltere Anleitungen nicht ins Leere zeigen.
case "\${MODE}" in
    --setup|--setup-key|--install-key)
        setup || exit 1
        exit 0
        ;;
esac

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
        log "Erwartet: JJJJ-MM-TT, --pending, --check, --setup oder gar nichts."
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
