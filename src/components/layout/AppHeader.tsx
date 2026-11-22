export type ActiveTab = 'radar' | 'alerts' | 'learning' | 'methodology';

const TABS: { id: ActiveTab; label: string; short: string }[] = [
  { id: 'radar', label: 'Live Radar', short: 'Radar' },
  { id: 'alerts', label: 'Value Alerts', short: 'Alerts' },
  { id: 'learning', label: 'Model Learning', short: 'Learning' },
  { id: 'methodology', label: 'Methodology', short: 'Math' },
];

export function AppHeader(props: {
  activeTab: ActiveTab;
  onChangeTab: (tab: ActiveTab) => void;
  alertCount: number;
  isLoading: boolean;
  onRefresh: () => void;
}) {
  const { activeTab, onChangeTab, alertCount, isLoading, onRefresh } = props;
  const label = (t: (typeof TABS)[number], short: boolean) =>
    t.id === 'alerts' ? `${short ? t.short : t.label} (${alertCount})` : short ? t.short : t.label;

  return (
    <>
      <header className="border-b border-white/8 bg-[#0E141F] px-6 py-3.5 flex items-center justify-between gap-8">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            onChangeTab('radar');
          }}
          className="text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          PitchPulse Quant
        </a>

        <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-6 text-sm font-medium">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onChangeTab(t.id)}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === t.id
                  ? 'border-emerald-400 text-white'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {label(t, false)}
            </button>
          ))}
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {isLoading ? 'Scraping...' : 'Refresh Scrape'}
          </button>
        </div>
      </header>

      <div className="md:hidden border-b border-white/8 bg-[#0E141F] px-3 py-2 grid grid-cols-4 gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onChangeTab(t.id)}
            className={`px-1.5 py-1.5 text-[11px] font-medium rounded-md text-center truncate whitespace-nowrap ${
              activeTab === t.id ? 'bg-[#1F293B] text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label(t, true)}
          </button>
        ))}
      </div>
    </>
  );
}
