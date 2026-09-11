import type { ExportConfig, GeneratedFile } from './types.js';
import { normalizeConfig } from './defaults.js';
import { generateSetupUserstore } from './files/setupUserstore.js';
import { generatePrepareDirs } from './files/prepareDirs.js';
import { generatePreflight } from './files/preflight.js';
import { generateTestExport } from './files/testExport.js';
import { generateExportScript } from './files/exportScript.js';
import { generateInstallCron } from './files/installCron.js';
import { generateRestore } from './files/restore.js';
import { generateReadme } from './files/readme.js';

/**
 * Erzeugt den vollständigen Satz Einzelskripte für einen Kunden, in der
 * Reihenfolge, in der sie auf dem Zielsystem ausgeführt werden.
 */
export function generateAll(rawConfig: ExportConfig): GeneratedFile[] {
  const config = normalizeConfig(rawConfig);
  return [
    generateReadme(config),
    generateSetupUserstore(config),
    generatePrepareDirs(config),
    generatePreflight(config),
    generateTestExport(config),
    generateExportScript(config),
    generateInstallCron(config),
    generateRestore(config),
  ];
}
