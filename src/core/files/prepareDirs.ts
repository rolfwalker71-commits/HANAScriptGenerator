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

mkdir -p "\${EXPORT_BASE}/logs" || {
    echo "FEHLER: \${EXPORT_BASE}/logs konnte nicht angelegt werden." >&2
    exit 1
}

for SCHEMA in "\${SCHEMAS[@]}"
do
    mkdir -p "\${EXPORT_BASE}/\${SCHEMA}" || {
        echo "FEHLER: \${EXPORT_BASE}/\${SCHEMA} konnte nicht angelegt werden." >&2
        exit 1
    }
    echo "  \${EXPORT_BASE}/\${SCHEMA}"
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
${RULE}

TEST_FILE="\${EXPORT_BASE}/.write_test_$$"

if ! touch "\${TEST_FILE}" 2>/dev/null; then
    echo "FEHLER: In \${EXPORT_BASE} kann nicht geschrieben werden." >&2
    exit 1
fi

rm -f "\${TEST_FILE}"

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
