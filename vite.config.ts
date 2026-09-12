import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const OUTPUT_NAME = 'HANAScriptGenerator.html';

/** Platzhalter im HTML, den das eingebettete Logo ersetzt. */
const LOGO_TOKEN = '__BRAND_LOGO__';

/** In dieser Reihenfolge wird nach einer Logodatei gesucht. */
const LOGO_CANDIDATES = ['assets/logo.svg', 'assets/logo.png', 'assets/logo.webp', 'assets/logo.jpg'];

const LOGO_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Bettet ein Logo als data-URI ein, damit es Teil der einen HTML-Datei wird
 * und nie getrennt mitkopiert werden muss. Fehlt die Datei, verschwindet das
 * Bild-Element ersatzlos – die Oberflaeche funktioniert unveraendert.
 */
function brandLogo(): Plugin {
  return {
    name: 'hsg-brand-logo',
    transformIndexHtml(html) {
      const found = LOGO_CANDIDATES.map((rel) => resolve(rel)).find((path) => existsSync(path));

      if (found === undefined) {
        // Das ganze Element entfernen, sonst zeigt der Browser ein kaputtes Bild.
        return html.replace(/\s*<img[^>]*__BRAND_LOGO__[^>]*>/g, '');
      }

      const type = LOGO_TYPES[extname(found).toLowerCase()] ?? 'application/octet-stream';
      const data = readFileSync(found).toString('base64');
      return html.replace(LOGO_TOKEN, `data:${type};base64,${data}`);
    },
  };
}

/**
 * Bündelt CSS und JavaScript in die HTML-Datei und wirft die Einzelassets weg.
 *
 * Ergebnis ist eine einzige Datei, die sich per Doppelklick über `file://`
 * öffnen lässt – ohne Node, ohne Webserver, ohne Internetzugang. Genau das
 * wird beim Kunden gebraucht, wo kein npm installiert ist.
 */
function singleFile(): Plugin {
  return {
    name: 'hsg-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(
        (chunk) => chunk.type === 'asset' && chunk.fileName.endsWith('.html'),
      );
      if (html === undefined || html.type !== 'asset') return;

      let source = String(html.source);

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith('.css') && chunk.type === 'asset') {
          const css = String(chunk.source);
          source = source.replace(
            new RegExp(`\\s*<link[^>]+href="[^"]*${escapeRegExp(fileName)}"[^>]*>`),
            `\n    <style>\n${css}\n    </style>`,
          );
          delete bundle[fileName];
        }

        if (fileName.endsWith('.js') && chunk.type === 'chunk') {
          // Ein "</script>" im Code würde das umschließende Tag vorzeitig
          // beenden; die Schrägstrich-Maskierung ist in JS bedeutungslos.
          const code = chunk.code.replace(/<\/script>/g, '<\\/script>');

          // Vite legt das Modul-Tag in den <head>. Ein Modul wird verzögert
          // ausgeführt, ein eingebettetes klassisches Skript nicht – dort
          // stünde das Formular noch gar nicht. Deshalb ans Ende des Body.
          source = source
            .replace(
              new RegExp(`\\s*<script[^>]+src="[^"]*${escapeRegExp(fileName)}"[^>]*></script>`),
              '',
            )
            .replace('</body>', `  <script>\n${code}\n    </script>\n  </body>`);

          delete bundle[fileName];
        }
      }

      delete bundle[html.fileName];
      this.emitFile({ type: 'asset', fileName: OUTPUT_NAME, source });
    },

    closeBundle() {
      // Die fertige Datei liegt zusätzlich im Wurzelverzeichnis, damit sie
      // mitversioniert und ohne Build benutzbar ist. Gebaut wird trotzdem
      // nach dist/, sonst wäre outDir das Projektverzeichnis selbst.
      copyFileSync(resolve('dist', OUTPUT_NAME), resolve(OUTPUT_NAME));
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default defineConfig({
  base: './',
  plugins: [brandLogo(), singleFile()],
  server: {
    port: 5180,
  },
  build: {
    outDir: 'dist',
    target: 'es2019',
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    rollupOptions: {
      output: {
        // Klassisches Skript statt Modul: type="module" unterliegt über
        // file:// zusätzlichen Regeln, ein normales <script> nicht.
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'bundle.js',
        assetFileNames: 'bundle.[ext]',
      },
    },
  },
});
