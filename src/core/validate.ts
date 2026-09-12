import type { ExportConfig, ValidationIssue } from './types.js';
import { defaultOsUser } from './defaults.js';
import { OS_USER_PATTERN, SCHEMA_NAME_PATTERN, SID_PATTERN } from './sh.js';

const CRON_DOW_PATTERN = /^(\*|([0-7](-[0-7])?)(,[0-7](-[0-7])?)*)(\/\d+)?$/;

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\n');
}

/**
 * Prüft die Konfiguration, bevor daraus ein Skript entsteht. Fehler blockieren
 * die Generierung, Warnungen weisen nur auf ungewöhnliche Werte hin.
 */
export function validateConfig(config: ExportConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (field: ValidationIssue['field'], message: string) =>
    issues.push({ field, severity: 'error', message });
  const warn = (field: ValidationIssue['field'], message: string) =>
    issues.push({ field, severity: 'warning', message });

  if (config.customer.length === 0) {
    warn('customer', 'Ohne Kundenname fehlt die Zuordnung im Skriptkopf.');
  }

  if (!SID_PATTERN.test(config.sid)) {
    error('sid', 'Die SID muss dreistellig sein und mit einem Buchstaben beginnen, z. B. HDB.');
  }

  if (!/^\d{2}$/.test(config.instance)) {
    error('instance', 'Die Instanznummer muss zweistellig sein, z. B. 00.');
  }

  if (config.host.length === 0) {
    error('host', 'Der Hostname darf nicht leer sein.');
  } else if (!/^[A-Za-z0-9._-]+$/.test(config.host)) {
    error('host', 'Der Hostname enthält unzulässige Zeichen.');
  }

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    error('port', 'Der SQL-Port muss zwischen 1 und 65535 liegen.');
  }

  if (config.dbUser.length === 0) {
    error('dbUser', 'Der Datenbankbenutzer darf nicht leer sein.');
  }

  if (!OS_USER_PATTERN.test(config.osUser)) {
    error('osUser', 'Der Linux-Benutzer enthält unzulässige Zeichen.');
  } else if (SID_PATTERN.test(config.sid) && config.osUser !== defaultOsUser(config.sid)) {
    // Der Instanzbenutzer heißt bei SAP immer <sid>adm. Eine Abweichung kann
    // gewollt sein, ist aber meistens ein Tippfehler – deshalb nur ein Hinweis.
    warn(
      'osUser',
      `Üblich wäre ${defaultOsUser(config.sid)}: der SAP-Instanzbenutzer heißt <sid>adm. ` +
        `Weicht ${config.osUser} bewusst ab, kann der Hinweis stehen bleiben.`,
    );
  }

  if (!/^[A-Za-z0-9_]+$/.test(config.userstoreKey)) {
    error('userstoreKey', 'Der hdbuserstore-Key darf nur Buchstaben, Ziffern und _ enthalten.');
  }

  for (const field of ['hdbsqlPath', 'exportBase', 'scriptPath'] as const) {
    if (!isAbsolutePath(config[field])) {
      error(field, 'Es wird ein absoluter Pfad benötigt, beginnend mit /.');
    }
  }

  if (config.exportBase === '/' || config.exportBase.split('/').length < 3) {
    error('exportBase', 'Der Exportpfad ist zu nah an der Wurzel – das Aufräumen wäre gefährlich.');
  }

  if (config.schemas.length === 0) {
    error('schemas', 'Mindestens ein Schema muss angegeben werden.');
  }
  for (const schema of config.schemas) {
    if (!SCHEMA_NAME_PATTERN.test(schema)) {
      error('schemas', `Schemaname "${schema}" enthält unzulässige Zeichen.`);
    } else if (schema !== schema.toUpperCase()) {
      warn(
        'schemas',
        `Schemaname "${schema}" ist nicht durchgängig groß geschrieben – HANA unterscheidet bei Quoting die Schreibweise.`,
      );
    }
  }

  if (!Number.isInteger(config.threads) || config.threads < 1 || config.threads > 64) {
    error('threads', 'THREADS muss zwischen 1 und 64 liegen.');
  } else if (config.threads > 16) {
    warn('threads', 'Mehr als 16 Threads belasten das Produktivsystem während des Exports spürbar.');
  }

  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1) {
    error('retentionDays', 'Die Aufbewahrung muss mindestens 1 Tag betragen.');
  }

  if (!Number.isInteger(config.minFreeGb) || config.minFreeGb < 0) {
    error('minFreeGb', 'Der Mindest-Speicherplatz darf nicht negativ sein.');
  }

  const { hour, minute, dayOfWeek } = config.schedule;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    error('schedule', 'Die Stunde muss zwischen 0 und 23 liegen.');
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    error('schedule', 'Die Minute muss zwischen 0 und 59 liegen.');
  }
  if (!CRON_DOW_PATTERN.test(dayOfWeek)) {
    error('schedule', 'Das Wochentagsfeld entspricht nicht der Crontab-Syntax.');
  }

  if (config.mail.enabled) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.mail.recipient)) {
      error('mail', 'Für den Mailversand wird eine gültige Empfängeradresse benötigt.');
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(config.mail.command)) {
      error('mail', 'Das Mail-Kommando enthält unzulässige Zeichen.');
    }
  }

  if (config.offload.enabled) {
    const box = config.offload;

    if (box.host.length === 0) {
      error('offload', 'Ohne Adresse der StorageBox kann nicht ausgelagert werden.');
    } else if (!/^[A-Za-z0-9._-]+$/.test(box.host)) {
      error('offload', 'Die Adresse der StorageBox enthält unzulässige Zeichen.');
    }

    if (!/^[A-Za-z0-9._-]+$/.test(box.user)) {
      error('offload', 'Der Benutzer der StorageBox fehlt oder enthält unzulässige Zeichen.');
    }

    // u123456 ist der Beispielwert aus der Anleitung. Dummerweise existiert
    // diese Adresse wirklich, ein Tippversuch landet also bei einem fremden
    // Konto – deshalb blockiert das hier und warnt nicht nur.
    if (/^u(123456|XXXXXX)\b/i.test(box.user) || /^u(123456|XXXXXX)\./i.test(box.host)) {
      error(
        'offload',
        'Das sind die Beispielwerte aus der Anleitung, nicht deine Zugangsdaten. ' +
          'Benutzer und Adresse stehen im Hetzner Robot bei der Storage Box.',
      );
    }

    if (!Number.isInteger(box.port) || box.port < 1 || box.port > 65535) {
      error('offload', 'Der SSH-Port der StorageBox muss zwischen 1 und 65535 liegen.');
    } else if (box.port === 22) {
      warn(
        'offload',
        'Hetzner betreibt SSH auf einer Storage Box üblicherweise auf Port 23, nicht 22.',
      );
    }

    if (!box.remotePath.startsWith('/')) {
      error('offload', 'Das Zielverzeichnis auf der Box muss mit / beginnen, z. B. /home/hana.');
    } else if (box.remotePath === '/' || box.remotePath === '/home') {
      error(
        'offload',
        'Ein eigenes Unterverzeichnis wählen – das Aufräumen im Heimatverzeichnis wäre gefährlich.',
      );
    }

    if (!box.keyPath.startsWith('/')) {
      error('offload', 'Für den SSH-Schlüssel wird ein absoluter Pfad benötigt.');
    }

    if (!Number.isInteger(box.hour) || box.hour < 0 || box.hour > 23) {
      error('offload', 'Die Stunde der Auslagerung muss zwischen 0 und 23 liegen.');
    }
    if (!Number.isInteger(box.minute) || box.minute < 0 || box.minute > 59) {
      error('offload', 'Die Minute der Auslagerung muss zwischen 0 und 59 liegen.');
    }

    if (!Number.isInteger(box.remoteRetentionDays) || box.remoteRetentionDays < 0) {
      error('offload', 'Die Aufbewahrung auf der Box darf nicht negativ sein.');
    } else if (box.remoteRetentionDays > 0 && box.remoteRetentionDays <= config.retentionDays) {
      warn(
        'offload',
        `Auf der Box wird nach ${box.remoteRetentionDays} Tagen gelöscht, lokal erst nach ` +
          `${config.retentionDays}. Dann ist die Auslagerung nie älter als der lokale Bestand ` +
          'und bringt keinen zusätzlichen Zeitraum.',
      );
    }
  }

  if (config.keepRawExport) {
    warn(
      'keepRawExport',
      'Rohexport und Archiv werden parallel aufbewahrt – der Platzbedarf steigt entsprechend.',
    );
  }

  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
