import type { ExportConfig, GeneratedFile } from '../types.js';
import { RULE, archiveExtension, scriptHeader, userGuard } from './common.js';
import { confReadOrExit, confReader } from './exportConf.js';

/**
 * Gegenstück zum Export: entpackt ein Archiv und spielt es auf Wunsch per
 * IMPORT zurück. Der IMPORT überschreibt Produktivdaten, deshalb muss der
 * Schemaname zur Bestätigung eingetippt werden.
 */
export function generateRestore(config: ExportConfig): GeneratedFile {
  const ext = archiveExtension(config.compression);

  const content = `${scriptHeader(config, 'Wiederherstellung aus einem Archiv', [
    'Entpackt ein Export-Archiv und spielt es auf Wunsch zurueck.',
    '',
    'Aufruf:',
    '  ./90_restore_schema.sh --list',
    '  ./90_restore_schema.sh SCHEMA JJJJ-MM-TT            nur entpacken',
    '  ./90_restore_schema.sh SCHEMA JJJJ-MM-TT --import   entpacken und IMPORT',
    '',
    'ACHTUNG: --import ueberschreibt vorhandene Objekte des Schemas.',
  ])}

set -u

HANA_KEY="${config.userstoreKey}"
HDBSQL="${config.hdbsqlPath}"
EXPORT_BASE="${config.exportBase}"
ARCHIVE_EXT="${ext}"
COMPRESSION="${config.compression}"

${confReader(config)}

RESTORE_BASE="\${EXPORT_BASE}/_restore"

case "\${COMPRESSION}" in
    gz)   TAR_EXTRACT=(-xzf) ;;
    zst)  TAR_EXTRACT=(--zstd -xf) ;;
    none) TAR_EXTRACT=(-xf) ;;
    *)    echo "FEHLER: Unbekannte Komprimierung \${COMPRESSION}" >&2; exit 1 ;;
esac

${userGuard(config)}

${RULE}
#  Vorhandene Archive auflisten
${RULE}

if [ "\${1:-}" = "--list" ] || [ -z "\${1:-}" ]; then

    echo "Vorhandene Archive unter \${EXPORT_BASE}:"
    echo

    for DAY_DIR in "\${EXPORT_BASE}"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]
    do
        [ -d "\${DAY_DIR}" ] || continue

        echo "  $(basename "\${DAY_DIR}")"

        find "\${DAY_DIR}" -maxdepth 1 -type f -name "*.\${ARCHIVE_EXT}" 2>/dev/null \\
            | sort \\
            | while read -r FILE
              do
                  echo "    $(basename "\${FILE}")  $(du -sh "\${FILE}" | awk '{print $1}')"
              done
        echo
    done

    echo "Wiederherstellen mit:"
    echo "  $0 SCHEMA JJJJ-MM-TT [--import]"
    exit 0
fi

SCHEMA="$1"
RESTORE_DATE="\${2:-}"
DO_IMPORT="\${3:-}"

if [ -z "\${RESTORE_DATE}" ]; then
    echo "FEHLER: Es fehlt das Datum im Format JJJJ-MM-TT." >&2
    echo "Uebersicht mit: $0 --list" >&2
    exit 1
fi

ARCHIVE="\${EXPORT_BASE}/\${RESTORE_DATE}/\${SCHEMA}_\${RESTORE_DATE}.\${ARCHIVE_EXT}"
TARGET_DIR="\${RESTORE_BASE}/\${SCHEMA}_\${RESTORE_DATE}"

if [ ! -f "\${ARCHIVE}" ]; then
    echo "FEHLER: Archiv nicht gefunden: \${ARCHIVE}" >&2
    echo "Uebersicht mit: $0 --list" >&2
    exit 1
fi

${RULE}
#  Entpacken
${RULE}

echo "Archiv:     \${ARCHIVE}"
echo "Zielordner: \${TARGET_DIR}"
echo

rm -rf "\${TARGET_DIR}"
mkdir -p "\${TARGET_DIR}" || {
    echo "FEHLER: \${TARGET_DIR} konnte nicht angelegt werden." >&2
    exit 1
}

tar -C "\${TARGET_DIR}" "\${TAR_EXTRACT[@]}" "\${ARCHIVE}"
RC=$?

if [ \${RC} -ne 0 ]; then
    echo "FEHLER: Archiv konnte nicht entpackt werden (RC \${RC})." >&2
    exit 1
fi

# Im Archiv liegt der Schemaordner, der Export selbst eine Ebene tiefer.
IMPORT_DIR="\${TARGET_DIR}/\${SCHEMA}"

if [ ! -d "\${IMPORT_DIR}" ]; then
    IMPORT_DIR="\${TARGET_DIR}"
fi

echo "Entpackt nach \${IMPORT_DIR}"
echo "Groesse: $(du -sh "\${IMPORT_DIR}" | awk '{print $1}')"
echo

if [ "\${DO_IMPORT}" != "--import" ]; then
    echo "Es wurde nur entpackt. Fuer den eigentlichen IMPORT:"
    echo "  $0 \${SCHEMA} \${RESTORE_DATE} --import"
    exit 0
fi

# Erst fuer den IMPORT gebraucht. Auflisten und Entpacken gehen deshalb
# auch dann, wenn die Einstellungen gerade nicht lesbar sind. Gelesen wird
# vor der Rueckfrage, damit sie nicht umsonst beantwortet wird.
${confReadOrExit(['THREADS'])}

${RULE}
#  Sicherheitsabfrage
${RULE}

echo "ACHTUNG"
echo "Der folgende IMPORT ueberschreibt Objekte des Schemas \${SCHEMA}"
echo "in der Datenbank ${config.sid} auf ${config.host}."
echo
printf "Zur Bestaetigung den Schemanamen eintippen: "
read -r CONFIRM

if [ "\${CONFIRM}" != "\${SCHEMA}" ]; then
    echo "Abgebrochen. Die entpackten Daten liegen unter \${IMPORT_DIR}."
    exit 1
fi

${RULE}
#  IMPORT
${RULE}

if [ ! -x "\${HDBSQL}" ]; then
    echo "FEHLER: hdbsql nicht gefunden: \${HDBSQL}" >&2
    exit 1
fi

SQL="IMPORT \\"\${SCHEMA}\\".\\"*\\" AS BINARY FROM '\${IMPORT_DIR}' WITH REPLACE THREADS \${THREADS};"

echo
echo "Setze ab:"
echo "  \${SQL}"
echo

"\${HDBSQL}" -U "\${HANA_KEY}" "\${SQL}"
RC=$?

if [ \${RC} -ne 0 ]; then
    echo "FEHLER: IMPORT fehlgeschlagen (RC \${RC})." >&2
    echo "Die entpackten Daten bleiben unter \${IMPORT_DIR} liegen." >&2
    exit 1
fi

echo
echo "IMPORT von \${SCHEMA} abgeschlossen."
echo "Die entpackten Daten koennen jetzt entfernt werden:"
echo "  rm -rf \${TARGET_DIR}"
`;

  return {
    name: '90_restore_schema.sh',
    title: '90 · Restore',
    purpose: 'Listet Archive, entpackt eines davon und spielt es nach Rückfrage per IMPORT zurück.',
    language: 'bash',
    executable: true,
    content,
  };
}
