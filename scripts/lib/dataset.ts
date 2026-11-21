import fs from 'node:fs';
import path from 'node:path';
import type { ScrapedMatch } from '../../src/types/soccer';

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function writeJsonFile(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function loadHistory(file: string): ScrapedMatch[] {
  const data = readJsonFile<unknown>(file, []);
  if (!Array.isArray(data)) throw new Error(`${file} is not a JSON array of matches`);
  return data.filter(
    (m): m is ScrapedMatch =>
      Boolean(m) && typeof m === 'object' && typeof (m as ScrapedMatch).id === 'string' && Array.isArray((m as ScrapedMatch).events)
  );
}

export interface LiveLogRecord {
  capturedAt: string;
  match: ScrapedMatch;
}

export function loadLiveLog(file: string): LiveLogRecord[] {
  if (!fs.existsSync(file)) return [];
  const out: LiveLogRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as LiveLogRecord;
      if (rec?.match?.id && rec.capturedAt) out.push(rec);
    } catch {
      // skip a partially-written trailing line
    }
  }
  return out;
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export function numArg(args: Record<string, string | boolean>, key: string, fallback: number): number {
  const v = args[key];
  const n = typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}
