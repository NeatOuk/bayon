import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "@/theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "@/login/auth-gate";
import { Shell } from "@/shell";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <AuthGate>{(onLogout) => <Shell onLogout={onLogout} />}</AuthGate>
  </StrictMode>,
);
