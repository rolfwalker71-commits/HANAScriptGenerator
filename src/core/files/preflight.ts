import type { ExportConfig, GeneratedFile } from '../types.js';
import { RULE, schemaArray, schemaSqlList, scriptHeader, userGuard } from './common.js';

/**
 * Prüft alles, was der spätere Cronlauf voraussetzt: Client, Verbindung,
 * Schemas, Verzeichnis, Werkzeuge und Speicherplatz. Verändert nichts.
 */
export function generatePreflight(config: ExportConfig): GeneratedFile {
  const needsZstd = config.compression === 'zst';

  const content = `${scriptHeader(config, 'Schritt 3 – Vorabpruefung', [
    'Prueft alle Voraussetzungen des spaeteren Exports.',
    'Dieses Skript veraendert nichts und kann jederzeit wiederholt werden.',
  ])}

set -u

HANA_KEY="${config.userstoreKey}"
HDBSQL="${config.hdbsqlPath}"
EXPORT_BASE="${config.exportBase}"
MIN_FREE_GB=${config.minFreeGb}

${schemaArray(config)}

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

if hdbuserstore list "\${HANA_KEY}" >/dev/null 2>&1; then
    ok "hdbuserstore-Key \${HANA_KEY} vorhanden."
    hdbuserstore list "\${HANA_KEY}" | sed 's/^/           /'
else
    fail "hdbuserstore-Key \${HANA_KEY} fehlt. Zuerst 01_setup_userstore.sh ausfuehren."
fi

${RULE}
#  5. Verbindung und Zieldatenbank
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
#  6. Schemas
${RULE}

    note "Erwartet werden: \${SCHEMAS[*]}"

    for SCHEMA in "\${SCHEMAS[@]}"
    do
        COUNT="$("\${HDBSQL}" -U "\${HANA_KEY}" -a -x \\
            "SELECT COUNT(*) FROM SYS.SCHEMAS WHERE SCHEMA_NAME = '\${SCHEMA}';" 2>/dev/null | tr -dc '0-9')"

        if [ "\${COUNT:-0}" -ge 1 ]; then
            ok "Schema \${SCHEMA} existiert."
        else
            fail "Schema \${SCHEMA} wurde nicht gefunden – Schreibweise pruefen."
        fi
    done

    echo
    note "Ungefaehre Groesse der Schemas im Hauptspeicher:"
    "\${HDBSQL}" -U "\${HANA_KEY}" \\
        "SELECT SCHEMA_NAME, ROUND(SUM(MEMORY_SIZE_IN_TOTAL)/1024/1024/1024,2) AS MEMORY_GB
         FROM SYS.M_CS_TABLES
         WHERE SCHEMA_NAME IN (${schemaSqlList(config)})
         GROUP BY SCHEMA_NAME ORDER BY SCHEMA_NAME;" 2>&1 | sed 's/^/           /'
    note "Das ist nicht die spaetere Exportgroesse, aber eine Groessenordnung."
    echo

else
    fail "Verbindungs- und Schemapruefung uebersprungen, da hdbsql fehlt."
fi

${RULE}
#  7. Exportverzeichnis
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
#  8. Speicherplatz
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
#  Ergebnis
${RULE}

echo
echo "Bestanden: \${CHECKS_OK}   Fehlgeschlagen: \${CHECKS_FAILED}"
echo

if [ \${CHECKS_FAILED} -ne 0 ]; then
    echo "Vorabpruefung NICHT bestanden. Bitte zuerst die Fehler beheben."
    exit 1
fi

echo "Vorabpruefung bestanden. Weiter mit 04_test_export.sh."
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
