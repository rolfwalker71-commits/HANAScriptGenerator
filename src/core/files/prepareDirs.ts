import type { ExportConfig, GeneratedFile } from '../types.js';
import { RULE, dirName, schemaArray, scriptHeader, userGuard } from './common.js';

/** Legt Exportbasis, Logverzeichnis und die Schema-Unterverzeichnisse an. */
export function generatePrepareDirs(config: ExportConfig): GeneratedFile {
  const scriptDir = dirName(config.scriptPath);

  const content = `${scriptHeader(config, 'Schritt 2 – Verzeichnisse vorbereiten', [
    `Exportbasis: ${config.exportBase}`,
    'Legt pro Schema ein eigenes Unterverzeichnis an, damit jeder Export',
    'und jedes Archiv getrennt abgelegt werden koennen.',
  ])}

set -u

EXPORT_BASE="${config.exportBase}"
SCRIPT_DIR="${scriptDir}"

${schemaArray(config)}

${userGuard(config)}

${RULE}
#  Verzeichnisse anlegen
${RULE}

echo "Lege Exportverzeichnisse an..."

# Je Lauf entsteht ein Tagesordner; der wird zur Laufzeit angelegt. Fest
# gebraucht werden nur die Basis, das Log- und das Vermerkverzeichnis.
for DIR in "\${EXPORT_BASE}" "\${EXPORT_BASE}/logs" "\${EXPORT_BASE}/.offloaded"
do
    mkdir -p "\${DIR}" || {
        echo "FEHLER: \${DIR} konnte nicht angelegt werden." >&2
        exit 1
    }
    echo "  \${DIR}"
done

mkdir -p "\${SCRIPT_DIR}" || {
    echo "FEHLER: \${SCRIPT_DIR} konnte nicht angelegt werden." >&2
    exit 1
}

${RULE}
#  Rechte setzen
#
#  Die Exporte enthalten Nutzdaten der Datenbank. Sie gehen deshalb nur den
#  Instanzbenutzer und seine Gruppe etwas an.
${RULE}

chmod 750 "\${EXPORT_BASE}" || true

${RULE}
#  Schreibtest
#
#  Jedes Verzeichnis einzeln pruefen. Ein bestehendes Unterverzeichnis kann
#  einem anderen Benutzer gehoeren, obwohl die Basis in Ordnung ist – zum
#  Beispiel, wenn frueher einmal etwas als root angelegt wurde. Der Export
#  wuerde daran erst nachts scheitern.
${RULE}

write_test()
{
    TEST_FILE="$1/.write_test_$$"

    if touch "\${TEST_FILE}" 2>/dev/null; then
        rm -f "\${TEST_FILE}"
        echo "  schreibbar: $1"
        return 0
    fi

    echo "FEHLER: In $1 kann $(whoami) nicht schreiben." >&2
    ls -ld "$1" >&2
    return 1
}

FAILED=0

write_test "\${EXPORT_BASE}" || FAILED=1
write_test "\${EXPORT_BASE}/logs" || FAILED=1
write_test "\${EXPORT_BASE}/.offloaded" || FAILED=1

if [ \${FAILED} -ne 0 ]; then
    echo >&2
    echo "Haeufige Ursache: die Verzeichnisse wurden als root angelegt." >&2
    echo "Abhilfe als root:" >&2
    echo "  chown -R ${config.osUser}:sapsys \${EXPORT_BASE}" >&2
    echo "  chmod -R u+rwX \${EXPORT_BASE}" >&2
    exit 1
fi

echo "Schreibtest erfolgreich."

${RULE}
#  Ergebnis
${RULE}

echo
ls -ld "\${EXPORT_BASE}" "\${EXPORT_BASE}/logs"
echo
df -h "\${EXPORT_BASE}"
echo
echo "Schritt 2 abgeschlossen."
`;

  return {
    name: '02_prepare_dirs.sh',
    title: '2 · Verzeichnisse',
    purpose: `Legt ${config.exportBase} samt Log- und Schema-Unterverzeichnissen an und prüft das Schreibrecht.`,
    language: 'bash',
    executable: true,
    content,
  };
}
