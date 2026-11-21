import React, { useState } from 'react';
import type { MomentumPoint } from '../types/soccer';

interface MomentumChartProps {
  timeline: MomentumPoint[];
  homeTeam: string;
  awayTeam: string;
}

export const MomentumChart: React.FC<MomentumChartProps> = ({
  timeline,
  homeTeam,
  awayTeam,
}) => {
  const [hoveredMinute, setHoveredMinute] = useState<number | null>(null);

  if (!timeline || timeline.length < 2) {
    return (
      <div className="h-44 flex items-center justify-center border border-white/8 rounded-lg bg-[#0E141F] text-xs text-slate-400">
        Pre-match state — minute-by-minute Attack Momentum bars populate once kickoff telemetry arrives.
      </div>
    );
  }

  const totalMinutes = Math.max(90, timeline[timeline.length - 1].minute);
  const maxAbs = Math.max(6, ...timeline.map((p) => Math.abs(p.netMomentum)));

  const width = 760;
  const height = 188;
  const padLeft = 18;
  const padRight = 18;
  const padTop = 26;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const midY = padTop + (height - padTop - padBottom) / 2;
  const maxBarH = (height - padTop - padBottom) / 2 - 4;

  const slotW = plotW / totalMinutes;
  const barW = Math.max(2.2, slotW * 0.72);
  const toX = (minute: number) => padLeft + (minute - 0.5) * slotW;
  const htX = padLeft + 45 * slotW;

  const hoveredPoint =
    hoveredMinute !== null
      ? timeline.find((p) => p.minute === hoveredMinute) || null
      : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span className="font-medium text-emerald-400 truncate max-w-[38%]">
          ▲ {homeTeam}
        </span>
        <span className="font-mono tabular-nums text-slate-400 text-[11px]">
          {hoveredPoint
            ? `${hoveredPoint.minute}' · Net ${
                hoveredPoint.netMomentum >= 0 ? '+' : ''
              }${hoveredPoint.netMomentum.toFixed(2)}${
                hoveredPoint.eventNote ? ` · ${hoveredPoint.eventNote}` : ''
              }`
            : `Attack Momentum · Scale ±${maxAbs.toFixed(0)}`}
        </span>
        <span className="font-medium text-sky-400 truncate max-w-[38%] text-right">
          ▼ {awayTeam}
        </span>
      </div>

      <div className="border border-white/8 rounded-lg bg-[#0E141F] p-2 overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-44 block select-none"
          role="img"
          aria-label={`Attack momentum histogram comparing ${homeTeam} and ${awayTeam}`}
          onMouseLeave={() => setHoveredMinute(null)}
        >
          {/* Subtle upper/lower zone tint */}
          <rect
            x={padLeft}
            y={padTop}
            width={plotW}
            height={maxBarH + 4}
            fill="rgba(16, 185, 129, 0.03)"
          />
          <rect
            x={padLeft}
            y={midY}
            width={plotW}
            height={maxBarH + 4}
            fill="rgba(56, 189, 248, 0.03)"
          />

          {/* Halftime 45' vertical divider */}
          <line
            x1={htX}
            y1={padTop}
            x2={htX}
            y2={height - padBottom}
            stroke="rgba(148, 163, 184, 0.22)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />

          {/* Zero baseline */}
          <line
            x1={padLeft}
            y1={midY}
            x2={width - padRight}
            y2={midY}
            stroke="rgba(148, 163, 184, 0.35)"
            strokeWidth="1"
          />

          {/* Minute-by-minute Sofascore-style mirrored bars */}
          {timeline.map((pt) => {
            const x = toX(pt.minute) - barW / 2;
            const norm = Math.min(1, Math.abs(pt.netMomentum) / maxAbs);
            const barH = Math.max(2, norm * maxBarH);
            const isHome = pt.netMomentum >= 0;
            const y = isHome ? midY - barH : midY;
            const isHovered = hoveredMinute === pt.minute;

            return (
              <g
                key={pt.minute}
                onMouseEnter={() => setHoveredMinute(pt.minute)}
                className="cursor-crosshair"
              >
                {/* Invisible full-height hit target for smooth minute hover */}
                <rect
                  x={padLeft + (pt.minute - 1) * slotW}
                  y={padTop}
                  width={slotW}
                  height={height - padTop - padBottom}
                  fill="transparent"
                />

                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={barH}
                  rx="1"
                  fill={isHome ? '#10B981' : '#38BDF8'}
                  fillOpacity={isHovered ? 1 : 0.85}
                />

                {/* Goal & Red Card pins on top (Home) or bottom (Away) rail */}
                {pt.majorEvents?.map((ev, idx) => {
                  const cx = toX(pt.minute);
                  const cy = ev.side === 'home' ? padTop - 10 : height - padBottom + 10;
                  if (ev.type === 'goal') {
                    return (
                      <g key={`${pt.minute}_g_${idx}`}>
                        <circle
                          cx={cx}
                          cy={cy}
                          r="4.5"
                          fill={ev.side === 'home' ? '#10B981' : '#38BDF8'}
                          stroke="#0B0F17"
                          strokeWidth="1.5"
                        />
                      </g>
                    );
                  }
                  return (
                    <rect
                      key={`${pt.minute}_r_${idx}`}
                      x={cx - 3}
                      y={cy - 4.5}
                      width="6"
                      height="9"
                      rx="1"
                      fill="#EF4444"
                    />
                  );
                })}
              </g>
            );
          })}

          {/* Axis Labels: 0', HT, 90' */}
          <text
            x={padLeft}
            y={height - 6}
            textAnchor="start"
            fill="#64748B"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            0&apos;
          </text>
          <text
            x={htX}
            y={height - 6}
            textAnchor="middle"
            fill="#94A3B8"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            HT
          </text>
          <text
            x={width - padRight}
            y={height - 6}
            textAnchor="end"
            fill="#64748B"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            {totalMinutes}&apos;
          </text>
        </svg>
      </div>
    </div>
  );
};
