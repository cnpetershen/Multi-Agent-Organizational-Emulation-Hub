import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from './i18n';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Last-resort guard: it never swallows anything. The thrown error (message + stack)
 * is rendered verbatim so an unexpected render failure is visible in the browser
 * instead of blanking the console. Normal backend failures never reach this class —
 * they are caught earlier by the API contract layer and shown in the page banner.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[console] render failure', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="boundary" role="alert">
        <div className="card">
          <p className="eyebrow">{t('app.boundary.eyebrow')}</p>
          <h1>{t('app.boundary.title')}</h1>
          <p>{error.message}</p>
          <pre>{error.stack ?? error.message}</pre>
        </div>
      </div>
    );
  }
}
