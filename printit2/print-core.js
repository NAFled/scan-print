/*
 * print-core.js — Gemeinsamer Print-Core fuer "Print-It" (dunkel) und "Zebra Print it" (hell).
 *
 * Single Source of Truth fuer die gesamte druck-relevante Logik:
 *   - Geometrie/Einheiten (mm <-> Dots), Kopien-Begrenzung, HTML-Escape
 *   - Schriftgroessen-Auto-Fit (Breite UND Hoehe beruecksichtigt)
 *   - Canvas-Rendering (Freitext, QR/Code128, 2-Namen-Schild)
 *   - Canvas -> 1-Bit -> ZPL ^GFA (fuer Bitmap-Druck auf ZPL-Druckern)
 *   - Native ZPL-Erzeugung (scharfe Zebra-Fonts/Barcodes: Text, QR, Code128, 2-Namen)
 *   - Listen-Parsing (Text/CSV, PDF-Textlayer, Duplikat-Nummerierung, natuerliche Sortierung)
 *   - Transport-Sender (Browser Print, HTTP, CUPS) als zustandslose fetch-Helfer
 *
 * Wird als klassisches Script eingebunden (kein ES-Modul), damit es auch ueber file://
 * ohne CORS-Probleme laeuft. Exportiert alles unter window.PrintCore.
 *
 * Die beiden Apps drucken unterschiedlich:
 *   - Zebra Print it: bevorzugt NATIVE ZPL (^A0N, ^BQN, ^BCN) fuer scharfe Ausgabe,
 *     Transport ausschliesslich ueber Zebra Browser Print (localhost-Agent).
 *   - Print-It: rendert auf Canvas und druckt als Niimbot-Bitmap ODER ZPL ^GFA,
 *     Transport ueber HTTP / CUPS / Bluetooth / Niimbot-BLE.
 */
