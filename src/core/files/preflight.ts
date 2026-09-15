import type { ExportConfig, GeneratedFile } from '../types.js';
import { RULE, schemaFileReader, scriptHeader, userGuard } from './common.js';

/**
 * Prüft alles, was der spätere Cronlauf voraussetzt: Client, Verbindung,
 * Schemas, Verzeichnis, Werkzeuge und Speicherplatz. Verändert nichts.
 */
export function generatePreflight(config: ExportConfig): GeneratedFile {
  const needsZstd = config.compression === 'zst';
  const box = config.offload;

  const content = `${scriptHeader(config, 'Schritt 3 – Vorabpruefung', [
    'Prueft alle Voraussetzungen des spaeteren Exports.',
    'Dieses Skript veraendert nichts und kann jederzeit wiederholt werden.',
  ])}

set -u

HANA_KEY="${config.userstoreKey}"
HDBSQL="${config.hdbsqlPath}"
EXPORT_BASE="${config.exportBase}"
MIN_FREE_GB=${config.minFreeGb}

${schemaFileReader()}

CHECKS_OK=0
CHECKS_FAILED=0

ok()
{
    echo "  [ OK ]   $*"
    CHECKS_OK=$((CHECKS_OK + 1))
}

fail()
{
    echo "  [FEHLER] $*"
    CHECKS_FAILED=$((CHECKS_FAILED + 1))
}

note()
{
    echo "  [ INFO ] $*"
}

echo
echo "Vorabpruefung fuer ${config.sid} auf ${config.host}"
echo

${RULE}
#  1. Linux-Benutzer
${RULE}

${userGuard(config)}

ok "Linux-Benutzer ist ${config.osUser}."
note "Host: $(hostname)"

${RULE}
#  2. HANA-Client
${RULE}

if [ -x "\${HDBSQL}" ]; then
    ok "hdbsql gefunden: \${HDBSQL}"
else
    fail "hdbsql fehlt oder ist nicht ausfuehrbar: \${HDBSQL}"
    FOUND="$(command -v hdbsql || true)"
    if [ -n "\${FOUND}" ]; then
        note "Im PATH liegt stattdessen: \${FOUND}"
        note "Diesen Pfad in allen Skripten als HDBSQL eintragen."
    fi
fi

${RULE}
#  3. Werkzeuge
${RULE}

for TOOL in tar find du df flock${needsZstd ? ' zstd' : ''}
do
    if command -v "\${TOOL}" >/dev/null 2>&1; then
        ok "\${TOOL} verfuegbar."
    else
        fail "\${TOOL} fehlt – das Exportskript benoetigt es."
    fi
done

${RULE}
#  4. hdbuserstore-Key
${RULE}

# Der Rueckgabewert von hdbuserstore taugt nicht als Vorhandensein-Pruefung:
# ohne hinterlegten Key endet der Aufruf ungleich null, obwohl er
# fehlerfrei gelaufen ist. Deshalb die Ausgabe auswerten.
if ! command -v hdbuserstore >/dev/null 2>&1; then
    fail "hdbuserstore wurde nicht gefunden. PATH und HANA-Client pruefen."
elif hdbuserstore list "\${HANA_KEY}" 2>/dev/null | grep -q "KEY[[:space:]][[:space:]]*\${HANA_KEY}"; then
    ok "hdbuserstore-Key \${HANA_KEY} vorhanden."
    hdbuserstore list "\${HANA_KEY}" 2>/dev/null | sed 's/^/           /'
else
    fail "hdbuserstore-Key \${HANA_KEY} fehlt. Zuerst 01_setup_userstore.sh ausfuehren."
fi

${RULE}
#  5. Schemaliste
${RULE}

if read_schema_file; then
    if [ \${#SCHEMAS[@]} -gt 0 ]; then
        ok "Schemaliste gelesen: \${SCHEMA_FILE} (\${#SCHEMAS[@]} Schemas)"
    else
        fail "In \${SCHEMA_FILE} steht kein Schema."
    fi

    for ISSUE in \${SCHEMA_FILE_ISSUES[@]+"\${SCHEMA_FILE_ISSUES[@]}"}
    do
        fail "\${ISSUE}. Der Export uebergeht diese Zeile."
    done
else
    fail "Schemaliste fehlt oder ist nicht lesbar: \${SCHEMA_FILE}"
fi

${RULE}
#  6. Verbindung und Zieldatenbank
${RULE}

if [ -x "\${HDBSQL}" ]; then

    if "\${HDBSQL}" -U "\${HANA_KEY}" "SELECT CURRENT_USER FROM DUMMY;" >/dev/null 2>&1; then
        ok "Anmeldung ueber \${HANA_KEY} erfolgreich."
    else
        fail "Anmeldung ueber \${HANA_KEY} fehlgeschlagen."
    fi

    echo
    note "Zieldatenbank laut SYS.M_DATABASE:"
    "\${HDBSQL}" -U "\${HANA_KEY}" \\
        "SELECT DATABASE_NAME, HOST FROM SYS.M_DATABASE;" 2>&1 | sed 's/^/           /'
    echo

${RULE}
#  7. Schemas in der Datenbank
${RULE}

    note "Erwartet werden: \${SCHEMAS[*]:-keine}"

    for SCHEMA in \${SCHEMAS[@]+"\${SCHEMAS[@]}"}
    do
        COUNT="$("\${HDBSQL}" -U "\${HANA_KEY}" -a -x \\
            "SELECT COUNT(*) FROM SYS.SCHEMAS WHERE SCHEMA_NAME = '\${SCHEMA}';" 2>/dev/null | tr -dc '0-9')"

        if [ "\${COUNT:-0}" -ge 1 ]; then
            ok "Schema \${SCHEMA} existiert."
        else
            fail "Schema \${SCHEMA} wurde nicht gefunden. Schreibweise in \${SCHEMA_FILE} pruefen; der Export wuerde es ueberspringen."
        fi
    done

    if [ \${#SCHEMAS[@]} -gt 0 ]; then
        # Die Namen sind beim Lesen geprueft und enthalten kein Anfuehrungszeichen.
        SQL_LIST="$(printf "'%s'," "\${SCHEMAS[@]}")"
        SQL_LIST="\${SQL_LIST%,}"

        echo
        note "Ungefaehre Groesse der Schemas im Hauptspeicher:"
        "\${HDBSQL}" -U "\${HANA_KEY}" \\
            "SELECT SCHEMA_NAME, ROUND(SUM(MEMORY_SIZE_IN_TOTAL)/1024/1024/1024,2) AS MEMORY_GB
             FROM SYS.M_CS_TABLES
             WHERE SCHEMA_NAME IN (\${SQL_LIST})
             GROUP BY SCHEMA_NAME ORDER BY SCHEMA_NAME;" 2>&1 | sed 's/^/           /'
        note "Das ist nicht die spaetere Exportgroesse, aber eine Groessenordnung."
    fi
    echo

else
    fail "Verbindungs- und Schemapruefung uebersprungen, da hdbsql fehlt."
fi

${RULE}
#  8. Exportverzeichnis
${RULE}

if [ -d "\${EXPORT_BASE}" ]; then
    ok "Exportverzeichnis vorhanden: \${EXPORT_BASE}"
    if [ -w "\${EXPORT_BASE}" ]; then
        ok "Exportverzeichnis ist beschreibbar."
    else
        fail "Exportverzeichnis ist nicht beschreibbar."
    fi
else
    fail "Exportverzeichnis fehlt. Zuerst 02_prepare_dirs.sh ausfuehren."
fi

${RULE}
#  9. Speicherplatz
${RULE}

if [ -d "\${EXPORT_BASE}" ]; then
    df -h "\${EXPORT_BASE}" | sed 's/^/           /'

    if [ "\${MIN_FREE_GB}" -gt 0 ]; then
        FREE_GB="$(df -BG --output=avail "\${EXPORT_BASE}" 2>/dev/null | tail -1 | tr -dc '0-9')"
        if [ -z "\${FREE_GB}" ]; then
            note "Freier Speicherplatz konnte nicht automatisch ermittelt werden."
        elif [ "\${FREE_GB}" -ge "\${MIN_FREE_GB}" ]; then
            ok "Freier Speicherplatz: \${FREE_GB} GB (Mindestwert \${MIN_FREE_GB} GB)."
        else
            fail "Nur \${FREE_GB} GB frei, gefordert sind \${MIN_FREE_GB} GB."
        fi
    else
        note "Keine Mindestgroesse konfiguriert (MIN_FREE_GB=0)."
    fi
fi

${RULE}
#  10. Reste der alten Ablage
#
#  Frueher lag unter der Basis je Schema ein Ordner. Die Aufbewahrung sieht
#  heute nur noch Tagesordner an; alte Schemaordner blieben sonst fuer immer
#  liegen und belegten Platz, ohne dass es jemandem auffiele.
${RULE}

OLD_LAYOUT=""

for SCHEMA in \${SCHEMAS[@]+"\${SCHEMAS[@]}"}
do
    [ -d "\${EXPORT_BASE}/\${SCHEMA}" ] && OLD_LAYOUT="\${OLD_LAYOUT} \${SCHEMA}"
done

if [ -n "\${OLD_LAYOUT}" ]; then
    note "Aus der alten Ablage liegen noch Schemaordner unter \${EXPORT_BASE}:"
    for SCHEMA in \${OLD_LAYOUT}
    do
        echo "           \${SCHEMA}  $(du -sh "\${EXPORT_BASE}/\${SCHEMA}" 2>/dev/null | awk '{print $1}')"
    done
    note "Die Aufbewahrung fasst sie nicht mehr an. Nach einer Sichtung:"
    note "  rm -rf \${EXPORT_BASE}/{$(echo "\${OLD_LAYOUT}" | tr ' ' ',' | sed 's/^,//')}"
else
    ok "Keine Reste einer frueheren Ablage gefunden."
fi
${
  box.enabled
    ? `
${RULE}
#  11. StorageBox
#
#  Diese Pruefung laeuft vor der Schluesseleinrichtung. Ein fehlender
#  Schluessel ist deshalb ein Hinweis und kein Fehler; erst ein vorhandener
#  Schluessel, mit dem die Anmeldung scheitert, ist einer.
${RULE}

if [ -r "${box.keyPath}" ]; then
    ok "SSH-Schluessel vorhanden: ${box.keyPath}"

    KEY_MODE="$(stat -c '%a' "${box.keyPath}" 2>/dev/null)"
    if [ "\${KEY_MODE}" = "600" ] || [ "\${KEY_MODE}" = "400" ]; then
        ok "Rechte des Schluessels: \${KEY_MODE}"
    else
        fail "Schluessel hat Rechte \${KEY_MODE}, ssh verlangt 600."
    fi

    note "Teste Anmeldung an ${box.host}:${box.port} ..."

    # Eine Storage Box bietet keine Shell, deshalb sftp statt ssh.
    if printf 'pwd\\nquit\\n' | sftp -P ${box.port} -i "${box.keyPath}" \\
         -o BatchMode=yes -o ConnectTimeout=20 \\
         "${box.user}@${box.host}" >/dev/null 2>&1; then
        ok "Anmeldung an der StorageBox erfolgreich."
    else
        fail "Anmeldung an der StorageBox fehlgeschlagen."
        note "Schluessel hinterlegt? Einrichten mit:"
        note "  ./06_offload_storagebox.sh --setup"
    fi
else
    # Kein Fehler: dieser Lauf kommt vor der Schluesseleinrichtung. Erst
    # wenn der Schluessel da ist, muss auch die Anmeldung klappen.
    note "SSH-Schluessel noch nicht angelegt: ${box.keyPath}"
    note "Das ist hier in Ordnung – er entsteht in einem spaeteren Schritt:"
    note "  ./06_offload_storagebox.sh --setup"
fi

for TOOL in rsync sftp
do
    if command -v "\${TOOL}" >/dev/null 2>&1; then
        ok "\${TOOL} verfuegbar."
    else
        fail "\${TOOL} fehlt, wird fuer die Auslagerung gebraucht."
    fi
done
`
    : ''
}
${RULE}
#  Ergebnis
${RULE}

echo
echo "Bestanden: \${CHECKS_OK}   Fehlgeschlagen: \${CHECKS_FAILED}"
echo

if [ \${CHECKS_FAILED} -ne 0 ]; then
    echo "Vorabpruefung NICHT bestanden. Bitte zuerst die Fehler beheben."
    exit 1
fi

echo "Vorabpruefung bestanden. Weiter mit 04_test_export.sh."${
  box.enabled
    ? `
echo
echo "Fuer die Auslagerung fehlt danach noch der Schluessel:"
echo "  ./06_offload_storagebox.sh --setup"
echo "  ./06_offload_storagebox.sh --check"`
    : ''
}
`;

  return {
    name: '03_preflight.sh',
    title: '3 · Vorabprüfung',
    purpose: 'Prüft Client, Verbindung, Schemas, Werkzeuge und Speicherplatz, ohne etwas zu verändern.',
    language: 'bash',
    executable: true,
    content,
  };
}
