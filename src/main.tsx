import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Global error tracking — captures unhandled exceptions and promise
// rejections so they don't silently vanish. Logs structured data to
// the console for debugging; a future iteration can POST to an
// external service (Sentry, LogFlare, etc.).
window.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
  console.error('[CRM] Unhandled promise rejection:', {
    message: msg,
    stack: event.reason instanceof Error ? event.reason.stack : undefined,
    timestamp: new Date().toISOString(),
  });
});

window.addEventListener('error', (event) => {
  console.error('[CRM] Uncaught error:', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    timestamp: new Date().toISOString(),
  });
});

createRoot(document.getElementById("root")!).render(<App />);
