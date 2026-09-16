import type { ExportConfig } from '../types.js';
import { EXPORT_CONF_NAME, RULE } from './common.js';

/** Welcher der beiden Checks gemeint ist. */
export type NotifyJob = 'export' | 'offload';

/** Der Schlüssel in `export.conf`, der die Ping-Adresse dieses Jobs trägt. */
function pingKey(job: NotifyJob): string {
  return job === 'export' ? 'NOTIFY_PING_URL' : 'NOTIFY_PING_URL_OFFLOAD';
}

/**
 * Tabellenzeilen und Zeitformat. Reine Textbastelei ohne Netz – sie entsteht
 * auch dann, wenn niemand sie abholt, weil das die Aufrufstellen in den
 * Skripten frei von Fallunterscheidungen hält.
 */
function helpers(): string {
  return `# Zeilen, die als Inhalt der Abschlussmeldung mitgehen.
NTF_BODY=()
# Je Schema eine Zeile für die Übersicht in der Meldung.
NTF_ROWS=()

notify_add()
{
    NTF_BODY+=("$*")
}

# Sekunden als m:ss oder h:mm:ss.
notify_duration()
{
    local S="\${1:-0}"

    if [ "\${S}" -ge 3600 ]; then
        printf '%d:%02d:%02d' $((S / 3600)) $(((S % 3600) / 60)) $((S % 60))
    else
        printf '%d:%02d' $((S / 60)) $((S % 60))
    fi
}

# notify_row SCHEMA ZUSTAND GROESSE SEKUNDEN
#
# Feste Spaltenbreiten, damit die Tabelle in der Weboberfläche des Dienstes
# untereinander steht. Schemanamen duerfen bis 127 Zeichen lang sein; die
# Spalte laeuft dann ueber, statt den Namen abzuschneiden – der Name ist die
# Information, die Ausrichtung nur Bequemlichkeit.
notify_row()
{
    NTF_ROWS+=("$(printf '%-22s %-14s %8s %9s' "\${1}" "\${2}" "\${3:--}" "$(notify_duration "\${4:-0}")")")
}`;
}

/**
 * Bash-Block für die Überwachung durch einen Ping-Dienst im
 * healthchecks.io-Stil. Braucht `log()` und `LOG_DIR`, gehört also hinter
 * den Logging-Block des jeweiligen Skripts.
 *
 * Ist die Überwachung nicht eingeschaltet, entstehen leere Funktionen statt
 * gar keiner. Die Aufrufstellen bleiben dadurch unverändert, und – wichtiger –
 * das Skript verlangt dann keine NOTIFY-Schlüssel aus ${EXPORT_CONF_NAME},
 * die dort gar nicht stehen.
 */
export function notifyBlock(config: ExportConfig, job: NotifyJob): string {
  const head = `${RULE}
#  Ueberwachung
${RULE}
`;

  if (!config.notify.enabled) {
    return `${head}
# Fuer diesen Kunden nicht eingeschaltet.
notify_begin()  { return 0; }
notify_finish() { return 0; }

${helpers()}`;
  }

  return `${head}#
#  Gemeldet wird an einen Ping-Dienst im healthchecks.io-Stil: zu Beginn an
#  <Adresse>/start, am Ende an <Adresse>/<Exitcode>. Der Dienst wertet 0 als
#  Erfolg und jeden anderen Wert als Fehlschlag.
#
#  Der Umweg ueber einen fremden Dienst hat einen Grund, der sich hier nicht
#  nachbauen laesst: bleibt ein Lauf ganz aus, kann dieser Server das nicht
#  melden. Dort faellt genau das auf, weil der erwartete Ping fehlt.
#
#  Die Crontab bleibt unberuehrt - gemeldet wird aus dem Skript heraus.
${RULE}

# Wird von notify_begin aus den Einstellungen gesetzt.
NTF_PING_URL=""

${helpers()}

# notify_ping EREIGNIS   (start oder ein Exitcode)
#
# Endet immer mit 0. Eine gescheiterte Meldung darf einen erfolgreichen
# Export nicht nachtraeglich zum Fehlschlag machen.
notify_ping()
{
    local EVENT="\${1}"
    local RC LINE
    local BODY_FILE=""
    local ERR_FILE="\${LOG_DIR}/.ping_err.$$"
    local -a OPTS=(
        --silent --show-error
        --output /dev/null
        --connect-timeout 10
        --max-time 20
        --retry 2 --retry-delay 5
    )

    [ -n "\${NTF_PING_URL}" ] || return 0

    if ! command -v curl >/dev/null 2>&1; then
        log "WARNUNG: curl fehlt, es geht keine Meldung an die Ueberwachung."
        return 0
    fi

    if [ -n "\${NOTIFY_PROXY}" ]; then
        OPTS+=(--proxy "\${NOTIFY_PROXY}")
    fi

    # Der Inhalt geht nur an die Abschlussmeldung. Beim Start gibt es noch
    # nichts zu berichten, und ein Inhalt wuerde dort nur die spaetere
    # Meldung in der Ansicht verdecken.
    if [ "\${EVENT}" != "start" ] && [ \${#NTF_BODY[@]} -gt 0 ]; then
        BODY_FILE="\${LOG_DIR}/.ping_body.$$"

        if : > "\${BODY_FILE}" 2>/dev/null; then
            for LINE in \${NTF_BODY[@]+"\${NTF_BODY[@]}"}
            do
                printf '%s\\n' "\${LINE}" >> "\${BODY_FILE}"
            done
            OPTS+=(--data-binary "@\${BODY_FILE}")
        else
            BODY_FILE=""
        fi
    fi

    # Die Adresse wird ueber die Konfiguration von curl gereicht statt als
    # Argument: als Argument stuende sie in der Prozessliste, und wer sie
    # mitliest, koennte dem Dienst falschen Erfolg melden und damit ein
    # ausgefallenes Backup gesund aussehen lassen.
    printf 'url = "%s"\\n' "\${NTF_PING_URL%/}/\${EVENT}" \\
        | curl --config - "\${OPTS[@]}" 2> "\${ERR_FILE}"
    RC=$?

    if [ \${RC} -ne 0 ]; then
        log "WARNUNG: Meldung '\${EVENT}' an die Ueberwachung fehlgeschlagen (curl \${RC})."
        log "Der Lauf selbst ist davon unberuehrt."

        # curl nennt in seinen Fehlertexten die vollstaendige Adresse.
        while IFS= read -r LINE
        do
            [ -n "\${LINE}" ] && log "  \${LINE}"
        done < <(sed 's#https://[^[:space:]]*#<Adresse entfernt>#g' "\${ERR_FILE}" 2>/dev/null)
    fi

    rm -f "\${ERR_FILE}" \${BODY_FILE:+"\${BODY_FILE}"}
    return 0
}

# Nach dem Lesen der Einstellungen aufrufen.
notify_begin()
{
    [ "\${NOTIFY_ENABLED}" = "yes" ] || return 0

    if ! [[ "\${${pingKey(job)}}" =~ ^https://[^[:space:]]+$ ]]; then
        log "HINWEIS: ${pingKey(job)} fehlt oder ist keine https-Adresse. Es wird nichts gemeldet."
        CONF_ISSUES+=("${pingKey(job)} unbrauchbar")
        return 0
    fi

    NTF_PING_URL="\${${pingKey(job)}}"

    # Der Trap steht hier und nicht an jeder Aufrufstelle: von hier bis zum
    # Ende steigen die Skripte an rund einem Dutzend Stellen aus, und eine
    # davon zu vergessen hiesse, dass der Dienst den Lauf als haengend statt
    # als gescheitert fuehrt.
    trap 'notify_finish $?' EXIT

    notify_ping start
}

# notify_finish EXITCODE
notify_finish()
{
    notify_ping "\${1}"
}`;
}

