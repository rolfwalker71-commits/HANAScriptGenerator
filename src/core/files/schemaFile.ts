import type { ExportConfig, GeneratedFile } from '../types.js';
import { shCommentSafe } from '../sh.js';
import {
  GENERATOR_NAME,
  GENERATOR_VERSION,
  HEAVY_RULE,
  SCHEMA_FILE_NAME,
  dirName,
} from './common.js';

/**
 * Die Liste der zu sichernden Schemas als eigene Datei. Export, Vorabprüfung
 * und Testexport lesen sie bei jedem Lauf; eine Änderung darin braucht weder
 * neu erzeugte Skripte noch eine neue Crontab.
 */
export function generateSchemaFile(config: ExportConfig): GeneratedFile {
  const path = `${dirName(config.scriptPath)}/${SCHEMA_FILE_NAME}`;

  const content = [
    HEAVY_RULE,
    '#  Zu sichernde Schemas',
    '#',
    `#  Kunde  : ${shCommentSafe(config.customer) || '-'}`,
    `#  Tenant : ${config.sid} (Instanz ${config.instance})`,
    `#  Datei  : ${path}`,
    '#',
    '#  Ein Schema pro Zeile, geschrieben wie in der Datenbank (meist gross).',
    '#  Leerzeilen und Zeilen mit # am Anfang werden uebergangen. Ein Kommentar',
    '#  hinter dem Namen braucht ein Leerzeichen davor:',
    '#      SALES   # Vertrieb',
    '#',
    '#  Aenderungen gelten ab dem naechsten Lauf; Skripte und Crontab bleiben',
    '#  unveraendert. Danach pruefen mit:  ./03_preflight.sh',
    '#',
    '#  Ein Schema, das es in der Datenbank nicht mehr gibt, bricht den Export',
    '#  nicht ab. Es wird uebersprungen und im Log als HINWEIS vermerkt.',
    '#',
    `#  Erzeugt durch ${GENERATOR_NAME}, Stand ${GENERATOR_VERSION}.`,
    HEAVY_RULE,
    '',
    ...config.schemas,
    '',
  ].join('\n');

  return {
    name: SCHEMA_FILE_NAME,
    title: 'Schemas',
    purpose:
      'Die Liste der zu sichernden Schemas. Die Skripte lesen sie bei jedem Lauf – auf dem Server hier ergänzen oder entfernen.',
    language: 'text',
    executable: false,
    content,
  };
}
