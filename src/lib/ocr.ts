// Tesseract.js OCR — runs entirely in the browser via Web Worker

export interface OcrResult {
  text: string;
  confidence: number; // 0–100
}

export async function runTesseract(imageFile: File | Blob): Promise<OcrResult> {
  // The dynamic import + WASM worker can fail to load (offline, blocked CDN,
  // low memory). Degrade to an empty result rather than throwing so every
  // caller gets a stable shape and the capture flow never crashes.
  try {
    const Tesseract = (await import("tesseract.js")).default;

    const result = await Tesseract.recognize(imageFile, "eng", {
      logger: () => {}, // suppress console noise
    });

    return {
      text: result.data.text.trim(),
      confidence: result.data.confidence,
    };
  } catch (err) {
    console.warn("[ocr] Tesseract failed to run:", err);
    return { text: "", confidence: 0 };
  }
}

// Parse raw OCR text into structured fields as a best-effort fallback
export function parseOcrText(text: string): {
  name: string;
  dates: string[];
  lines: string[];
} {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Date pattern: matches years 1700–2100, full dates, ranges
  const dateRegex =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|\b(1[7-9]\d{2}|20\d{2})\b/gi;

  const dates: string[] = [];
  lines.forEach((line) => {
    const matches = line.match(dateRegex);
    if (matches) dates.push(...matches);
  });

  // Heuristic: the longest ALL-CAPS or Title Case line before any dates is likely the name
  const nameCandidate =
    lines.find((line) => {
      const hasDate = dateRegex.test(line);
      dateRegex.lastIndex = 0;
      return (
        !hasDate &&
        line.length > 3 &&
        line.length < 60 &&
        /^[A-Z][a-zA-Z\s'-]+$/.test(line)
      );
    }) ?? "";

  return { name: nameCandidate, dates, lines };
}
