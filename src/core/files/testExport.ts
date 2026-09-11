import type { ExportConfig, GeneratedFile } from '../types.js';
import { RULE, scriptHeader, userGuard } from './common.js';

/**
 * Einmaliger Testexport eines einzelnen Schemas in ein Wegwerfverzeichnis –
 * inklusive tar-Lauf, damit auch die Archivierung vor dem ersten Cronlauf
 * einmal bewiesen ist.
 */
export function generateTestExport(config: ExportConfig): GeneratedFile {
  const firstSchema = config.schemas[0] ?? 'SCHEMA';

  const content = `${scriptHeader(config, 'Schritt 4 – Einmaliger Testexport', [
    'Exportiert genau ein Schema in ein Testverzeichnis und archiviert es.',
    'Damit sind Export und tar-Lauf bewiesen, bevor Cron uebernimmt.',
    '',
    'Aufruf:',
    '  ./04_test_export.sh [SCHEMA]         Testdaten danach entfernen',
    '  ./04_test_export.sh [SCHEMA] --keep  Testdaten liegen lassen',
    '',
    'Laeuft ohne Rueckfrage durch und endet von selbst.',
  ])}

set -u

HANA_KEY="${config.userstoreKey}"
HDBSQL="${config.hdbsqlPath}"
EXPORT_BASE="${config.exportBase}"
THREADS=${config.threads}
COMPRESSION="${config.compression}"

${RULE}
#  Aufrufparameter
#
#  Bewusst ohne Rueckfrage am Ende: bei einem Skript, das auf eine Eingabe
#  wartet, laesst sich "wartet" nicht von "haengt" unterscheiden.
${RULE}

SCHEMA=""
KEEP_TEST_DATA="no"

for ARG in "$@"
do
    case "\${ARG}" in
        --keep) KEEP_TEST_DATA="yes" ;;
        -*)     echo "FEHLER: Unbekannter Schalter \${ARG}" >&2; exit 1 ;;
        *)      SCHEMA="\${ARG}" ;;
    esac
done

SCHEMA="\${SCHEMA:-${firstSchema}}"

TEST_DIR="\${EXPORT_BASE}/\${SCHEMA}/manual_test"
TEST_ARCHIVE="\${EXPORT_BASE}/\${SCHEMA}/manual_test.tar"

case "\${COMPRESSION}" in
    gz)   TAR_CREATE=(-czf); TEST_ARCHIVE="\${TEST_ARCHIVE}.gz" ;;
    zst)  TAR_CREATE=(--zstd -cf); TEST_ARCHIVE="\${TEST_ARCHIVE}.zst" ;;
    none) TAR_CREATE=(-cf) ;;
    *)    echo "FEHLER: Unbekannte Komprimierung \${COMPRESSION}" >&2; exit 1 ;;
esac

${userGuard(config)}

if [ ! -x "\${HDBSQL}" ]; then
    echo "FEHLER: hdbsql nicht gefunden: \${HDBSQL}" >&2
    exit 1
fi

${RULE}
#  Testexport
${RULE}

echo "Testexport von Schema \${SCHEMA}"
echo "Zielverzeichnis: \${TEST_DIR}"
echo

rm -rf "\${TEST_DIR}"
mkdir -p "\${TEST_DIR}" || {
    echo "FEHLER: \${TEST_DIR} konnte nicht angelegt werden." >&2
    exit 1
}

SQL="EXPORT \\"\${SCHEMA}\\".\\"*\\" AS BINARY INTO '\${TEST_DIR}' WITH REPLACE THREADS \${THREADS};"

echo "Setze ab:"
echo "  \${SQL}"
echo

START="$(date +%s)"

"\${HDBSQL}" -U "\${HANA_KEY}" "\${SQL}"
RC=$?

END="$(date +%s)"

if [ \${RC} -ne 0 ]; then
    echo >&2
    echo "FEHLER: Export fehlgeschlagen (RC \${RC})." >&2
    exit 1
fi

echo
echo "Export erfolgreich in $((END - START)) Sekunden."
echo "Groesse: $(du -sh "\${TEST_DIR}" | awk '{print $1}')"
echo
echo "Erste Dateien im Export:"
find "\${TEST_DIR}" -maxdepth 3 -type f | head -20 | sed 's/^/  /'

${RULE}
#  Testarchivierung
${RULE}

echo
echo "Archiviere Testexport nach \${TEST_ARCHIVE} ..."

START="$(date +%s)"

tar -C "\${EXPORT_BASE}/\${SCHEMA}" "\${TAR_CREATE[@]}" "\${TEST_ARCHIVE}" "manual_test"
RC=$?

END="$(date +%s)"

if [ \${RC} -ne 0 ]; then
    echo "FEHLER: Archivierung fehlgeschlagen (RC \${RC})." >&2
    exit 1
fi

echo "Archiv erstellt in $((END - START)) Sekunden."
echo "Archivgroesse: $(du -sh "\${TEST_ARCHIVE}" | awk '{print $1}')"

${RULE}
#  Aufraeumen
${RULE}

echo

if [ "\${KEEP_TEST_DATA}" = "yes" ]; then
    echo "Testdaten bleiben auf Wunsch liegen:"
    echo "  \${TEST_DIR}"
    echo "  \${TEST_ARCHIVE}"
    echo
    echo "Entfernen mit:"
    echo "  rm -rf \${TEST_DIR}"
    echo "  rm -f \${TEST_ARCHIVE}"
else
    rm -rf "\${TEST_DIR}"
    rm -f "\${TEST_ARCHIVE}"
    echo "Testdaten entfernt. Behalten mit dem Schalter --keep."
fi

echo
echo "Schritt 4 abgeschlossen. Jetzt das Hauptskript einmal manuell starten:"
echo "  ${config.scriptPath}"

exit 0
`;

  return {
    name: '04_test_export.sh',
    title: '4 · Testexport',
    purpose: `Exportiert einmalig ${firstSchema} in ein Testverzeichnis und archiviert es, bevor Cron übernimmt.`,
    language: 'bash',
    executable: true,
    content,
  };
}