(function (global) {
  'use strict';

  // Dots pro mm bei den ueblichen Thermodrucker-Aufloesungen (203/300 dpi).
  const DPI203 = 8;        // 203 dpi ~ 8 Dots/mm
  const DPI300 = 11.81;    // 300 dpi ~ 11.81 Dots/mm

  // ─────────────────────────────────────────────────────────────
  // Geometrie & kleine Helfer
  // ─────────────────────────────────────────────────────────────

  // Millimeter in Drucker-Dots umrechnen (auf ganze Dots gerundet).
  function mmToDots(mm, dpi) {
    return Math.round(mm * (dpi / 25.4));
  }

  // Kopienzahl robust auf den erlaubten Bereich 1..999 begrenzen.
  function clampCopies(n) {
    n = parseInt(n, 10) || 1;
    return Math.max(1, Math.min(999, n));
  }

  // Zahl auf d Nachkommastellen runden.
  function round(n, d) {
    const f = Math.pow(10, d);
    return Math.round(n * f) / f;
  }

  // HTML-Sonderzeichen escapen (fuer sichere Anzeige in Vorschau-Listen).
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ^ und ~ sind ZPL-Steuerzeichen. Fuer nativen ZPL-Text entfernen wir sie,
  // damit der Drucker den Text nicht als Kommando missversteht.
  function stripZplControl(s) {
    return String(s == null ? '' : s).replace(/\^/g, '').replace(/~/g, '');
  }

  // ─────────────────────────────────────────────────────────────
  // Schriftgroessen-Auto-Fit
  // Beruecksichtigt sowohl Zeichenanzahl (Breite) als auch Zeilenanzahl (Hoehe),
  // damit lange/mehrzeilige Texte automatisch kleiner werden. Rueckgabe in
  // derselben Einheit wie areaWidth/areaHeight (px oder ZPL-Dots).
  // ─────────────────────────────────────────────────────────────
  function calcFitFontSize(text, areaWidth, areaHeight, maxFont, minFont) {
    const lines = String(text || '–').split('\n');
    const lineCount = Math.max(1, lines.length);
    const maxLen = Math.max(1, ...lines.map((l) => l.length));
    const charWidthFactor = 0.6;   // ungefaehre Zeichenbreite relativ zur Hoehe (fett/kondensiert)
    const lineSpacingFactor = 1.25; // Zeilenabstand inkl. Puffer

    const fontByWidth = areaWidth / (maxLen * charWidthFactor);
    const fontByHeight = areaHeight / (lineCount * lineSpacingFactor);

    const font = Math.min(fontByWidth, fontByHeight, maxFont);
    return Math.max(minFont, Math.round(font));
  }

  // ─────────────────────────────────────────────────────────────
  // Canvas -> 1-Bit-Bitmap -> ZPL ^GFA
  // ─────────────────────────────────────────────────────────────

  // Canvas in eine 1-Bit-Bitmap wandeln (Schwellwert 128 auf Graustufe).
  // Rueckgabe: gepackte Bytes (bpl = Bytes pro Zeile), plus Breite/Hoehe.
  function to1Bit(cv) {
    const x = cv.getContext('2d');
    const d = x.getImageData(0, 0, cv.width, cv.height).data;
    const w = cv.width, h = cv.height;
    const bpl = Math.ceil(w / 8);
    const r = new Uint8Array(bpl * h);
    for (let y = 0; y < h; y++) {
      for (let x2 = 0; x2 < w; x2++) {
        const i = (y * w + x2) * 4;
        const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        if (g < 128) r[y * bpl + Math.floor(x2 / 8)] |= (1 << (7 - (x2 % 8)));
      }
    }
    return { data: r, w, h, bpl };
  }

  // 1-Bit-Bitmap als ZPL ^GFA-Kommando (Hex) erzeugen.
  function canvasToZplGfa(cv) {
    const { data, bpl } = to1Bit(cv);
    const total = data.length;
    let hex = '';
    for (let i = 0; i < total; i++) hex += data[i].toString(16).padStart(2, '0').toUpperCase();
    return { gfa: `^GFA,${total},${total},${bpl},${hex}`, total, bpl };
  }

  // ─────────────────────────────────────────────────────────────
  // Canvas-Text-Rendering (Auto-Fit + optionaler Umbruch)
  // ─────────────────────────────────────────────────────────────

  // Text in Zeilen aufteilen. Bei doWrap=true werden zu lange Zeilen an
  // Wortgrenzen (notfalls Zeichen) umgebrochen, damit sie in maxW passen.
  function wrapText(ctx, text, maxW, doWrap) {
    const out = [];
    const manual = String(text).split('\n');
    for (const line of manual) {
      if (line === '') { out.push(''); continue; }
      if (!doWrap || ctx.measureText(line).width <= maxW) { out.push(line); continue; }
      const words = line.split(' ');
      let cur = '';
      for (const w of words) {
        const test = cur ? cur + ' ' + w : w;
        if (ctx.measureText(test).width <= maxW) {
          cur = test;
        } else {
          if (cur) out.push(cur);
          if (ctx.measureText(w).width > maxW) {
            // Einzelnes Wort ist breiter als das Label -> zeichenweise umbrechen.
            let chunk = '';
            for (const ch of w) {
              const t2 = chunk + ch;
              if (ctx.measureText(t2).width <= maxW) chunk = t2;
              else { if (chunk) out.push(chunk); chunk = ch; }
            }
            cur = chunk;
          } else {
            cur = w;
          }
        }
      }
      if (cur) out.push(cur);
    }
    return out;
  }

  // Freitext auf ein Canvas rendern: sucht die groesste Schrift, bei der der
  // (ggf. umgebrochene) Text noch komplett passt, und zentriert vertikal.
  // opts: { text, wp, hp, center, wrap, lineSpacing }
  function renderTextCanvas(opts) {
    const { text, wp, hp } = opts;
    const center = opts.center !== false;
    const doWrap = opts.wrap !== false;
    const ls = opts.lineSpacing || 1.2;

    const cv = document.createElement('canvas');
    cv.width = wp; cv.height = hp;
    const x = cv.getContext('2d');
    x.fillStyle = '#FFF'; x.fillRect(0, 0, wp, hp);
    x.fillStyle = '#000';
    if (!text || !text.trim()) return cv;

    const margin = Math.round(Math.min(wp, hp) * 0.05);
    const maxW = wp - margin * 2, maxH = hp - margin * 2;

    let fs = Math.min(maxH, 400), wrapped = [];
    while (fs > 4) {
      x.font = fs + 'px sans-serif';
      wrapped = wrapText(x, text, maxW, doWrap);
      const totalH = wrapped.length * fs * ls - (fs * (ls - 1));
      const maxLineW = Math.max(...wrapped.map((l) => x.measureText(l).width), 0);
      if (maxLineW <= maxW && totalH <= maxH) break;
      fs -= 1;
    }

    x.textBaseline = 'top';
    x.textAlign = center ? 'center' : 'left';
    const lineH = fs * ls;
    const totalH = wrapped.length * fs * ls - (fs * (ls - 1));
    const startY = Math.round((hp - totalH) / 2);
    for (let i = 0; i < wrapped.length; i++) {
      const xx = center ? wp / 2 : margin;
      x.fillText(wrapped[i], xx, startY + i * lineH);
    }
    return cv;
  }

  // ─────────────────────────────────────────────────────────────
  // QR/Code128-Label auf Canvas (Code + darunter Klartext)
  // Erwartet die globalen Libs qrcode() und JsBarcode(). Bei Landscape wird
  // auf ein gedrehtes Hilfscanvas gerendert und dann 90° aufs echte gezeichnet.
  // opts: { value, wp, hp, mode:'qr'|'code128', orient, fontSize, gap }
  // ─────────────────────────────────────────────────────────────
  function renderCodeLabelCanvas(opts) {
    const { value, wp, hp } = opts;
    const mode = opts.mode === 'code128' ? 'code128' : 'qr';
    const isLand = opts.orient === 'landscape';
    const fs = Math.max(6, Math.min(80, opts.fontSize || 12));
    const userGap = Math.max(0, Math.min(60, opts.gap != null ? opts.gap : 2));

    // Bei Landscape: Inhalt auf vertauschtem Canvas rendern, danach rotieren.
    const cw = isLand ? hp : wp, ch = isLand ? wp : hp;
    const tmp = document.createElement('canvas');
    tmp.width = cw; tmp.height = ch;
    const x = tmp.getContext('2d');
    x.fillStyle = '#FFF'; x.fillRect(0, 0, cw, ch);
    x.fillStyle = '#000';

    const txtH = Math.round(fs * 1.2);
    const gap = userGap;
    const margin = Math.round(Math.min(cw, ch) * 0.03);

    if (mode === 'qr') {
      try {
        const q = qrcode(0, 'M'); q.addData(value); q.make();
        const m = q.getModuleCount();
        const maxW = cw - margin * 2;
        const maxH = ch - margin * 2 - txtH - gap;
        const cs = Math.floor(Math.min(maxW, maxH) / m);
        const sz = cs * m;
        const totalH = sz + gap + txtH;
        const startY = Math.round((ch - totalH) / 2);
        const startX = Math.round((cw - sz) / 2);
        for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) if (q.isDark(r, c)) x.fillRect(startX + c * cs, startY + r * cs, cs, cs);
        x.font = `${fs}px monospace`; x.textAlign = 'center'; x.textBaseline = 'top';
        x.fillText(value, cw / 2, startY + sz + gap, cw - margin * 2);
      } catch (e) {
        x.font = `bold ${Math.round(ch * 0.08)}px monospace`; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText('QR Err', cw / 2, ch / 2);
      }
    } else {
      try {
        const maxW = cw - margin * 2;
        const bcH = ch - margin * 2 - txtH - gap;
        // Barcode direkt auf ein Hilfscanvas rendern (vermeidet SVG-Parsing).
        const bcCanvas = document.createElement('canvas');
        JsBarcode(bcCanvas, value, { format: 'CODE128', width: 2, height: bcH, displayValue: false, margin: 0, background: '#FFFFFF', lineColor: '#000000' });
        const scale = Math.min(maxW / bcCanvas.width, bcH / bcCanvas.height);
        const drawW = Math.round(bcCanvas.width * scale);
        const drawH = Math.round(bcCanvas.height * scale);
        const totalH = drawH + gap + txtH;
        const startY = Math.round((ch - totalH) / 2);
        const startX = Math.round((cw - drawW) / 2);
        x.drawImage(bcCanvas, startX, startY, drawW, drawH);
        x.font = `${fs}px monospace`; x.textAlign = 'center'; x.textBaseline = 'top';
        x.fillText(value, cw / 2, startY + drawH + gap, maxW);
      } catch (e) {
        x.font = `bold ${Math.round(ch * 0.08)}px monospace`; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText('BC Err', cw / 2, ch / 2);
      }
    }

    if (!isLand) return tmp;
    // Landscape: gedrehtes Hilfscanvas auf ein echtes Canvas (wp x hp) legen.
    const real = document.createElement('canvas');
    real.width = wp; real.height = hp;
    const rx = real.getContext('2d');
    rx.fillStyle = '#FFF'; rx.fillRect(0, 0, wp, hp);
    rx.save(); rx.translate(wp, 0); rx.rotate(Math.PI / 2); rx.drawImage(tmp, 0, 0); rx.restore();
    return real;
  }

  // ─────────────────────────────────────────────────────────────
  // 2-Namen-Schild auf Canvas (Rahmen + Name oben/unten + Trennlinie)
  // Ein Blatt zum Zerschneiden in zwei identische Schilder. Auto-Schriftgroesse
  // pro Haelfte. Fuer Print-It (Bitmap/GFA) und die Zebra-Vorschau.
  // opts: { name, wp, hp }
  // ─────────────────────────────────────────────────────────────
  function render2NameCanvas(opts) {
    const { name, wp, hp } = opts;
    const cv = document.createElement('canvas');
    cv.width = wp; cv.height = hp;
    const x = cv.getContext('2d');
    x.fillStyle = '#FFF'; x.fillRect(0, 0, wp, hp);
    x.fillStyle = '#000';

    const border = Math.max(2, Math.round(Math.min(wp, hp) * 0.02));
    const margin = Math.round(wp * 0.06);
    const contentW = wp - 2 * margin;
    const halfH = (hp - 2 * margin) / 2;
    const maxFont = wp * 0.16;
    const minFont = Math.max(8, wp * 0.045);

    // Rahmen zeichnen.
    x.lineWidth = border;
    x.strokeStyle = '#000';
    x.strokeRect(border / 2, border / 2, wp - border, hp - border);

    // Text-Zeichner: mehrzeilig, zentriert, mit gemeinsamer Auto-Schriftgroesse.
    const fontPx = calcFitFontSize(name, contentW, halfH, maxFont, minFont);
    function drawHalf(topY) {
      const lines = String(name || '–').split('\n');
      x.font = `bold ${fontPx}px sans-serif`;
      x.fillStyle = '#000';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      const lineH = fontPx * 1.15;
      const totalH = lines.length * lineH;
      const startY = topY + halfH / 2 - totalH / 2 + lineH / 2;
      lines.forEach((l, i) => x.fillText(l, wp / 2, startY + i * lineH, contentW));
    }
    drawHalf(margin);
    drawHalf(margin + halfH);

    // Gestrichelte Trennlinie in der Mitte.
    const midY = Math.round(hp / 2);
    x.strokeStyle = '#000';
    x.lineWidth = Math.max(1, Math.round(border / 2));
    x.setLineDash([wp * 0.03, wp * 0.02]);
    x.beginPath();
    x.moveTo(margin, midY);
    x.lineTo(wp - margin, midY);
    x.stroke();
    x.setLineDash([]);
    return cv;
  }

  // ─────────────────────────────────────────────────────────────
  // Native ZPL-Erzeugung (scharfe Zebra-Ausgabe) — vor allem fuer Zebra Print it
  // ─────────────────────────────────────────────────────────────

  // Gemeinsamer ZPL-Kopf. cfg: { widthDots, heightDots, darkness, speed }
  function zplHeader(cfg) {
    let h = `^XA\n^CI28\n^PW${cfg.widthDots}\n^LL${cfg.heightDots}`;
    if (cfg.darkness != null) h += `\n^MD${cfg.darkness}`;
    if (cfg.speed != null) h += `\n^PR${cfg.speed}`;
    return h;
  }
  // ZPL-Fuss inkl. optionaler nativer Mehrfach-Kopie (^PQ).
  function zplFooter(copies) {
    const c = clampCopies(copies);
    return (c > 1 ? `\n^PQ${c}` : '') + '\n^XZ';
  }

  // Nativer Freitext (mehrzeilig, horizontale Ausrichtung L/C/R, vertikal top/middle/bottom).
  // opts: { text, widthDots, heightDots, darkness, speed, fontSize, halign, valign, copies }
  function buildZplText(opts) {
    const padding = 20;
    const lineHeight = opts.fontSize + 10;
    const lines = String(opts.text || '').split('\n');
    const totalTextHeight = lines.length * lineHeight;

    let startY;
    if (opts.valign === 'top') startY = padding;
    else if (opts.valign === 'bottom') startY = Math.max(padding, opts.heightDots - totalTextHeight - padding);
    else startY = Math.max(padding, Math.round((opts.heightDots - totalTextHeight) / 2));

    const blockWidth = Math.max(10, opts.widthDots - 2 * padding);
    let fields = '';
    lines.forEach((line, i) => {
      const safe = stripZplControl(line);
      const y = startY + i * lineHeight;
      fields += `\n^FO${padding},${y}^A0N,${opts.fontSize},${opts.fontSize}^FB${blockWidth},1,0,${opts.halign || 'C'},0^FD${safe}^FS`;
    });
    return zplHeader(opts) + fields + zplFooter(opts.copies);
  }

  // Nativer QR-Code (^BQN) plus Klartext darunter.
  // opts: { value, widthDots, heightDots, darkness, speed, fontSize, copies }
  function buildZplQR(opts) {
    const dw = opts.widthDots, dh = opts.heightDots;
    const fontH = opts.fontSize || 30;
    const gap = Math.max(4, Math.round(dh * 0.01));
    const margin = Math.round(dw * 0.03);
    const estMod = 21; // grobe Modulzahl fuer die Groessenschaetzung
    const maxSz = Math.min(dw - margin * 2, dh - margin * 2 - fontH - gap);
    const mag = Math.max(1, Math.min(10, Math.floor(maxSz / estMod)));
    const qrSz = mag * estMod;
    const qrX = Math.round((dw - qrSz) / 2);
    const totalH = qrSz + gap + fontH;
    const qrY = Math.round((dh - totalH) / 2);
    const txtY = qrY + qrSz + gap;
    const safe = stripZplControl(opts.value);
    const body =
      `\n^FO${qrX},${qrY}^BQN,2,${mag}^FDQA,${safe}^FS` +
      `\n^FO0,${txtY}^FB${dw},1,0,C,0^A0N,${fontH},${fontH}^FD${safe}^FS`;
    return zplHeader(opts) + body + zplFooter(opts.copies);
  }

  // Nativer Code128-Barcode (^BCN) plus Klartext darunter.
  // opts: { value, widthDots, heightDots, darkness, speed, fontSize, copies }
  function buildZplCode128(opts) {
    const dw = opts.widthDots, dh = opts.heightDots;
    const fontH = opts.fontSize || 30;
    const gap = Math.max(4, Math.round(dh * 0.01));
    const margin = Math.round(dw * 0.03);
    const bcH = Math.max(40, dh - margin * 2 - fontH - gap);
    const totalH = bcH + gap + fontH;
    const bcY = Math.round((dh - totalH) / 2);
    const txtY = bcY + bcH + gap;
    const barW = Math.max(1, Math.min(4, Math.floor((dw - margin * 2) / 120)));
    const safe = stripZplControl(opts.value);
    const body =
      `\n^FO${margin},${bcY}^FB${dw - margin * 2},1,0,C,0^BY${barW}^BCN,${bcH},N,N,N^FD${safe}^FS` +
      `\n^FO0,${txtY}^FB${dw},1,0,C,0^A0N,${fontH},${fontH}^FD${safe}^FS`;
    return zplHeader(opts) + body + zplFooter(opts.copies);
  }

  // Natives 2-Namen-Schild: Rahmen (^GB), Name oben/unten (Auto-Schrift), gestrichelte Linie.
  // opts: { name, widthDots, heightDots, darkness, speed, halign, copies }
  function build2NameZpl(opts) {
    const dw = opts.widthDots, dh = opts.heightDots;
    const margin = 16;
    const borderThickness = 6;
    const contentWidth = dw - 2 * margin;
    const availableHeight = dh - 2 * margin;
    const halfHeight = Math.max(20, Math.round(availableHeight / 2));
    const halign = opts.halign || 'C';

    const maxFontDots = Math.round(contentWidth * 0.16);
    const minFontDots = Math.max(14, Math.round(contentWidth * 0.045));
    const nameFontSize = calcFitFontSize(opts.name, contentWidth, halfHeight, maxFontDots, minFontDots);
    const dashFontSize = Math.max(10, Math.round(nameFontSize * 0.5));
    const dashY = margin + halfHeight - Math.round(dashFontSize / 2);

    // Mehrzeiligen Namen mittig in einem Bereich platzieren.
    function textBlock(text, areaY, areaHeight) {
      const lines = String(text || '').split('\n');
      const lineHeight = nameFontSize + 8;
      const totalHeight = lines.length * lineHeight;
      const startY = areaY + Math.max(0, Math.round((areaHeight - totalHeight) / 2));
      let out = '';
      lines.forEach((line, i) => {
        const safe = stripZplControl(line);
        const y = startY + i * lineHeight;
        out += `\n^FO${margin},${y}^FB${contentWidth},1,0,${halign},0^A0N,${nameFontSize},${nameFontSize}^FD${safe}^FS`;
      });
      return out;
    }

    let body = `\n^FO${margin},${margin}^GB${contentWidth},${availableHeight},${borderThickness}^FS`;
    body += textBlock(opts.name, margin, halfHeight);
    body += `\n^FO${margin},${dashY}^FB${contentWidth},1,0,C,0^A0N,${dashFontSize},${dashFontSize}^FD------------^FS`;
    body += textBlock(opts.name, margin + halfHeight, halfHeight);
    return zplHeader(opts) + body + zplFooter(opts.copies);
  }

  // ─────────────────────────────────────────────────────────────
  // Listen-Parsing (Text/CSV/PDF), Duplikat-Nummerierung, Sortierung
  // ─────────────────────────────────────────────────────────────

  // Freitext/CSV zu Zeilen. Bei CSV wird die erste Spalte genommen.
  function parseText(txt) {
    if (!txt) return [];
    const out = [];
    for (const raw of txt.split(/\r?\n/)) {
      let line = raw;
      if (line.includes(';')) line = line.split(';')[0];
      else if (line.includes(',') && !line.match(/^[^,]+\s/)) line = line.split(',')[0];
      line = line.replace(/^["']|["']$/g, '').trim();
      if (line) out.push(line);
    }
    return out;
  }

  // Zeilen in Eintraege mit stabiler ID und Duplikat-Markierung (1/2, 2/2 ...) wandeln.
  // Behaelt die Quell-Reihenfolge (srcIdx) fuer die "Reihenfolge Quelle"-Sortierung.
  function bucketDuplicates(items) {
    const counts = {}, seen = {};
    for (const t of items) { const k = (t || '').trim(); if (!k) continue; counts[k] = (counts[k] || 0) + 1; }
    const out = [];
    for (let idx = 0; idx < items.length; idx++) {
      const k = (items[idx] || '').trim();
      if (!k) continue;
      seen[k] = (seen[k] || 0) + 1;
      const i = seen[k] - 1, cnt = counts[k];
      out.push({ text: k, dup: cnt > 1 ? (i + 1) + '/' + cnt : null, id: k + '#' + i, srcIdx: idx });
    }
    return out;
  }

  // Natuerlich-numerische Sortierung (z. B. Box-2 vor Box-10).
  function naturalSort(a, b) {
    return String(a).toLocaleLowerCase().localeCompare(String(b).toLocaleLowerCase(), 'de', { numeric: true, sensitivity: 'base' });
  }

  // PDF-Textlayer auslesen: Spans je ungefaehrer Y-Position zu Zeilen gruppieren.
  // pdfjsLib muss vom Aufrufer bereitgestellt werden (window.pdfjsLib).
  async function parsePdf(file, pdfjsLib) {
    if (!pdfjsLib) throw new Error('PDF-Library fehlt');
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const all = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const lines = {};
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = Math.round(it.transform[5]);
        (lines[y] = lines[y] || []).push({ x: it.transform[4], s: it.str });
      }
      for (const y of Object.keys(lines)) {
        const joined = lines[y].sort((a, b) => a.x - b.x).map((p) => p.s).join('').trim();
        if (joined) all.push(joined);
      }
    }
    return all;
  }

  // ─────────────────────────────────────────────────────────────
  // Transporte (zustandslose Sender). BLE/Niimbot bleiben geraet-zustandsbehaftet
  // in der jeweiligen App; hier die reinen fetch-basierten Transporte.
  // ─────────────────────────────────────────────────────────────

  // Zebra Browser Print Agent: verfuegbare Drucker abfragen.
  // agent: Basis-URL (z. B. http://127.0.0.1:9100).
  async function browserPrintList(agent) {
    const res = await fetch(`${agent}/available`);
    const data = await res.json();
    return data.printer || [];
  }
  // Zebra Browser Print Agent: ZPL an ein Geraet senden.
  async function browserPrintSend(agent, device, zpl) {
    const res = await fetch(`${agent}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ device, data: zpl }),
    });
    if (!res.ok) throw new Error('Browser Print HTTP ' + res.status);
    return true;
  }

  // Direkter HTTP-Druck (z. B. Drucker-Rohport oder Bridge). cfg: { url, path, user, pass }
  async function httpSend(cfg, data) {
    let u = (cfg.url || '').trim();
    if (!u) throw new Error('Keine URL');
    if (cfg.path) u = u.replace(/\/$/, '') + cfg.path;
    const h = { 'Content-Type': 'application/octet-stream' };
    if (cfg.user) h['Authorization'] = 'Basic ' + btoa(cfg.user + ':' + (cfg.pass || ''));
    const r = await fetch(u, { method: 'POST', headers: h, body: data, mode: 'cors' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return true;
  }

  // CUPS-Druck ueber IPP-HTTP-Endpunkt. cfg: { url, printer, user, pass }
  async function cupsSend(cfg, data) {
    const b = (cfg.url || '').trim() || 'http://localhost:631';
    if (!cfg.printer) throw new Error('Kein Drucker');
    const h = { 'Content-Type': 'application/octet-stream' };
    if (cfg.user) h['Authorization'] = 'Basic ' + btoa(cfg.user + ':' + (cfg.pass || ''));
    const r = await fetch(b.replace(/\/$/, '') + '/printers/' + cfg.printer, { method: 'POST', headers: h, body: data });
    if (!r.ok) throw new Error('CUPS ' + r.status);
    return true;
  }

  // Alles unter window.PrintCore verfuegbar machen.
  global.PrintCore = {
    DPI203, DPI300,
    mmToDots, clampCopies, round, escapeHtml, stripZplControl,
    calcFitFontSize,
    to1Bit, canvasToZplGfa,
    wrapText, renderTextCanvas, renderCodeLabelCanvas, render2NameCanvas,
    zplHeader, zplFooter, buildZplText, buildZplQR, buildZplCode128, build2NameZpl,
    parseText, bucketDuplicates, naturalSort, parsePdf,
    browserPrintList, browserPrintSend, httpSend, cupsSend,
  };
})(typeof window !== 'undefined' ? window : this);
