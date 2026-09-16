import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig } from './defaults.js';
import { generateAll } from './generate.js';
import type { ExportConfig } from './types.js';

/**
 * Führt das generierte Exportskript gegen Attrappen für hdbsql und curl aus
 * und prüft, was dabei an den Ping-Dienst geht – und vor allem, was nicht
 * ins Log gerät.
 */

/** Steht in der Ping-Adresse und darf in keiner erzeugten Datei auftauchen. */
const SECRET = 'GEHEIMESCHECKKENNUNG42';
const PING_URL = `https://hc-ping.example/${SECRET}`;

const fakeHdbsql = `#!/bin/bash
# Beantwortet Verbindungstest und Schemafrage und legt bei EXPORT Dateien an.
# FAKE_FAILING_SCHEMAS laesst den Export des genannten Schemas scheitern.
SQL="\${@: -1}"

case "\${SQL}" in
    *CURRENT_USER*)
        echo "SYSTEM"
        ;;
    *SYS.SCHEMAS*)
        echo 1
        ;;
    EXPORT*)
        TARGET="$(printf '%s' "\${SQL}" | sed -n "s/.*INTO '\\([^']*\\)'.*/\\1/p")"
        SCHEMA="$(printf '%s' "\${SQL}" | sed -n 's/EXPORT "\\([^"]*\\)".*/\\1/p')"

        case " \${FAKE_FAILING_SCHEMAS:-} " in
            *" \${SCHEMA} "*)
                # Eine Meldung mit Anfuehrungszeichen und Backslash, wie sie
                # aus einem echten Client kommen kann.
                echo "* 2048: cannot open \\"C:\\\\pfad\\\\x\\": said \\"no\\"" >&2
                exit 1
                ;;
        esac

        mkdir -p "\${TARGET}/index"
        printf 'export of %s\\n' "\${SCHEMA}" > "\${TARGET}/index/\${SCHEMA}.bin"
        echo "0 rows affected"
        ;;
    *)
        echo "unhandled: \${SQL}" >&2
        exit 1
        ;;
esac
`;

/**
 * Attrappe für curl. Sie liest die Adresse von der Standardeingabe, weil das
 * Skript sie über `--config -` reicht statt als Argument, und schreibt
 * Adresse und Inhalt mit, damit der Test beides prüfen kann.
 */
const fakeCurl = `#!/bin/bash
OUT="\${FAKE_CURL_OUT}"
BODY=""
CONFIG="$(cat)"

for ARG in "$@"
do
    case "\${ARG}" in
        @*) BODY="\${ARG#@}" ;;
    esac
done

{
    echo "=== AUFRUF"
    printf '%s\\n' "\${CONFIG}"
    if [ -n "\${BODY}" ] && [ -r "\${BODY}" ]; then
        echo "--- INHALT"
        cat "\${BODY}"
        echo "--- ENDE"
    fi
} >> "\${OUT}"

exit \${FAKE_CURL_RC:-0}
`;

let root: string;
let config: ExportConfig;
let pingLog: string;

function writeGenerated(): void {
  for (const file of generateAll(config)) {
    const path = join(root, file.name);
    writeFileSync(path, file.content, 'utf8');
    if (file.executable) chmodSync(path, 0o755);
  }
}

