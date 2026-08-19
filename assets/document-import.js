(function (global) {
  "use strict";

  const LABELS = {
    length: ["längd", "langd", "total längd", "ljuslinjelängd", "length", "total length", "lengde", "pituus", "länge"],
    mounting: ["montage", "montering", "mounting", "installation", "asennus"],
    color: ["färg", "farg", "colour", "color", "farge", "väri", "farbe"],
    luminousFlux: ["ljusflöde", "ljusflode", "luminous flux", "lichtstrom", "lysstrøm", "lysstrøm", "valovirta"],
    systemCount: ["antal system", "antal ljuslinjer", "number of systems", "systems", "antall systemer", "järjestelmien määrä", "anzahl systeme"],
    sArticle: ["s-artikel", "s artikel", "s-article", "s article", "s-artikkeli"]
  };

  function normalizeText(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\t\u00a0]+/g, " ")
      .replace(/[ ]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function parseLocalizedNumber(value) {
    let raw = String(value || "").trim().replace(/\s+/g, "");
    if (!raw) return null;
    const comma = raw.lastIndexOf(",");
    const dot = raw.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? "," : ".";
      const thousands = decimal === "," ? /\./g : /,/g;
      raw = raw.replace(thousands, "").replace(decimal, ".");
    } else {
      raw = raw.replace(",", ".");
    }
    raw = raw.replace(/[^0-9.+-]/g, "");
    const number = Number(raw);
    return Number.isFinite(number) ? number : null;
  }

  function linesFor(text) {
    return normalizeText(text).split("\n").map(line => line.trim()).filter(Boolean);
  }

  function excerptFor(lines, index, radius = 1) {
    const start = Math.max(0, index - radius);
    const end = Math.min(lines.length, index + radius + 1);
    return lines.slice(start, end).join(" · ").slice(0, 420);
  }

  function findLabeledLine(lines, labels) {
    const pattern = new RegExp(`(?:${labels.map(escapeRegExp).join("|")})`, "i");
    const index = lines.findIndex(line => pattern.test(line));
    return index < 0 ? null : { line: lines[index], index, excerpt: excerptFor(lines, index) };
  }

  function parseLength(lines) {
    const labelPattern = LABELS.length.map(escapeRegExp).join("|");
    const valuePattern = "([0-9][0-9 .,'’]*)";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const direct = line.match(new RegExp(`(?:${labelPattern})\\s*(?::|=|-)?\\s*${valuePattern}\\s*(mm|m|meter|metre)?\\b`, "i"));
      if (!direct) continue;
      const number = parseLocalizedNumber(direct[1]);
      if (!number || number <= 0) continue;
      const unit = String(direct[2] || "m").toLowerCase();
      const lengthM = unit === "mm" ? number / 1000 : number;
      if (lengthM < 0.5 || lengthM > 500) continue;
      return { value: lengthM, evidence: excerptFor(lines, index) };
    }
    return null;
  }

  function parseMounting(lines) {
    const found = findLabeledLine(lines, LABELS.mounting);
    const haystack = found ? found.line : lines.join(" ");
    const rules = [
      { value: "re", pattern: /\b(?:RE|infälld|inbyggd|recessed|innfelt|upotettu|einbau)\b/i },
      { value: "pe", pattern: /\b(?:PE|pendel|pendlad|suspended|pendant|riippu|abgependelt)\b/i },
      { value: "ce", pattern: /\b(?:CE|takmontage|takmonterad|ceiling|takmontert|pinta-asennus|deckenmontage)\b/i }
    ];
    const rule = rules.find(item => item.pattern.test(haystack));
    return rule ? { value: rule.value, evidence: found?.excerpt || haystack.slice(0, 420) } : null;
  }

  function parseColor(lines) {
    const found = findLabeledLine(lines, LABELS.color);
    const haystack = found ? found.line : lines.join(" ");
    if (/\b(?:svart|black|sort|musta|schwarz)\b/i.test(haystack)) return { value: "black", evidence: found?.excerpt || haystack.slice(0, 420) };
    if (/\b(?:vit|white|hvit|valkoinen|weiß|weiss)\b/i.test(haystack)) return { value: "white", evidence: found?.excerpt || haystack.slice(0, 420) };
    return null;
  }

  function parseLuminousFlux(lines) {
    const labelPattern = LABELS.luminousFlux.map(escapeRegExp).join("|");
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(new RegExp(`(?:${labelPattern})\\s*(?::|=|-)?\\s*([0-9][0-9 .,'’]*)\\s*(?:lm|lumen)?\\b`, "i"));
      const number = match ? parseLocalizedNumber(match[1]) : null;
      if (number !== null && number >= 0 && number <= 1000000) return { value: Math.round(number), evidence: excerptFor(lines, index) };
    }
    return null;
  }

  function parseSystemCount(lines) {
    const labelPattern = LABELS.systemCount.map(escapeRegExp).join("|");
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(new RegExp(`(?:${labelPattern})\\s*(?::|=|-)?\\s*(\\d{1,3})\\b`, "i"));
      const number = match ? Number(match[1]) : null;
      if (Number.isInteger(number) && number > 0 && number <= 999) return { value: number, evidence: excerptFor(lines, index) };
    }
    return null;
  }

  function parseSArticle(lines) {
    const labelPattern = LABELS.sArticle.map(escapeRegExp).join("|");
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(new RegExp(`(?:${labelPattern})\\s*(?::|=|-)?\\s*([A-Z0-9][A-Z0-9._/-]{1,31})`, "i"));
      if (match) return { value: match[1].toUpperCase(), evidence: excerptFor(lines, index) };
    }
    return null;
  }

  function parseComponents(lines) {
    const components = [];
    const kindMap = { start: "start", mid: "mid", end: "end", början: "start", mitt: "mid", slut: "end" };
    lines.forEach((line, index) => {
      const match = line.match(/\b(start|mid|end|början|mitt|slut)\s*(1200|1700)?\s*(?::|=|-)?\s*(?:x\s*)?(\d{1,3})\s*(?:st|pcs?|kpl|stk)?\b/i);
      if (!match) return;
      const count = Number(match[3]);
      if (!Number.isInteger(count) || count < 0) return;
      components.push({
        kind: kindMap[match[1].toLowerCase()] || match[1].toLowerCase(),
        size: match[2] ? Number(match[2]) : null,
        count,
        evidence: excerptFor(lines, index)
      });
    });
    return components;
  }

  function splitSystemBlocks(text) {
    const normalized = normalizeText(text);
    const marker = /^(?:system|ljuslinje|light\s*line|lys(?:linje)?|valolinja)\s*(?::|#|-)?\s*([A-ZÅÄÖ]|\d+)\b.*$/gim;
    const matches = [...normalized.matchAll(marker)];
    if (!matches.length) return [{ label: "A", text: normalized }];
    return matches.map((match, index) => ({
      label: String(match[1]).toUpperCase(),
      text: normalized.slice(match.index, matches[index + 1]?.index ?? normalized.length).trim()
    }));
  }

  function proposalFromBlock(block, index) {
    const lines = linesFor(block.text);
    const length = parseLength(lines);
    const mounting = parseMounting(lines);
    const color = parseColor(lines);
    const luminousFlux = parseLuminousFlux(lines);
    const systemCount = parseSystemCount(lines);
    const sArticle = parseSArticle(lines);
    const components = parseComponents(lines);
    const evidence = [];
    [
      ["lengthM", length], ["mounting", mounting], ["color", color],
      ["luminousFlux", luminousFlux], ["systems", systemCount], ["sArticle", sArticle]
    ].forEach(([field, result]) => {
      if (result) evidence.push({ field, value: result.value, excerpt: result.evidence });
    });
    components.forEach(component => evidence.push({ field: `component.${component.kind}`, value: component.count, excerpt: component.evidence }));

    const missing = [];
    if (!length && !components.length) missing.push("length");
    if (!mounting) missing.push("mounting");
    if (!color) missing.push("color");
    if (!sArticle) missing.push("sArticle");
    const strongFields = [Boolean(length || components.length), Boolean(mounting), Boolean(color)].filter(Boolean).length;
    const confidence = strongFields === 3 ? "high" : strongFields === 2 ? "medium" : "low";
    return {
      id: `proposal-${index + 1}`,
      sourceLabel: block.label || String(index + 1),
      lengthM: length?.value ?? null,
      mounting: mounting?.value ?? null,
      color: color?.value ?? null,
      luminousFlux: luminousFlux?.value ?? "",
      systems: systemCount?.value ?? 1,
      sArticle: sArticle?.value ?? "",
      components,
      confidence,
      approvalStatus: "needs_review",
      allowedUse: "review_only",
      missing,
      evidence,
      sourceExcerpt: lines.slice(0, 8).join(" · ").slice(0, 900)
    };
  }

  function parseDocumentSystems(text, options = {}) {
    const normalized = normalizeText(text);
    if (normalized.length < 12) {
      return { fileName: options.fileName || "", textLength: normalized.length, proposals: [], warnings: ["no_readable_text"] };
    }
    const proposals = splitSystemBlocks(normalized)
      .map(proposalFromBlock)
      .filter(proposal => proposal.lengthM || proposal.components.length);
    return {
      fileName: options.fileName || "",
      textLength: normalized.length,
      proposals,
      warnings: proposals.length ? [] : ["no_systems_found"]
    };
  }

  global.SevedeDocumentImport = {
    normalizeText,
    parseLocalizedNumber,
    parseDocumentSystems
  };
})(typeof window !== "undefined" ? window : globalThis);
