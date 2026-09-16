import type { ExportConfig, GeneratedFile } from '../types.js';
import { shCommentSafe } from '../sh.js';
import {
  EXPORT_CONF_NAME,
  GENERATOR_NAME,
  GENERATOR_VERSION,
  HEAVY_RULE,
  RULE,
  dirName,
} from './common.js';

/** Wie ein Wert beim Einlesen geprüft wird. */
type ConfKind = 'count' | 'number' | 'port' | 'yesno' | 'word' | 'path' | 'text';

interface ConfEntry {
  key: string;
  kind: ConfKind;
  value: string;
  /** Erklärung für die Anleitung und den Kommentar in der Datei. */
  description: string;
}

interface ConfSection {
  title: string;
  entries: ConfEntry[];
}

/** Die Schlüssel, die das Exportskript immer braucht. */
const BASE_EXPORT_KEYS = [
  'THREADS',
  'RETENTION_DAYS',
  'MIN_FREE_GB',
  'KEEP_RAW_EXPORT',
  'MAIL_ENABLED',
  'MAIL_RECIPIENT',
  'MAIL_ONLY_ON_ERROR',
  'MAIL_COMMAND',
] as const;

/** Die Schlüssel, die das Auslagerungsskript immer braucht. */
const BASE_OFFLOAD_KEYS = [
  'BOX_HOST',
  'BOX_USER',
  'BOX_PORT',
  'BOX_PATH',
  'REMOTE_RETENTION_DAYS',
] as const;

/** Die Schlüssel der Überwachung, die beide Skripte brauchen. */
const NOTIFY_KEYS = [
  'NOTIFY_ENABLED',
  'NOTIFY_PING_URL',
  'NOTIFY_PING_URL_OFFLOAD',
  'NOTIFY_MAX_LINES',
  'NOTIFY_PROXY',
] as const;

/**
 * Was ein Skript verlangt, hängt von der Konfiguration ab – und das ist keine
 * Feinheit, sondern verhindert einen Ausfall: `read_export_conf` endet mit 2,
 * sobald ein verlangter Schlüssel fehlt, und die Skripte brechen daraufhin ab.
 * Eine vorhandene `export.conf` wird beim erneuten Übertragen aber bewusst
 * nicht überschrieben (siehe `deploy.ts`). Würde ein neues Skript einen
 * Schlüssel verlangen, den die Datei auf dem Server nicht kennt, stünde der
 * nächste Cronlauf still und das Backup fiele aus.
 */
export function exportScriptKeys(config: ExportConfig): string[] {
  return [...BASE_EXPORT_KEYS, ...(config.notify.enabled ? NOTIFY_KEYS : [])];
}

export function offloadScriptKeys(config: ExportConfig): string[] {
  return [...BASE_OFFLOAD_KEYS, ...(config.notify.enabled ? NOTIFY_KEYS : [])];
}

const yesNo = (flag: boolean): string => (flag ? 'yes' : 'no');

/**
 * Alle Betriebswerte, gruppiert wie in der Datei. Einzige Quelle für die
 * Datei selbst, für die Prüfung beim Einlesen und für die Anleitung.
 *
 * Die StorageBox erscheint nur bei eingeschalteter Auslagerung, denn nur
 * dann gibt es ein Skript, das sie liest.
 */
