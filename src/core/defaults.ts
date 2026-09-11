import type { ExportConfig } from './types.js';
import { normalizePath } from './sh.js';

/** SAP-Konvention für den SQL-Port einer Single-Tenant-Instanz: 3<nn>15. */
export function defaultSqlPort(instance: string): number {
  const nn = instance.padStart(2, '0').slice(0, 2);
  return Number.parseInt(`3${nn}15`, 10);
}

/** `/usr/sap/<SID>/HDB<NN>` – das Instanzverzeichnis. */
export function instanceDir(sid: string, instance: string): string {
  return `/usr/sap/${sid.toUpperCase()}/HDB${instance.padStart(2, '0')}`;
}

export function defaultHdbsqlPath(sid: string, instance: string): string {
  return `${instanceDir(sid, instance)}/exe/hdbsql`;
}

export function defaultExportBase(sid: string, instance: string): string {
  return `${instanceDir(sid, instance)}/work/schema_exports`;
}

export function defaultScriptPath(sid: string, instance: string): string {
  return `${instanceDir(sid, instance)}/work/schema_export.sh`;
}

/** SAP-Konvention für den Instanzbenutzer: `<sid>adm`. */
export function defaultOsUser(sid: string): string {
  return sid.trim().length === 0 ? '' : `${sid.trim().toLowerCase()}adm`;
}

/**
 * Alle Felder, die sich aus SID und Instanznummer ableiten lassen. Ohne SID
 * bleiben die Pfade leer, damit nichts wie `/usr/sap//HDB00` entsteht.
 */
export function derivedDefaults(
  sid: string,
  instance: string,
): Pick<ExportConfig, 'port' | 'hdbsqlPath' | 'exportBase' | 'scriptPath' | 'osUser'> {
  const trimmed = sid.trim();
  if (trimmed.length === 0) {
    return {
      port: defaultSqlPort(instance),
      hdbsqlPath: '',
      exportBase: '',
      scriptPath: '',
      osUser: '',
    };
  }
  return {
    port: defaultSqlPort(instance),
    hdbsqlPath: defaultHdbsqlPath(trimmed, instance),
    exportBase: defaultExportBase(trimmed, instance),
    scriptPath: defaultScriptPath(trimmed, instance),
    osUser: defaultOsUser(trimmed),
  };
}

/**
 * Startwerte des Wizards. Vorbelegt ist nur, was bei jeder SAP-Installation
 * gleich ist – alles Kundenspezifische bleibt leer und wird abgefragt.
 */
export function defaultConfig(): ExportConfig {
  return {
    customer: '',
    sid: '',
    instance: '00',
    host: '',
    port: defaultSqlPort('00'),
    dbUser: 'SYSTEM',
    osUser: '',
    userstoreKey: 'SCHEMAEXPORT',
    hdbsqlPath: '',
    exportBase: '',
    scriptPath: '',
    schemas: [],
    threads: 10,
    retentionDays: 14,
    compression: 'gz',
    keepRawExport: false,
    minFreeGb: 0,
    schedule: { hour: 2, minute: 0, dayOfWeek: '*' },
    mail: { enabled: false, recipient: '', onlyOnError: true, command: 'mailx' },
  };
}

/** Kopiert die Konfiguration und normalisiert alle Pfade und Bezeichner. */
export function normalizeConfig(config: ExportConfig): ExportConfig {
  return {
    ...config,
    customer: config.customer.trim(),
    sid: config.sid.trim().toUpperCase(),
    instance: config.instance.trim().padStart(2, '0'),
    host: config.host.trim(),
    dbUser: config.dbUser.trim(),
    osUser: config.osUser.trim(),
    userstoreKey: config.userstoreKey.trim(),
    hdbsqlPath: normalizePath(config.hdbsqlPath),
    scriptPath: normalizePath(config.scriptPath),
    exportBase: normalizePath(config.exportBase),
    schemas: config.schemas.map((s) => s.trim()).filter((s) => s.length > 0),
    mail: { ...config.mail, recipient: config.mail.recipient.trim() },
    schedule: { ...config.schedule },
  };
}
