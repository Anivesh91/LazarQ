"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { SystemHealth } from "./types";

const HEALTH_REFRESH_MS = 15_000;

let cachedHealth: SystemHealth | null = null;
let cachedAt = 0;
let inFlightHealth: Promise<SystemHealth> | null = null;
const listeners = new Set<(health: SystemHealth) => void>();

function notifyListeners(health: SystemHealth) {
  cachedHealth = health;
  cachedAt = Date.now();
  listeners.forEach((listener) => listener(health));
}

async function fetchSharedHealth(force = false): Promise<SystemHealth> {
  if (!force && cachedHealth && Date.now() - cachedAt < 5_000) {
    return cachedHealth;
  }

  if (inFlightHealth) {
    return inFlightHealth;
  }

  inFlightHealth = api
    .getHealth()
    .catch(
      (): SystemHealth => ({
        status: "degraded",
        redis: "error",
        database: "error",
        timestamp: new Date().toISOString(),
      })
    )
    .then((result) => {
      notifyListeners(result);
      return result;
    })
    .finally(() => {
      inFlightHealth = null;
    });

  return inFlightHealth;
}

export function useSystemHealth() {
  const [health, setHealth] = useState<SystemHealth | null>(() => cachedHealth);

  useEffect(() => {
    listeners.add(setHealth);
    void fetchSharedHealth(false);

    const interval = setInterval(() => {
      void fetchSharedHealth(true);
    }, HEALTH_REFRESH_MS);

    return () => {
      listeners.delete(setHealth);
      clearInterval(interval);
    };
  }, []);

  const refreshHealth = useCallback(() => fetchSharedHealth(true), []);

  return { health, refreshHealth };
}
