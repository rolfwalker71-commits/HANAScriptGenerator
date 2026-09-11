import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig } from './defaults.js';
import { generateAll } from './generate.js';
import type { ExportConfig } from './types.js';

/**
 * Führt das generierte Skript wirklich aus – gegen ein hdbsql-Attrappe, das
 * statt eines Exports ein paar Dateien anlegt. Damit sind Schleife, tar-Lauf,
 * Archivprüfung, Aufräumen und Exitcode gemeinsam abgedeckt.
 */

const fakeHdbsql = `#!/bin/bash
# Attrappe: beantwortet den Verbindungstest und legt bei EXPORT Dateien an.
SQL="\${3:-}"

case "\${SQL}" in
    *CURRENT_USER*)
        echo "SYSTEM"
        ;;
    EXPORT*)
        TARGET="$(printf '%s' "\${SQL}" | sed -n "s/.*INTO '\\([^']*\\)'.*/\\1/p")"
        SCHEMA="$(printf '%s' "\${SQL}" | sed -n 's/EXPORT "\\([^"]*\\)".*/\\1/p')"
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

let root: string;
let config: ExportConfig;

function writeGenerated(): void {
  for (const file of generateAll(config)) {
    const path = join(root, file.name);
    writeFileSync(path, file.content, 'utf8');
    if (file.executable) chmodSync(path, 0o755);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hsg-smoke-'));
  mkdirSync(join(root, 'bin'));

  const hdbsqlPath = join(root, 'bin', 'hdbsql');
  writeFileSync(hdbsqlPath, fakeHdbsql, 'utf8');
  chmodSync(hdbsqlPath, 0o755);

  config = {
    ...defaultConfig(),
    customer: 'Smoke Test',
    sid: 'SMK',
    host: 'localhost',
    osUser: userInfo().username,
    hdbsqlPath,
    exportBase: join(root, 'hana', 'exports'),
    scriptPath: join(root, 'hana', 'schema_export.sh'),
    schemas: ['ALPHA', 'BETA'],
    retentionDays: 14,
  };

  writeGenerated();
  execFileSync('bash', [join(root, '02_prepare_dirs.sh')], { stdio: 'pipe' });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('generiertes Exportskript im Trockenlauf', () => {
  it('exportiert und archiviert jedes Schema getrennt', () => {
    const output = execFileSync('bash', [join(root, 'schema_export.sh')], {
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(output).toContain('Alle Schema-Exporte erfolgreich abgeschlossen');

    const today = new Date().toISOString().slice(0, 10);

    for (const schema of config.schemas) {
      const dir = join(config.exportBase, schema);
      const archive = join(dir, `${schema}_${today}.tar.gz`);

      // Pro Schema genau ein eigenes Archiv.
      expect(existsSync(archive), archive).toBe(true);

      // Der Rohexport ist nach der Archivierung verschwunden.
      expect(existsSync(join(dir, today))).toBe(false);

      // Es bleibt kein halb geschriebenes .tmp zurück.
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);

      // Und das Archiv enthält den Export des jeweiligen Schemas.
      const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
      expect(listing).toContain(`${today}/index/${schema}.bin`);
    }

    // Kein gemeinsames Archiv über alle Schemas (.lock ausgenommen).
    const entries = readdirSync(config.exportBase).filter((name) => !name.startsWith('.'));
    expect(entries.sort()).toEqual(['ALPHA', 'BETA', 'logs']);
  });

  it('lässt sich am selben Tag erneut ausführen', () => {
    const output = execFileSync('bash', [join(root, 'schema_export.sh')], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(output).toContain('Alle Schema-Exporte erfolgreich abgeschlossen');

    const today = new Date().toISOString().slice(0, 10);
    const archives = readdirSync(join(config.exportBase, 'ALPHA'));
    expect(archives).toEqual([`ALPHA_${today}.tar.gz`]);
  });

  it('meldet einen Fehler, wenn hdbsql fehlt', () => {
    const broken = { ...config, hdbsqlPath: join(root, 'bin', 'gibtsnicht') };
    const path = join(root, 'broken_export.sh');
    const script = generateAll(broken).find((file) => file.name.endsWith('schema_export.sh'));
    writeFileSync(path, script?.content ?? '', 'utf8');
    chmodSync(path, 0o755);

    try {
      execFileSync('bash', [path], { stdio: 'pipe', encoding: 'utf8' });
      throw new Error('Das Skript hätte fehlschlagen müssen.');
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      expect(failure.status).toBe(1);
      expect(failure.stdout).toContain('hdbsql nicht gefunden');
    }
  });
});