export function confSections(config: ExportConfig): ConfSection[] {
  const box = config.offload;

  const sections: ConfSection[] = [
    {
      title: 'Export',
      entries: [
        {
          key: 'THREADS',
          kind: 'count',
          value: String(config.threads),
          description: 'Parallele Threads für EXPORT und IMPORT.',
        },
        {
          key: 'RETENTION_DAYS',
          kind: 'count',
          value: String(config.retentionDays),
          description: 'Lokale Aufbewahrung in Tagen. Ältere Tagesordner und Logs entfernt jeder Lauf.',
        },
        {
          key: 'MIN_FREE_GB',
          kind: 'number',
          value: String(config.minFreeGb),
          description: 'Mindestens freier Speicher in GB vor dem Export, 0 = keine Prüfung.',
        },
        {
          key: 'KEEP_RAW_EXPORT',
          kind: 'yesno',
          value: yesNo(config.keepRawExport),
          description: 'yes = unkomprimiertes Exportverzeichnis zusätzlich behalten.',
        },
      ],
    },
    {
      title: 'Mail',
      entries: [
        {
          key: 'MAIL_ENABLED',
          kind: 'yesno',
          value: yesNo(config.mail.enabled),
          description: 'yes = nach dem Lauf eine Mail schicken.',
        },
        {
          key: 'MAIL_RECIPIENT',
          kind: 'text',
          value: config.mail.recipient,
          description: 'Empfängeradresse.',
        },
        {
          key: 'MAIL_ONLY_ON_ERROR',
          kind: 'yesno',
          value: yesNo(config.mail.onlyOnError),
          description: 'yes = nur bei Fehlern oder Hinweisen mailen, no = nach jedem Lauf.',
        },
        {
          // Darf leer sein, solange keine Mail verschickt wird.
          key: 'MAIL_COMMAND',
          kind: 'text',
          value: config.mail.command,
          description: 'Mailprogramm, aufgerufen als: PROGRAMM -s BETREFF ADRESSE.',
        },
      ],
    },
  ];

  // Nur bei eingeschalteter Ueberwachung, wie bei der StorageBox: die
  // Skripte verlangen dann auch nur dann diese Schluessel.
  if (config.notify.enabled) {
    const notify = config.notify;

    sections.push({
      title: 'Ueberwachung',
      entries: [
        {
          key: 'NOTIFY_ENABLED',
          kind: 'yesno',
          value: yesNo(notify.enabled),
          description: 'yes = Beginn und Ende jedes Laufs an den Ping-Dienst melden.',
        },
        {
          // Wer die Adresse kennt, kann falsche Erfolgsmeldungen schicken.
          // Deshalb gehoert diese Datei auf chmod 600.
          key: 'NOTIFY_PING_URL',
          kind: 'text',
          value: notify.url,
          description: 'Ping-Adresse des Checks fuer den Export, z. B. https://hc-ping.com/<uuid>.',
        },
        {
          key: 'NOTIFY_PING_URL_OFFLOAD',
          kind: 'text',
          value: notify.offloadUrl,
          description: 'Eigener Check fuer die Auslagerung, leer = keiner. Nie derselbe wie oben.',
        },
        {
          key: 'NOTIFY_MAX_LINES',
          kind: 'number',
          value: String(notify.maxDetailLines),
          description: 'Wie viele Zeilen aus dem Log mitgeschickt werden, 0 = nur die Kopfdaten.',
        },
        {
          key: 'NOTIFY_PROXY',
          kind: 'text',
          value: notify.proxy,
          description: 'Proxy als http://host:port, leer = direkt hinaus.',
        },
      ],
    });
  }

  if (box.enabled) {
    sections.push({
      title: 'StorageBox',
      entries: [
        {
          key: 'BOX_HOST',
          kind: 'word',
          value: box.host,
          description: 'Hostname der Storage Box.',
        },
        {
          key: 'BOX_USER',
          kind: 'word',
          value: box.user,
          description: 'Benutzer bzw. Unterkonto auf der Box.',
        },
        {
          key: 'BOX_PORT',
          kind: 'port',
          value: String(box.port),
          description: 'SSH-Port. Hetzner verwendet auf einer Storage Box 23, nicht 22.',
        },
        {
          key: 'BOX_PATH',
          kind: 'path',
          value: box.remotePath,
          description: 'Zielverzeichnis auf der Box, darunter je Tag ein Ordner. Nicht / oder /home.',
        },
        {
          key: 'REMOTE_RETENTION_DAYS',
          kind: 'number',
          value: String(box.remoteRetentionDays),
          description: 'Aufbewahrung auf der Box in Tagen, 0 = dort nichts löschen.',
        },
      ],
    });
  }

  return sections;
}

/** Alle Schlüssel, die in dieser Konfiguration vorkommen. */
export function confKeys(config: ExportConfig): string[] {
  return confSections(config).flatMap((section) => section.entries.map((entry) => entry.key));
}

/** Kommentare in der Datei bleiben ASCII, wie in den Skripten. */
function ascii(text: string): string {
  return text
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss');
}

