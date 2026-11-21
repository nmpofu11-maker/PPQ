import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || 'An unexpected application error occurred.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-[#131A26] border border-red-500/30 rounded-xl p-6 space-y-4">
            <h1 className="text-lg font-semibold text-red-400">
              Runtime Protection Triggered
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed">
              {this.state.errorMessage}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-xs font-medium bg-slate-100 text-slate-900 rounded-lg hover:bg-white transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
