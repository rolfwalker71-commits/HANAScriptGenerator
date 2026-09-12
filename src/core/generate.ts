import type { ExportConfig, GeneratedFile } from './types.js';
import { normalizeConfig } from './defaults.js';
import { generateSchemaLister } from './files/listSchemas.js';
import { generateDeployScript } from './files/deploy.js';
import { generateSetupUserstore } from './files/setupUserstore.js';
import { generatePrepareDirs } from './files/prepareDirs.js';
import { generatePreflight } from './files/preflight.js';
import { generateTestExport } from './files/testExport.js';
import { generateExportScript } from './files/exportScript.js';
import { generateInstallCron } from './files/installCron.js';
import { generateOffloadScript } from './files/offload.js';
import { generateRestore } from './files/restore.js';
import { generateReadme } from './files/readme.js';

/**
 * Erzeugt den vollständigen Satz Einzeldateien für einen Kunden, in der
 * Reihenfolge, in der sie benutzt werden: erst die beiden Windows-Helfer,
 * dann die Skripte auf dem Server.
 */
export function generateAll(rawConfig: ExportConfig): GeneratedFile[] {
  const config = normalizeConfig(rawConfig);

  const files = [
    generateReadme(config),
    generateSetupUserstore(config),
    generatePrepareDirs(config),
    generatePreflight(config),
    generateTestExport(config),
    generateExportScript(config),
    generateInstallCron(config),
    ...(config.offload.enabled ? [generateOffloadScript(config)] : []),
    generateRestore(config),
  ];

  // Das Übertragungsskript kennt die Namen der Dateien, die es kopiert,
  // deshalb entsteht es zuletzt.
  return [
    files[0] as GeneratedFile,
    generateSchemaLister(config),
    generateDeployScript(config, files),
    ...files.slice(1),
  ];
}
