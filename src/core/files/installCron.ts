import type { ExportConfig, GeneratedFile } from '../types.js';
import { RULE, scriptHeader, userGuard } from './common.js';

/** Klartextbeschreibung des Zeitplans für Kommentare und Anleitung. */
export function scheduleDescription(config: ExportConfig): string {
  const time = `${String(config.schedule.hour).padStart(2, '0')}:${String(config.schedule.minute).padStart(2, '0')}`;
  const dow = config.schedule.dayOfWeek;
  if (dow === '*') return `täglich um ${time} Uhr`;
  if (dow === '1-5') return `montags bis freitags um ${time} Uhr`;
  if (dow === '0' || dow === '7') return `sonntags um ${time} Uhr`;
  if (dow === '6') return `samstags um ${time} Uhr`;
  if (dow === '6,0' || dow === '0,6') return `samstags und sonntags um ${time} Uhr`;
  return `um ${time} Uhr an den Wochentagen ${dow}`;
}

/** Die Crontab-Zeile ohne Markerkommentar. */
export function cronLine(config: ExportConfig): string {
  const { hour, minute, dayOfWeek } = config.schedule;
  return `${minute} ${hour} * * ${dayOfWeek} ${config.scriptPath} >/dev/null 2>&1`;
}

/** Eindeutiger Marker, damit ein erneuter Lauf den Eintrag ersetzt statt doppelt anlegt. */
export function cronMarker(config: ExportConfig): string {
  return `# HANAScriptGenerator: Schema-Export ${config.sid}`;
}

/**
 * Trägt den Cronjob idempotent in die Crontab des Instanzbenutzers ein.
 * `--remove` entfernt ihn wieder, `--show` zeigt nur den geplanten Eintrag.
 */
export function generateInstallCron(config: ExportConfig): GeneratedFile {
  const marker = cronMarker(config);
  const line = cronLine(config);

  const content = `${scriptHeader(config, 'Schritt 5 – Cronjob einrichten', [
    `Zeitplan: ${scheduleDescription(config)}`,
    `Eintrag:  ${line}`,
    '',
    'Aufruf:',
    '  ./05_install_cron.sh           Eintrag setzen oder aktualisieren',
    '  ./05_install_cron.sh --show    Nur anzeigen, nichts aendern',
    '  ./05_install_cron.sh --remove  Eintrag entfernen',
  ])}

set -u

SCRIPT_PATH="${config.scriptPath}"
CRON_MARKER="${marker}"
CRON_LINE="${line}"

MODE="\${1:-install}"

${userGuard(config)}

${RULE}
#  Nur anzeigen
${RULE}

if [ "\${MODE}" = "--show" ]; then
    echo "Geplanter Eintrag fuer $(whoami):"
    echo
    echo "\${CRON_MARKER}"
    echo "\${CRON_LINE}"
    echo
    echo "Aktuelle Crontab:"
    crontab -l 2>/dev/null || echo "  (leer)"
    exit 0
fi

${RULE}
#  Bestehende Crontab sichern
${RULE}

BACKUP="\${HOME}/crontab_backup_$(date +%Y-%m-%d_%H-%M-%S).txt"
TMP_CRON="$(mktemp)"

trap 'rm -f "\${TMP_CRON}"' EXIT

crontab -l > "\${BACKUP}" 2>/dev/null || true

if [ -s "\${BACKUP}" ]; then
    echo "Bestehende Crontab gesichert: \${BACKUP}"
else
    rm -f "\${BACKUP}"
    echo "Es existierte noch keine Crontab."
fi

# Alten Eintrag herausfiltern: sowohl den Marker als auch jede Zeile, die
# unser Skript aufruft. So bleibt bei wiederholtem Lauf kein Duplikat zurueck.
crontab -l 2>/dev/null \\
    | grep -v -F -- "\${CRON_MARKER}" \\
    | grep -v -F -- "\${SCRIPT_PATH}" \\
    > "\${TMP_CRON}" || true

${RULE}
#  Entfernen
${RULE}

if [ "\${MODE}" = "--remove" ]; then
    crontab "\${TMP_CRON}"
    echo "Cronjob entfernt."
    echo
    echo "Aktuelle Crontab:"
    crontab -l 2>/dev/null || echo "  (leer)"
    exit 0
fi

${RULE}
#  Einrichten
${RULE}

if [ ! -f "\${SCRIPT_PATH}" ]; then
    echo "FEHLER: Das Exportskript fehlt: \${SCRIPT_PATH}" >&2
    echo "Bitte zuerst dorthin kopieren und ausfuehrbar machen." >&2
    exit 1
fi

if [ ! -x "\${SCRIPT_PATH}" ]; then
    echo "FEHLER: Das Exportskript ist fuer $(whoami) nicht ausfuehrbar:" >&2
    ls -l "\${SCRIPT_PATH}" >&2
    echo >&2
    echo "Haeufige Ursache: als root hierher kopiert, also root:root." >&2
    echo "Cron startet es aber als $(whoami). Abhilfe als root:" >&2
    echo "  chown ${config.osUser}:sapsys \${SCRIPT_PATH}" >&2
    echo "  chmod 750 \${SCRIPT_PATH}" >&2
    exit 1
fi

if [ ! -r "\${SCRIPT_PATH}" ]; then
    echo "FEHLER: Das Exportskript ist fuer $(whoami) nicht lesbar." >&2
    ls -l "\${SCRIPT_PATH}" >&2
    exit 1
fi

if ! bash -n "\${SCRIPT_PATH}"; then
    echo "FEHLER: Das Exportskript hat einen Syntaxfehler. Cron wird nicht eingerichtet." >&2
    exit 1
fi

{
    echo "\${CRON_MARKER}"
    echo "\${CRON_LINE}"
} >> "\${TMP_CRON}"

crontab "\${TMP_CRON}"

echo "Cronjob eingerichtet (${scheduleDescription(config)})."
echo
echo "Aktuelle Crontab:"
crontab -l | sed 's/^/  /'
`;

  return {
    name: '05_install_cron.sh',
    title: '5 · Cronjob',
    purpose: `Trägt den Lauf ${scheduleDescription(config)} idempotent in die Crontab von ${config.osUser} ein.`,
    language: 'bash',
    executable: true,
    content,
  };
}