/**
 * Prüfungen für `03_preflight.sh`. Sie schicken nichts: das Skript verspricht
 * in seinem Kopf, nichts zu verändern, und eine Meldung an den Dienst wäre
 * eine sichtbare Nebenwirkung – sie träte dort als echter Lauf auf.
 */
export function notifyPreflight(config: ExportConfig): string {
  if (!config.notify.enabled) return '';

  const urls = [
    { key: 'NOTIFY_PING_URL', label: 'Export' },
    { key: 'NOTIFY_PING_URL_OFFLOAD', label: 'Auslagerung' },
  ];

  return `
${RULE}
#  Ueberwachung
${RULE}

if [ "\${NOTIFY_ENABLED}" = "yes" ]; then
    if command -v curl >/dev/null 2>&1; then
        ok "curl ist vorhanden."
    else
        fail "curl fehlt. Ohne curl kann nichts gemeldet werden."
    fi

${urls
  .map(
    ({ key, label }) => `    if [ -z "\${${key}}" ]; then
        note "${label}: keine Ping-Adresse hinterlegt, dieser Lauf wird nicht ueberwacht."
    elif [[ "\${${key}}" =~ ^https://[^[:space:]]+$ ]]; then
        ok "${label}: Ping-Adresse ist hinterlegt."
    else
        fail "${label}: ${key} ist keine https-Adresse."
    fi`,
  )
  .join('\n\n')}

    if [ -n "\${NOTIFY_PING_URL}" ] && [ "\${NOTIFY_PING_URL}" = "\${NOTIFY_PING_URL_OFFLOAD}" ]; then
        fail "Beide Laeufe zeigen auf denselben Check. Der spaetere ueberschreibt den frueheren."
    fi

    # Nur die Namensaufloesung, kein Versand: ein Ping von hier stuende beim
    # Dienst als echter Lauf in der Historie.
    NTF_HOST="\${NOTIFY_PING_URL#https://}"
    NTF_HOST="\${NTF_HOST%%/*}"

    if [ -z "\${NTF_HOST}" ]; then
        :
    elif getent hosts "\${NTF_HOST}" >/dev/null 2>&1; then
        ok "\${NTF_HOST} laesst sich aufloesen."
    else
        fail "\${NTF_HOST} laesst sich nicht aufloesen. DNS oder Proxy pruefen."
    fi

    # In der Ping-Adresse steckt die Kennung des Checks. Wer sie liest, kann
    # dem Dienst falschen Erfolg melden - 640 hiesse: jedes Mitglied von
    # sapsys kann das.
    CONF_MODE="$(stat -c '%a' "\${EXPORT_CONF}" 2>/dev/null)"

    if [ -n "\${CONF_MODE}" ] && [ "\${CONF_MODE}" != "600" ]; then
        fail "${EXPORT_CONF_NAME} hat die Rechte \${CONF_MODE}, darin steht eine Ping-Adresse."
        note "Abhilfe:  chmod 600 \${EXPORT_CONF}"
    fi
fi
`;
}