/** Ruft das Exportskript auf und liefert Ausgabe, Exitcode und Pings. */
function runExport(env: Record<string, string> = {}): {
  output: string;
  status: number;
  pings: string;
} {
  rmSync(pingLog, { force: true });

  let output = '';
  let status = 0;

  try {
    output = execFileSync('bash', [join(root, 'schema_export.sh')], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`,
        FAKE_CURL_OUT: pingLog,
        ...env,
      },
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    status = failure.status ?? -1;
  }

  return {
    output,
    status,
    pings: existsSync(pingLog) ? readFileSync(pingLog, 'utf8') : '',
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hsg-notify-'));
  mkdirSync(join(root, 'bin'));
  pingLog = join(root, 'pings.txt');

  const hdbsqlPath = join(root, 'bin', 'hdbsql');
  writeFileSync(hdbsqlPath, fakeHdbsql, 'utf8');
  chmodSync(hdbsqlPath, 0o755);

  const curlPath = join(root, 'bin', 'curl');
  writeFileSync(curlPath, fakeCurl, 'utf8');
  chmodSync(curlPath, 0o755);

  const base = defaultConfig();
  config = {
    ...base,
    customer: 'Notify Test',
    sid: 'NTF',
    host: 'localhost',
    osUser: userInfo().username,
    hdbsqlPath,
    exportBase: join(root, 'hana', 'exports'),
    scriptPath: join(root, 'hana', 'schema_export.sh'),
    schemas: ['ALPHA', 'BETA'],
    notify: {
      enabled: true,
      url: PING_URL,
      offloadUrl: '',
      proxy: '',
      maxDetailLines: 12,
    },
  };

  writeGenerated();
  execFileSync('bash', [join(root, '02_prepare_dirs.sh')], { stdio: 'pipe' });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  // Jeder Test beginnt mit einem leeren Tagesordner, damit sich die Läufe
  // nicht gegenseitig die Archive vorlegen.
  for (const entry of readdirSync(config.exportBase)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(entry)) {
      rmSync(join(config.exportBase, entry), { recursive: true, force: true });
    }
  }
});

describe('Meldung an den Ping-Dienst', () => {
  it('meldet Beginn und Erfolg des Laufs', () => {
    const { status, pings } = runExport();

    expect(status).toBe(0);
    expect(pings).toContain(`url = "${PING_URL}/start"`);
    expect(pings).toContain(`url = "${PING_URL}/0"`);
  });

  it('schickt die Übersicht über alle Schemas mit', () => {
    const { pings } = runExport();

    expect(pings).toContain('Kunde      : Notify Test');
    expect(pings).toContain('Tenant     : NTF (Instanz 00)');
    expect(pings).toContain('SCHEMA                 ZUSTAND');
    expect(pings).toMatch(/ALPHA\s+ok\s/);
    expect(pings).toMatch(/BETA\s+ok\s/);
  });

  it('meldet den Exitcode, wenn ein Schema scheitert', () => {
    const { status, pings } = runExport({ FAKE_FAILING_SCHEMAS: 'BETA' });

    expect(status).toBe(1);
    expect(pings).toContain(`url = "${PING_URL}/1"`);
    expect(pings).toMatch(/ALPHA\s+ok\s/);
    expect(pings).toMatch(/BETA\s+FEHLER\s/);

    // Der Auszug aus dem Log soll sagen, was los war.
    expect(pings).toContain('Aus dem Log:');
    expect(pings).toContain('FEHLER: Export von BETA fehlgeschlagen');
  });

  it('zeigt jedes Schema in der Übersicht, auch wenn alle scheitern', () => {
    const { pings } = runExport({ FAKE_FAILING_SCHEMAS: 'ALPHA BETA' });

    // Die Kürzung auf NOTIFY_MAX_LINES gilt nur für den Logauszug, nicht
    // für die Tabelle: welches Schema klemmte, muss vollständig dastehen.
    expect(pings).toMatch(/ALPHA\s+FEHLER\s/);
    expect(pings).toMatch(/BETA\s+FEHLER\s/);
  });

  it('meldet auch einen Abbruch vor dem ersten Schema', () => {
    // Ohne Schemaliste steigt das Skript früh aus. Ohne die Meldung wüsste
    // der Dienst nur, dass etwas begann und nie endete.
    const list = join(root, 'export_schemas.txt');
    const saved = readFileSync(list, 'utf8');
    writeFileSync(list, '# alle auskommentiert\n', 'utf8');

    try {
      const { status, pings } = runExport();
      expect(status).toBe(1);
      expect(pings).toContain(`url = "${PING_URL}/1"`);
    } finally {
      writeFileSync(list, saved, 'utf8');
    }
  });
});

describe('Die Ping-Adresse ist ein Geheimnis', () => {
  it('taucht in keiner Datei auf, die der Lauf schreibt', () => {
    runExport({ FAKE_FAILING_SCHEMAS: 'BETA' });

    const gefunden: string[] = [];

    const durchsuchen = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          durchsuchen(path);
        } else if (readFileSync(path, 'utf8').includes(SECRET)) {
          gefunden.push(path);
        }
      }
    };

    durchsuchen(config.exportBase);

    // Wer die Adresse liest, kann dem Dienst falschen Erfolg melden und ein
    // ausgefallenes Backup gesund aussehen lassen.
    expect(gefunden).toEqual([]);
  });

  it('steht auch nicht in der Ausgabe auf dem Bildschirm', () => {
    const { output } = runExport();
    expect(output).not.toContain(SECRET);
  });

  it('wird aus den Fehlertexten von curl herausgenommen', () => {
    // curl nennt in seinen Meldungen die vollständige Adresse. Die Attrappe
    // schreibt sie auf stderr, damit die Redaktion geprüft wird.
    const curlPath = join(root, 'bin', 'curl');
    const saved = readFileSync(curlPath, 'utf8');
    writeFileSync(
      curlPath,
      `#!/bin/bash\ncat >/dev/null\necho "curl: (6) Could not resolve host: ${PING_URL}/0" >&2\nexit 6\n`,
      'utf8',
    );
    chmodSync(curlPath, 0o755);

    try {
      const { status, output } = runExport();

      expect(status).toBe(0);
      expect(output).toContain('an die Ueberwachung fehlgeschlagen (curl 6)');
      expect(output).toContain('<Adresse entfernt>');
      expect(output).not.toContain(SECRET);
    } finally {
      writeFileSync(curlPath, saved, 'utf8');
      chmodSync(curlPath, 0o755);
    }
  });
});

