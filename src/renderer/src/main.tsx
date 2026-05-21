import React, { Component, type ErrorInfo, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'

class RootErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { err: null }
  }

  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err }
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    console.error(err, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.err) {
      return (
        <div
          style={{
            padding: 24,
            maxWidth: 560,
            margin: '40px auto',
            fontFamily: 'Segoe UI, system-ui, sans-serif',
            color: '#e8ebf7',
            background: '#12141a',
            borderRadius: 12,
            border: '1px solid #242836'
          }}
        >
          <h1 style={{ margin: '0 0 12px', fontSize: 18 }}>Model Forge could not start</h1>
          <p style={{ margin: '0 0 8px', color: '#9aa3bd', fontSize: 14 }}>
            The UI hit an error. Open DevTools (Ctrl+Shift+I) for the console, or share this message:
          </p>
          <pre
            style={{
              margin: 0,
              padding: 12,
              fontSize: 12,
              overflow: 'auto',
              background: '#0c0d10',
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}
          >
            {this.state.err.message}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)
