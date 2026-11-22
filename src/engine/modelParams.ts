import fitted from './fittedParams.json';

/**
 * Structural constants of the Poisson-flow model that used to be hard-coded inside
 * `predictMatchMarkets`. They are exposed so they can be FITTED on historical data
 * (see scripts/fit.ts) instead of being trusted as hand-picked magic numbers.
 */
export interface StructuralParams {
  /** Baseline goals per 90 for home / away before any in-match evidence. */
  baseHome90: number;
  baseAway90: number;
  /** Contribution per (rate-per-90) of shots on target, total shots, corners. */
  sotCoef: number;
  shotVolCoef: number;
  cornerCoef: number;
  /** Weight of the possession edge and of the last-5 form score. */
  possessionCoef: number;
  formCoef: number;
  /**
   * Empirical-Bayes shrinkage of observed per-90 attacking rates toward a league prior,
   * expressed as pseudo-minutes of prior exposure. 0 disables shrinkage (legacy behaviour).
   * Early in a match a couple of shots would otherwise be extrapolated to a full 90.
   */
  shrinkMinutes: number;
  priorSot90: number;
  priorShots90: number;
  priorCorners90: number;
}

/** Legacy hand-chosen values, unchanged so existing behaviour is preserved until a fit beats them. */
export const DEFAULT_PARAMS: StructuralParams = {
  baseHome90: 1.22,
  baseAway90: 1.08,
  sotCoef: 0.14,
  shotVolCoef: 0.04,
  cornerCoef: 0.06,
  possessionCoef: 0.35,
  formCoef: 0.42,
  shrinkMinutes: 0,
  priorSot90: 4.5,
  priorShots90: 12,
  priorCorners90: 5,
};

/** Search bounds used by the fitter; also used to validate a fitted file before trusting it. */
export const PARAM_BOUNDS: Record<keyof StructuralParams, [number, number]> = {
  baseHome90: [0.6, 2.2],
  baseAway90: [0.5, 2.0],
  sotCoef: [0, 0.4],
  shotVolCoef: [0, 0.15],
  cornerCoef: [0, 0.2],
  possessionCoef: [0, 1.2],
  formCoef: [0, 1.0],
  shrinkMinutes: [0, 90],
  priorSot90: [2, 8],
  priorShots90: [6, 20],
  priorCorners90: [2, 9],
};

function isValid(p: unknown): p is StructuralParams {
  if (!p || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  return (Object.keys(PARAM_BOUNDS) as (keyof StructuralParams)[]).every((k) => {
    const v = obj[k];
    const [lo, hi] = PARAM_BOUNDS[k];
    return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  });
}

export function getModelParams(): StructuralParams {
  const f = fitted as { fitted?: boolean; params?: unknown };
  return f.fitted && isValid(f.params) ? { ...DEFAULT_PARAMS, ...f.params } : { ...DEFAULT_PARAMS };
}

export function isUsingFittedParams(): boolean {
  const f = fitted as { fitted?: boolean; params?: unknown };
  return Boolean(f.fitted) && isValid(f.params);
}
