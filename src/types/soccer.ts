export type MatchLifecycleState = 'pre' | 'in' | 'post';

export type MatchEventType =
  | 'goal'
  | 'shot_on_target'
  | 'shot_off_target'
  | 'corner'
  | 'foul'
  | 'yellow_card'
  | 'red_card'
  | 'save'
  | 'substitution'
  | 'kickoff'
  | 'halftime'
  | 'fulltime'
  | 'other';

export interface MatchEventItem {
  id: string;
  minute: number;
  clockDisplay: string;
  sequence: number;
  teamSide: 'home' | 'away' | 'neutral';
  teamName?: string;
  eventType: MatchEventType;
  text: string;
}

export interface TeamMatchStats {
  possessionPct: number | null;
  totalShots: number;
  shotsOnTarget: number;
  wonCorners: number;
  foulsCommitted: number;
  yellowCards: number;
  redCards: number;
  offsides: number;
  saves: number;
  /** Form index in [-1, 1] derived strictly from real scraped lastFiveGames */
  formScore: number | null;
  lastFiveSummary: string[];
}

export interface ScrapedOdds {
  provider: string;
  isLive: boolean;
  homeMoneyline: string | null;
  drawMoneyline: string | null;
  awayMoneyline: string | null;
  totalLine: number | null;
  overOdds: string | null;
  underOdds: string | null;
  spreadLine: number | null;
  homeSpreadOdds: string | null;
  awaySpreadOdds: string | null;
}

export interface ScrapedMatch {
  id: string;
  league: string;
  leagueSlug: string;
  startDate: string;
  state: MatchLifecycleState;
  minute: number;
  statusText: string;
  venue: string | null;
  homeTeam: string;
  homeAbbr: string;
  awayTeam: string;
  awayAbbr: string;
  homeScore: number;
  awayScore: number;
  homeStats: TeamMatchStats;
  awayStats: TeamMatchStats;
  events: MatchEventItem[];
  hasDetailedFlow: boolean;
  bbcCrossCheck: {
    matched: boolean;
    scoreLabel: string | null;
  };
  /**
   * Scraped market odds stored strictly for post-prediction +EV comparison.
   * NEVER passed into predictMatchMarkets() or computeMomentumTimeline().
   */
  scrapedOdds: ScrapedOdds | null;
  lastUpdated: string;
}

/**
 * Odds-free match snapshot used exclusively by the pure-flow prediction math.
 * By TypeScript contract, scrapedOdds cannot exist on this type.
 */
export interface OddsFreeMatchSnapshot {
  id: string;
  league: string;
  state: MatchLifecycleState;
  minute: number;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  homeStats: TeamMatchStats;
  awayStats: TeamMatchStats;
  events: MatchEventItem[];
}

export interface MomentumPoint {
  minute: number;
  homeMomentum: number;
  awayMomentum: number;
  netMomentum: number;
  eventNote?: string;
  majorEvents?: {
    type: 'goal' | 'red_card';
    side: 'home' | 'away';
    text: string;
  }[];
}

export interface OverUnderLineProb {
  line: number;
  overProb: number;
  underProb: number;
}

export interface AsianHandicapProb {
  line: number; // home perspective e.g. -0.5 means home -0.5
  homeCoverProb: number;
  awayCoverProb: number;
  pushProb: number;
}

export interface PureFlowPrediction {
  matchId: string;
  snapshotMinute: number;
  homeLambdaRem: number;
  awayLambdaRem: number;
  homeMomentum: number;
  awayMomentum: number;
  netMomentum: number;
  dominantSide: 'home' | 'away' | 'balanced';
  momentumTimeline: MomentumPoint[];
  markets: {
    winner1X2: {
      homeProb: number;
      drawProb: number;
      awayProb: number;
    };
    drawNoBet: {
      homeProb: number;
      awayProb: number;
    };
    nextTeamToScore: {
      homeProb: number;
      awayProb: number;
      noGoalProb: number;
    };
    overUnder: OverUnderLineProb[];
    doubleChance: {
      homeOrDrawProb: number; // 1X
      awayOrDrawProb: number; // X2
      homeOrAwayProb: number; // 12
    };
    asianHandicap: AsianHandicapProb[];
  };
  evidenceReasons: string[];
}

export type MarketCategory =
  | 'Match Winner (1X2)'
  | 'Over / Under Goals'
  | 'Asian Handicap / Spread'
  | 'Double Chance'
  | 'Next Team to Score';

