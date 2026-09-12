import type { ExportConfig } from './types.js';
import { SID_PATTERN, normalizePath } from './sh.js';

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

/** Voreinstellung für den SSH-Schlüssel der Auslagerung. */
export function defaultKeyPath(sid: string, instance: string): string {
  return sid.trim().length === 0 ? '' : `${instanceDir(sid, instance)}/work/.ssh/id_ed25519`;
}

/** Alles, was sich aus SID und Instanznummer ableiten lässt. */
export interface DerivedDefaults {
  port: number;
  hdbsqlPath: string;
  exportBase: string;
  scriptPath: string;
  osUser: string;
  /** Gehört in der Konfiguration unter `offload`, leitet sich aber genauso ab. */
  keyPath: string;
}

/** SAP-Konvention für den Instanzbenutzer: `<sid>adm`. */
export function defaultOsUser(sid: string): string {
  return sid.trim().length === 0 ? '' : `${sid.trim().toLowerCase()}adm`;
}

/**
 * Alle Felder, die sich aus SID und Instanznummer ableiten lassen.
 *
 * Vorgeschlagen wird erst bei vollständiger SID. Sonst stünde während des
 * Tippens kurz `/usr/sap/N/HDB00/...` in den Pfadfeldern, was aussieht wie
 * ein fester Platzhalter statt wie ein Zwischenstand.
 */
export function derivedDefaults(sid: string, instance: string): DerivedDefaults {
  const trimmed = sid.trim();
  if (!SID_PATTERN.test(trimmed)) {
    return {
      port: defaultSqlPort(instance),
      hdbsqlPath: '',
      exportBase: '',
      scriptPath: '',
      osUser: '',
      keyPath: '',
    };
  }
  return {
    port: defaultSqlPort(instance),
    hdbsqlPath: defaultHdbsqlPath(trimmed, instance),
    exportBase: defaultExportBase(trimmed, instance),
    scriptPath: defaultScriptPath(trimmed, instance),
    osUser: defaultOsUser(trimmed),
    keyPath: defaultKeyPath(trimmed, instance),
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
    offload: {
      enabled: false,
      host: '',
      user: '',
      // Hetzner betreibt SSH auf einer Storage Box auf Port 23.
      port: 23,
      remotePath: '',
      keyPath: '',
      runAfterExport: true,
      // Zwei Stunden nach dem Export: bis dahin ist er in aller Regel durch.
      hour: 4,
      minute: 0,
      // Aufraeumen auf der Box loescht Daten, die lokal schon weg sein
      // koennen. Deshalb aus, bis es jemand bewusst einschaltet.
      remoteRetentionDays: 0,
    },
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
    offload: {
      ...config.offload,
      host: config.offload.host.trim(),
      user: config.offload.user.trim(),
      remotePath: normalizePath(config.offload.remotePath),
      keyPath: normalizePath(config.offload.keyPath),
    },
  };
}
