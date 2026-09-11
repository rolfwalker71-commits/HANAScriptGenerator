import type { ExportConfig, GeneratedFile } from '../types.js';
import { RULE, scriptHeader, userGuard } from './common.js';

/**
 * Legt den hdbuserstore-Key an. Der Store ist benutzerspezifisch, deshalb muss
 * dieses Skript unter demselben Linux-Benutzer laufen wie der spätere Cronjob.
 */
export function generateSetupUserstore(config: ExportConfig): GeneratedFile {
  const content = `${scriptHeader(config, 'Schritt 1 – hdbuserstore-Key anlegen', [
    'Der hdbuserstore ist benutzerspezifisch. Key und Cronjob muessen',
    `deshalb beide unter ${config.osUser} eingerichtet werden.`,
    'Das Passwort wird interaktiv abgefragt und nirgends abgelegt.',
  ])}

set -u

HANA_KEY="${config.userstoreKey}"
HANA_ENV="${config.host}:${config.port}"
HANA_USER="${config.dbUser}"

${userGuard(config)}

${RULE}
#  hdbuserstore verfuegbar?
#
#  Nur die Erreichbarkeit des Programms pruefen. Der Rueckgabewert von
#  "hdbuserstore list" taugt dafuer nicht: ist noch kein Key hinterlegt,
#  meldet es "NUMBER OF COMPLETE KEY: 0" und endet ungleich null, obwohl
#  alles in Ordnung ist. Genau dieser Fall liegt beim ersten Lauf vor.
${RULE}

if ! command -v hdbuserstore >/dev/null 2>&1; then
    echo "FEHLER: hdbuserstore wurde nicht gefunden." >&2
    echo "Hinweis: PATH pruefen, der HANA-Client muss erreichbar sein." >&2
    exit 1
fi

${RULE}
#  Bestehende Keys anzeigen
${RULE}

echo "Vorhandene hdbuserstore-Keys fuer $(whoami):"
echo
hdbuserstore list 2>&1 || true
echo

# Ob ein Key existiert, steht in der Ausgabe, nicht im Rueckgabewert.
userstore_has_key()
{
    hdbuserstore list "$1" 2>/dev/null | grep -q "KEY[[:space:]][[:space:]]*$1"
}

if userstore_has_key "\${HANA_KEY}"; then
    echo "Hinweis: Der Key \${HANA_KEY} existiert bereits und wird ueberschrieben."
    echo "Andere Keys bleiben unveraendert."
    printf "Fortfahren? [j/N] "
    read -r ANSWER
    case "\${ANSWER}" in
        j|J|y|Y) ;;
        *) echo "Abgebrochen."; exit 1 ;;
    esac
    echo
fi

${RULE}
#  Passwort abfragen
${RULE}

printf "Passwort fuer %s auf %s: " "\${HANA_USER}" "\${HANA_ENV}"
read -rs HANA_PASSWORD
echo

if [ -z "\${HANA_PASSWORD}" ]; then
    echo "FEHLER: Es wurde kein Passwort eingegeben." >&2
    exit 1
fi

printf "Passwort wiederholen: "
read -rs HANA_PASSWORD_CONFIRM
echo

if [ "\${HANA_PASSWORD}" != "\${HANA_PASSWORD_CONFIRM}" ]; then
    echo "FEHLER: Die Eingaben stimmen nicht ueberein." >&2
    unset HANA_PASSWORD HANA_PASSWORD_CONFIRM
    exit 1
fi

${RULE}
#  Key setzen
#
#  hdbuserstore nimmt das Passwort nur als Argument entgegen. Es ist dadurch
#  fuer die Dauer des Aufrufs in der Prozessliste sichtbar. Genau deshalb wird
#  der Key interaktiv gesetzt und nicht aus einer Datei oder der Crontab.
${RULE}

hdbuserstore set "\${HANA_KEY}" "\${HANA_ENV}" "\${HANA_USER}" "\${HANA_PASSWORD}"
RC=$?

unset HANA_PASSWORD HANA_PASSWORD_CONFIRM

if [ \${RC} -ne 0 ]; then
    echo "FEHLER: Key konnte nicht gesetzt werden (RC \${RC})." >&2
    exit 1
fi

echo
echo "Key \${HANA_KEY} wurde gesetzt:"
hdbuserstore list "\${HANA_KEY}"

${RULE}
#  Verbindung sofort testen
${RULE}

echo
echo "Teste Verbindung..."

if [ -x "${config.hdbsqlPath}" ]; then
    HDBSQL="${config.hdbsqlPath}"
else
    HDBSQL="$(command -v hdbsql || true)"
fi

if [ -z "\${HDBSQL}" ]; then
    echo "WARNUNG: hdbsql nicht gefunden, Verbindungstest uebersprungen." >&2
    echo "Bitte 'which hdbsql' ausfuehren und den Pfad in den Skripten anpassen." >&2
    exit 0
fi

"\${HDBSQL}" -U "\${HANA_KEY}" "SELECT CURRENT_USER FROM DUMMY;"
RC=$?

if [ \${RC} -ne 0 ]; then
    echo "FEHLER: Verbindung mit Key \${HANA_KEY} fehlgeschlagen (RC \${RC})." >&2
    exit 1
fi

echo
echo "Schritt 1 abgeschlossen."
`;

  return {
    name: '01_setup_userstore.sh',
    title: '1 · Userstore',
    purpose: `Legt den hdbuserstore-Key ${config.userstoreKey} für ${config.osUser} an und testet ihn sofort.`,
    language: 'bash',
    executable: true,
    content,
  };
}