export interface ValueAlert {
  id: string;
  matchId: string;
  league: string;
  matchTitle: string;
  state: MatchLifecycleState;
  minute: number;
  scoreline: string;
  market: MarketCategory;
  selection: string;
  modelProbability: number;
  fairDecimalOdds: number;
  bookmakerOddsAmerican: string;
  bookmakerOddsDecimal: number;
  impliedProbability: number;
  evPct: number;
  kellyFractionPct: number;
  isLiveOdds: boolean;
  oddsVerifiedLive: boolean;
  oddsSourceNote: string;
  provider: string;
  evidenceSummary: string;
  confidenceTier: 'Strong Edge' | 'Moderate Edge' | 'Watch';
}

export interface GlobalModelWeights {
  momentumSensitivity: number;
  shotOnTargetWeight: number;
  possessionWeight: number;
  cornerPressureWeight: number;
  baseTempoBias: number;
  homeAdvantageBase: number;
}

export interface TeamLearnedCoefficients {
  sample_size_matches: number;
  learned_coefficients: {
    home_advantage_multiplier: number;
    form_momentum_weight: number;
    volatility_index: number;
    fatigue_penalty_modifier: number;
  };
}

export interface AuditLogEntry {
  id: string;
  matchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  finalScore: string;
  snapshotMinute: number;
  snapshotSource?: 'exact_live_capture' | 'causal_reconstruction';
  market: string;
  selection: string;
  modelProbability: number;
  impliedProbability?: number;
  evPct?: number;
  actualOutcome: string;
  isCorrect: boolean;
  brierScore: number;
  createdAt: string;
}

export interface ModelMetrics {
  totalEvaluated: number;
  correctPredictions: number;
  cumulativeBrier: number;
  cumulativeLogLoss: number;
  meanBrierScore: number | null;
  meanLogLoss: number | null;
  accuracyPct: number | null;
}

export interface ModelIntelligencePayload {
  sync_timestamp: string;
  model_engine: string;
  meta_improvement_notes: string;
  globalWeights: GlobalModelWeights;
  metrics: ModelMetrics;
  team_intelligence_matrices: Record<string, TeamLearnedCoefficients>;
  recentAudits: AuditLogEntry[];
}

export type PaperBetStatus = 'open' | 'won' | 'lost' | 'push';

export interface PaperBetRecord {
  id: string;
  matchId: string;
  league: string;
  matchTitle: string;
  homeTeam: string;
  awayTeam: string;
  minutePlaced: number;
  scoreAtPlacement: string;
  market: MarketCategory;
  selection: string;
  confidenceTier: ValueAlert['confidenceTier'];
  modelProbability: number;
  bookmakerOddsDecimal: number;
  bookmakerOddsAmerican: string;
  evPct: number;
  stakeUnits: number;
  oddsVerifiedLive: boolean;
  status: PaperBetStatus;
  finalScore: string | null;
  profitUnits: number;
  placedAt: string;
  settledAt: string | null;
}

export interface PaperLedgerSummary {
  totalBets: number;
  openBets: number;
  settledBets: number;
  wins: number;
  losses: number;
  pushes: number;
  hitRatePct: number | null;
  totalStakedUnits: number;
  netProfitUnits: number;
  roiPct: number | null;
  maxDrawdownUnits: number;
  strongTierProfitUnits: number;
  strongTierBets: number;
  moderateTierProfitUnits: number;
  moderateTierBets: number;
  equityCurve: { index: number; label: string; cumulativeProfit: number }[];
}

export interface LiveCapturedSnapshot {
  id: string;
  matchId: string;
  milestoneMinute: 30 | 45 | 60 | 75;
  capturedMinute: number;
  snapshot: OddsFreeMatchSnapshot;
  netMomentum: number;
  capturedAt: string;
}

export type AlertScopeMode = 'all' | 'watchlist' | 'top_leagues';

export type TrendPatternType =
  | 'Persistent Attack Surge'
  | 'Shots-on-Goal Barrage'
  | 'Set-Piece Siege'
  | 'Manpower Counter-Press';

export interface DetectedTrendSignal {
  id: string;
  matchId: string;
  league: string;
  matchTitle: string;
  minute: number;
  scoreline: string;
  teamSide: 'home' | 'away';
  teamName: string;
  patterns: TrendPatternType[];
  patternLabel: string;
  windowMinutes: number;
  recentShots: number;
  recentShotsOnTarget: number;
  recentCorners: number;
  consecutiveMomentumMinutes: number;
  intensityScore: number;
  recommendedMarket: MarketCategory;
  recommendedSelection: string;
  modelProbability: number;
  recentCommentary: string[];
}

export interface TacticalAiBrief {
  trendId: string;
  matchId: string;
  tacticalVerdict: 'High-Conviction Attack' | 'Sustained Pressure' | 'Low-Danger Possession';
  bestMarketPick: string;
  dangerQualitySummary: string;
  keyRiskFactor: string;
  generatedAt: string;
  modelUsed: string;
}
