"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("vantage-theme-change", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("vantage-theme-change", listener);
  };
}

function getTheme() {
  return localStorage.getItem("vantage.theme") === "light";
}

export function ThemeToggle() {
  const light = useSyncExternalStore(subscribe, getTheme, () => false);
  useEffect(() => {
    document.documentElement.classList.toggle("light", light);
  }, [light]);
  return (
    <button
      aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
      title={light ? "Switch to dark theme" : "Switch to light theme"}
      onClick={() => {
        const next = !light;
        localStorage.setItem("vantage.theme", next ? "light" : "dark");
        window.dispatchEvent(new Event("vantage-theme-change"));
      }}
      className="grid size-7 place-items-center rounded border border-[var(--border)] text-slate-400 hover:text-white"
    >
      {light ? <Moon size={13} /> : <Sun size={13} />}
    </button>
  );
}
