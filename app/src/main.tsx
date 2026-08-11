import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import { reportCrash } from './services/crashTelemetry';

window.onerror = function (message, source, lineno, colno, error) {
  console.error("Global JS Error:", message, "at", source, lineno + ":" + colno, error?.stack || error);
  reportCrash(error || new Error(String(message)), 'window');
  return false;
};

window.addEventListener("unhandledrejection", function (event) {
  console.error("Unhandled Promise Rejection:", event.reason, event.reason?.stack || event.reason);
  reportCrash(event.reason, 'promise');
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