describe('Die Meldung darf den Lauf nicht gefährden', () => {
  it('bleibt erfolgreich, wenn der Dienst nicht erreichbar ist', () => {
    const { status, output } = runExport({ FAKE_CURL_RC: '7' });

    expect(status).toBe(0);
    expect(output).toContain('Alle Schema-Exporte erfolgreich abgeschlossen');
    expect(output).toContain('Der Lauf selbst ist davon unberuehrt');
  });

  it('bleibt erfolgreich, wenn curl gar nicht vorhanden ist', () => {
    // Ein PATH mit allem, was das Skript sonst braucht – nur ohne curl.
    // Einfach den PATH zu leeren genügt nicht: dann fehlten auch tar und du,
    // und der Test prüfte nicht mehr, was er soll.
    const ohneCurl = join(root, 'ohne_curl');
    mkdirSync(ohneCurl, { recursive: true });

    for (const tool of [
      // bash muss mit hinein: node sucht auch den Interpreter im PATH.
      'bash', 'sh',
      'date', 'tee', 'hostname', 'whoami', 'mkdir', 'rm', 'mv', 'tar', 'du',
      'awk', 'sed', 'grep', 'tail', 'basename', 'dirname', 'flock', 'df',
      'tr', 'find', 'ls', 'stat', 'cat', 'sort', 'gzip', 'touch', 'wc', 'head', 'cut',
    ]) {
      try {
        const real = execFileSync('command', ['-v', tool], {
          shell: true,
          encoding: 'utf8',
        }).trim();
        if (real.length > 0) symlinkSync(real, join(ohneCurl, tool));
      } catch {
        // Fehlt das Werkzeug auf diesem Rechner, fehlt es eben auch im Test.
      }
    }

    let status = 0;
    let output = '';

    try {
      output = execFileSync('bash', [join(root, 'schema_export.sh')], {
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, PATH: ohneCurl, FAKE_CURL_OUT: pingLog },
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
      status = failure.status ?? -1;
    }

    expect(output).toContain('curl fehlt');
    expect(output).toContain('Alle Schema-Exporte erfolgreich abgeschlossen');
    expect(status).toBe(0);
  });
});
