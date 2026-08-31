export type PumpTVCodexConfig = {
  model: string;
  config: {
    model_reasoning_effort: string;
    sandbox_mode: string;
    approval_policy: string;
  };
};

/**
 * bgrun flattens [codex] keys from .config.toml to CODEX_* env vars.
 * JSX-AI receives this object directly in native Codex mode.
 */
export function getCodexConfig(): PumpTVCodexConfig {
  return {
    model: process.env.CODEX_MODEL || "gpt-5.6",
    config: {
      model_reasoning_effort:
        process.env.CODEX_MODEL_REASONING_EFFORT || "medium",
      sandbox_mode: process.env.CODEX_SANDBOX_MODE || "read-only",
      approval_policy: process.env.CODEX_APPROVAL_POLICY || "never",
    },
  };
}

export function codexCallOptions(extra: Record<string, unknown> = {}) {
  const codex = getCodexConfig();
  return {
    provider: "codex",
    model: codex.model,
    config: codex.config,
    ...extra,
  } as any;
}
