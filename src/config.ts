import type { ProcessorConfig } from "./types.js";

export interface ServiceConfig extends ProcessorConfig {
  port: number;
  apiKey: string;
}

/**
 * Hardcoded service constants. Tuned once, baked in — deliberately not
 * env vars or flags, so every run behaves identically. The only secret,
 * OPENROUTER_API_KEY, stays in the environment (never in code).
 */
export const PORT = 11434;
export const JEV_MODEL = "typesafe/jev-1.13";
export const CONFIDENCE_THRESHOLD = 0.8;
export const MAX_ITERATIONS = 3;
export const REQUEST_TIMEOUT_MS = 8000;

export function loadConfig(): ServiceConfig {
  return {
    port: PORT,
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    model: JEV_MODEL,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    maxIterations: MAX_ITERATIONS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    referer: `http://127.0.0.1:${PORT}/`,
  };
}