/** Werte mit Leerraum oder Kommentarzeichen stehen in Anführungszeichen. */
function formatValue(value: string): string {
  return /[\s#'"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

/**
 * Die Betriebswerte als eigene Datei. Die Skripte lesen sie bei jedem Lauf;
 * eine Änderung darin braucht weder neu erzeugte Skripte noch eine neue
 * Crontab.
 */
export function generateExportConf(config: ExportConfig): GeneratedFile {
  const path = `${dirName(config.scriptPath)}/${EXPORT_CONF_NAME}`;

  const body = confSections(config).map((section) =>
    [
      RULE,
      `#  ${section.title}`,
      RULE,
      '',
      ...section.entries.flatMap((entry) => [
        `# ${ascii(entry.description)}`,
        `${entry.key}=${formatValue(entry.value)}`,
        '',
      ]),
    ].join('\n'),
  );

  const content = [
    HEAVY_RULE,
    '#  Einstellungen fuer den Schema-Export',
    '#',
    `#  Kunde  : ${shCommentSafe(config.customer) || '-'}`,
    `#  Tenant : ${config.sid} (Instanz ${config.instance})`,
    `#  Datei  : ${path}`,
    '#',
    '#  Eine Einstellung pro Zeile als SCHLUESSEL=Wert. Leerzeilen und Zeilen',
    '#  mit # am Anfang werden uebergangen, Werte mit Leerzeichen in "...".',
    '#',
    '#  Die Skripte lesen die Datei bei jedem Lauf. Aenderungen gelten ab dem',
    '#  naechsten Lauf; danach pruefen mit:  ./03_preflight.sh',
    '#',
    '#  Nicht hier, sondern in Skripten und Crontab: SID, Benutzer,',
    '#  hdbuserstore-Key, Pfade, Komprimierung und die Uhrzeit des Laufs.',
    '#',
    `#  Erzeugt durch ${GENERATOR_NAME}, Stand ${GENERATOR_VERSION}.`,
    HEAVY_RULE,
    '',
    ...body,
  ].join('\n');

  return {
    name: EXPORT_CONF_NAME,
    title: 'Einstellungen',
    purpose:
      'Betriebswerte wie Aufbewahrung, Threads, Mail, Ueberwachung und StorageBox. Die Skripte lesen sie bei jedem Lauf – auf dem Server hier ändern.',
    language: 'text',
    executable: false,
    content,
  };
}

/**
 * Bash-Block, der `export.conf` neben dem Skript liest. Er definiert nur;
 * gelesen wird mit `read_export_conf SCHLUESSEL...`, damit jedes Skript
 * genau das verlangt, was es braucht. Ein Restore scheitert dadurch nicht
 * an einem Tippfehler in den Mail-Einstellungen.
 *
 * Die Datei wird zeilenweise ausgewertet und nicht mit `source` geladen: sie
 * kann nichts ausführen, und ein falscher Wert fällt beim Lesen auf statt
 * mitten im Lauf.
 */
export function confReader(config: ExportConfig): string {
  const kinds = confSections(config)
    .flatMap((section) => section.entries)
    .map((entry) => `        [${entry.key}]=${entry.kind}`)
    .join('\n');

  return `${RULE}
#  Einstellungen
#
#  Betriebswerte wie Aufbewahrung, Threads, Mail, Ueberwachung und StorageBox stehen nicht
#  im Skript, sondern in ${EXPORT_CONF_NAME} im selben Verzeichnis. Die Datei
#  wird zeilenweise gelesen und nicht mit "source" geladen.
${RULE}

EXPORT_CONF="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/${EXPORT_CONF_NAME}"
CONF_ISSUES=()
CONF_ERRORS=()

# Liest die genannten Schluessel aus EXPORT_CONF und setzt sie als
# Variablen. Ergebnis: 0 = alles da, 1 = Datei fehlt oder ist nicht lesbar,
# 2 = ein verlangter Wert fehlt oder ist ungueltig (siehe CONF_ERRORS).
# Unbrauchbare oder unbekannte Zeilen landen in CONF_ISSUES.
read_export_conf()
{
    local LINE KEY VALUE
    local NUMBER=0
    local ASSIGNMENT='^([A-Z][A-Z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$'
    local DOUBLE_QUOTED='^"([^"]*)"[[:space:]]*(#.*)?$'
    local QUOTE=$'\\x27'
    local SINGLE_QUOTED="^\${QUOTE}([^\${QUOTE}]*)\${QUOTE}[[:space:]]*(#.*)?$"
    local COUNT_PATTERN='^[1-9][0-9]{0,5}$'
    local NUMBER_PATTERN='^(0|[1-9][0-9]{0,5})$'
    local PORT_PATTERN='^[1-9][0-9]{0,4}$'
    local WORD_PATTERN='^[^[:space:]]+$'
    local PATH_PATTERN='^/[^[:space:]]*$'

    local -A KINDS=(
${kinds}
    )
    local -A EXPECTED=(
        [count]="eine ganze Zahl ab 1"
        [number]="eine ganze Zahl ab 0"
        [port]="einen Port von 1 bis 65535"
        [yesno]="yes oder no"
        [word]="einen Wert ohne Leerzeichen"
        [path]="einen absoluten Pfad"
    )
    local -A VALUES=()

    CONF_ISSUES=()
    CONF_ERRORS=()

    [ -r "\${EXPORT_CONF}" ] || return 1

    while IFS= read -r LINE || [ -n "\${LINE}" ]
    do
        NUMBER=$((NUMBER + 1))

        # Windows-Zeilenende, falls die Datei dort bearbeitet wurde.
        LINE="\${LINE%$'\\r'}"

        LINE="\${LINE#"\${LINE%%[![:space:]]*}"}"
        case "\${LINE}" in
            ''|'#'*) continue ;;
        esac

        if ! [[ "\${LINE}" =~ \${ASSIGNMENT} ]]; then
            CONF_ISSUES+=("Zeile \${NUMBER}: keine Zuweisung SCHLUESSEL=Wert")
            continue
        fi
        KEY="\${BASH_REMATCH[1]}"
        VALUE="\${BASH_REMATCH[2]}"

        # Ein Wert in Anfuehrungszeichen gilt, wie er dasteht. Sonst den
        # Kommentar dahinter und den Leerraum abschneiden.
        if [[ "\${VALUE}" =~ \${DOUBLE_QUOTED} ]] || [[ "\${VALUE}" =~ \${SINGLE_QUOTED} ]]; then
            VALUE="\${BASH_REMATCH[1]}"
        else
            case "\${VALUE}" in
                '#'*) VALUE="" ;;
            esac
            VALUE="\${VALUE%%[[:space:]]#*}"
            VALUE="\${VALUE%"\${VALUE##*[![:space:]]}"}"
        fi

        if [ -z "\${KINDS[\${KEY}]+x}" ]; then
            CONF_ISSUES+=("Zeile \${NUMBER}: unbekannter Schluessel \${KEY}")
            continue
        fi

        if [ -n "\${VALUES[\${KEY}]+x}" ]; then
            CONF_ISSUES+=("Zeile \${NUMBER}: \${KEY} steht doppelt, es gilt dieser Wert")
        fi
        VALUES[\${KEY}]="\${VALUE}"
    done < "\${EXPORT_CONF}"

    for KEY in "$@"
    do
        if [ -z "\${VALUES[\${KEY}]+x}" ]; then
            CONF_ERRORS+=("\${KEY} fehlt")
            continue
        fi
        VALUE="\${VALUES[\${KEY}]}"

        case "\${KINDS[\${KEY}]}" in
            count)  [[ "\${VALUE}" =~ \${COUNT_PATTERN} ]] ;;
            number) [[ "\${VALUE}" =~ \${NUMBER_PATTERN} ]] ;;
            port)   [[ "\${VALUE}" =~ \${PORT_PATTERN} ]] && [ "\${VALUE}" -le 65535 ] ;;
            yesno)  [ "\${VALUE}" = "yes" ] || [ "\${VALUE}" = "no" ] ;;
            word)   [[ "\${VALUE}" =~ \${WORD_PATTERN} ]] ;;
            path)   [[ "\${VALUE}" =~ \${PATH_PATTERN} ]] ;;
            *)      true ;;
        esac

        if [ $? -ne 0 ]; then
            CONF_ERRORS+=("\${KEY}=\${VALUE} ist ungueltig, erwartet wird \${EXPECTED[\${KINDS[\${KEY}]}]}")
            continue
        fi

        printf -v "\${KEY}" '%s' "\${VALUE}"
    done

    [ \${#CONF_ERRORS[@]} -eq 0 ] || return 2
    return 0
}`;
}

/**
 * Liest Schlüssel und bricht bei einem Fehler mit Meldung auf stderr ab.
 * Für Skripte ohne eigenes Log, die von Hand gestartet werden.
 */
export function confReadOrExit(keys: readonly string[]): string {
  return `read_export_conf ${keys.join(' ')}
case $? in
    0)
        ;;
    1)
        echo "FEHLER: Einstellungen fehlen oder sind nicht lesbar: \${EXPORT_CONF}" >&2
        exit 1
        ;;
    *)
        printf 'FEHLER: ${EXPORT_CONF_NAME}: %s\\n' "\${CONF_ERRORS[@]}" >&2
        exit 1
        ;;
esac`;
}
