import { GoogleGenAI, Type } from '@google/genai';
import type { DetectedTrendSignal, TacticalAiBrief } from '../src/types/soccer';

export interface TacticalBriefInput {
  trend: DetectedTrendSignal;
  homeTeam: string;
  awayTeam: string;
  possessionHome: number | null;
  possessionAway: number | null;
  shotsHome: string;
  shotsAway: string;
  nextGoalHomeProb: number;
  nextGoalAwayProb: number;
  winHomeProb: number;
  drawProb: number;
  winAwayProb: number;
}

/**
 * Default model for tactical briefs. `gemini-3.8-flash` is listed as a stable
 * model on https://ai.google.dev/gemini-api/docs/models. The previous hardcoded
 * ID (`gemini-4-hydrogen`) does not appear there. Override with GEMINI_MODEL
 * when Google retires or renames models.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export function getGeminiModelName(): string {
  return (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL;
}

function extractReadableGeminiError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; code?: number } };
    if (parsed?.error?.message) {
      return `Gemini API (${parsed.error.code ?? 'error'}): ${parsed.error.message}`;
    }
  } catch {
    // Not raw JSON
  }
  return raw;
}

export async function generateTacticalBrief(
  input: TacticalBriefInput
): Promise<TacticalAiBrief> {
  const MODEL_NAME = getGeminiModelName();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured in server secrets. Set GEMINI_API_KEY in the Settings > Secrets panel to enable AI tactical alert synthesis.'
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const prompt = [
    `Match: ${input.homeTeam} vs ${input.awayTeam} (${input.trend.league})`,
    `Minute: ${input.trend.minute}' | Current Score: ${input.trend.scoreline}`,
    `Detected Quantitative Trend (${input.trend.teamName}): ${input.trend.patternLabel}`,
    `Last ${input.trend.windowMinutes}m Metrics: ${input.trend.recentShots} shots (${input.trend.recentShotsOnTarget} on target), ${input.trend.recentCorners} corners, ${input.trend.consecutiveMomentumMinutes} consecutive dominant minutes.`,
    `Full-Match Telemetry: Possession ${input.possessionHome ?? '?'}% vs ${input.possessionAway ?? '?'}%, Shots ${input.shotsHome} vs ${input.shotsAway}.`,
    `Odds-Free Pure-Flow Probabilities: 1X2 (${(input.winHomeProb * 100).toFixed(1)}% / ${(input.drawProb * 100).toFixed(1)}% / ${(input.winAwayProb * 100).toFixed(1)}%), Next Goal (${input.homeTeam} ${(input.nextGoalHomeProb * 100).toFixed(1)}% vs ${input.awayTeam} ${(input.nextGoalAwayProb * 100).toFixed(1)}%).`,
    `Recent Scraped Play-by-Play Events:`,
    input.trend.recentCommentary.length > 0
      ? input.trend.recentCommentary.map((c) => `- ${c}`).join('\n')
      : '- No play-by-play text lines available beyond cumulative boxscore counters.',
  ].join('\n');

  let response;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction:
            'You are a quantitative live soccer tactical analyst. Evaluate ONLY the supplied odds-free match flow, shot quality, and play-by-play commentary. Never invent events or statistics not present in the input. Distinguish genuine high-danger box chances/woodwork/saves from harmless long-range shots. Keep dangerQualitySummary under 45 words and keyRiskFactor under 25 words.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              tacticalVerdict: {
                type: Type.STRING,
                enum: [
                  'High-Conviction Attack',
                  'Sustained Pressure',
                  'Low-Danger Possession',
                ],
                description:
                  'Classification of whether the attack trend creates real scoring threat.',
              },
              bestMarketPick: {
                type: Type.STRING,
                description:
                  'Concise recommended market & side aligned with the flow (e.g. Next Team to Score: Sydney FC, Over 1.5 Goals, or Match Winner).',
              },
              dangerQualitySummary: {
                type: Type.STRING,
                description:
                  'Short evidence-grounded summary citing the specific shots, saves, or corners observed in the play-by-play.',
              },
              keyRiskFactor: {
                type: Type.STRING,
                description:
                  'Primary counter-attack, finishing waste, or time-remaining risk.',
              },
            },
            required: [
              'tacticalVerdict',
              'bestMarketPick',
              'dangerQualitySummary',
              'keyRiskFactor',
            ],
          },
        },
      });
      break;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const isTransient =
        raw.includes('503') ||
        raw.includes('500') ||
        raw.includes('UNAVAILABLE') ||
        raw.includes('high demand');
      if (isTransient && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      throw new Error(extractReadableGeminiError(raw));
    }
  }

  const text = (response?.text ?? '').trim();
  if (!text) {
    throw new Error('Gemini returned an empty response for tactical brief.');
  }

  const parsed = JSON.parse(text) as {
    tacticalVerdict: TacticalAiBrief['tacticalVerdict'];
    bestMarketPick: string;
    dangerQualitySummary: string;
    keyRiskFactor: string;
  };

  return {
    trendId: input.trend.id,
    matchId: input.trend.matchId,
    tacticalVerdict: parsed.tacticalVerdict,
    bestMarketPick: parsed.bestMarketPick,
    dangerQualitySummary: parsed.dangerQualitySummary,
    keyRiskFactor: parsed.keyRiskFactor,
    generatedAt: new Date().toISOString(),
    modelUsed: MODEL_NAME,
  };
}
