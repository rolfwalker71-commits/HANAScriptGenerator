# Logo

Eine Datei hier ablegen, dann wird sie beim Build fest in
`HANAScriptGenerator.html` eingebettet und muss nie mitkopiert werden:

| Datei | Vorrang |
| --- | --- |
| `assets/logo.svg` | 1. – am schärfsten, weil vektorbasiert |
| `assets/logo.png` | 2. |
| `assets/logo.webp` | 3. |
| `assets/logo.jpg` | 4. |

Danach `npm run build`. Fehlt die Datei, verschwindet das Bild-Element
ersatzlos und die Oberfläche funktioniert unverändert.

Die Datei landet als data-URI in der HTML-Datei und zählt damit voll zur
Dateigröße – für die Kopfzeile genügen rund 200 Pixel Breite.
