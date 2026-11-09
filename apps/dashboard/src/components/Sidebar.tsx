"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  AlertOctagon,
  BookOpen,
  LogOut,
  Radio,
  Sliders,
  Sparkles,
  Zap,
} from "lucide-react";
import { ConnectionStatus } from "../lib/use-sse";
import { useSystemHealth } from "../lib/use-health";

interface SidebarProps {
  sseStatus?: ConnectionStatus;
  pendingApprovalsCount?: number;
}

export function Sidebar({
  sseStatus = "connecting",
  pendingApprovalsCount = 0,
}: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { health } = useSystemHealth();
  const [authEnabled, setAuthEnabled] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/operator/session", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { authEnabled?: boolean } | null) => {
        if (active && data?.authEnabled) {
          setAuthEnabled(true);
        }
      })
      .catch(() => {
        // Ignore session discovery failures when offline
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSignOut = async () => {
    try {
      setSigningOut(true);
      await fetch("/api/operator/session", { method: "DELETE" });
      router.replace("/login");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  };

  const doctorModelLabel =
    health?.llmModel ||
    (health === null ? "Checking model..." : "Engine offline");

  const navItems = [
    {
      name: "Cockpit Overview",
      href: "/",
      icon: Activity,
    },
    {
      name: "Incidents Vault",
      href: "/incidents",
      icon: AlertOctagon,
      badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : undefined,
    },
    {
      name: "Runbook Studio",
      href: "/runbooks",
      icon: BookOpen,
    },
    {
      name: "System & Breaker",
      href: "/system",
      icon: Sliders,
    },
  ];

  return (
    <aside className="w-64 border-r border-slate-800/80 bg-slate-950/80 backdrop-blur-xl flex flex-col justify-between h-screen sticky top-0 shrink-0">
      <div>
        {/* Brand Header */}
        <div className="p-6 border-b border-slate-900/90 flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-cyan-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-white text-base tracking-tight">
                LazarQ
              </span>
              <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/60">
                v1.0
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-medium">
              Autonomous Queue Recovery
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="p-4 space-y-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);

            return (
              <Link
                key={item.name}
                href={item.href}
                className={`flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-slate-800/90 text-white border border-slate-700/60 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/60"
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon
                    className={`h-4 w-4 ${
                      isActive ? "text-cyan-400" : "text-slate-400"
                    }`}
                  />
                  <span>{item.name}</span>
                </div>
                {item.badge !== undefined && (
                  <span className="px-1.5 py-0.5 text-xs font-semibold rounded-full bg-amber-500/20 text-amber-300 border border-amber-600/40">
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Footer System Status & SSE Indicator */}
      <div className="p-4 border-t border-slate-900/90 space-y-3">
        {/* SSE Live Status Pill */}
        <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800/80">
          <div className="flex items-center gap-2">
            <Radio
              className={`h-3.5 w-3.5 ${
                sseStatus === "connected"
                  ? "text-emerald-400 animate-pulse"
                  : sseStatus === "connecting"
                  ? "text-amber-400 animate-spin"
                  : "text-rose-400"
              }`}
            />
            <span className="text-xs text-slate-300 font-medium">
              Live SSE Feed
            </span>
          </div>
          <span
            className={`h-2 w-2 rounded-full ${
              sseStatus === "connected"
                ? "bg-emerald-400 shadow-[0_0_8px_#34d399]"
                : sseStatus === "connecting"
                ? "bg-amber-400"
                : "bg-rose-400"
            }`}
          />
        </div>

        {/* AI Doctor Badge */}
        <div className="px-3 py-2 rounded-lg bg-indigo-950/20 border border-indigo-900/40 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
          <span
            className="text-[11px] text-indigo-300 font-medium truncate"
            title={doctorModelLabel}
          >
            Doctor: {doctorModelLabel}
          </span>
        </div>

        {/* Sign Out Button (shown when operator session auth is enabled) */}
        {authEnabled && (
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-slate-900/80 hover:bg-rose-950/50 border border-slate-800 hover:border-rose-900/60 text-xs font-medium text-slate-300 hover:text-rose-200 transition-colors disabled:opacity-50"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>{signingOut ? "Signing out..." : "Sign Out"}</span>
          </button>
        )}
      </div>
    </aside>
  );
}
