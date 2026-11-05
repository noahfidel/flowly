import { describe, expect, it } from "vitest";
import { agentModelFromValues, agentModelSchema, effectiveAgentModel, providerBase, quickTaskMode, startingAgent, suggestedMode, suggestedThinking } from "./agent-defaults";

const claude = { provider: "claude", model: "claude-sonnet-5-5", thinking: "high" };
const codex = { provider: "codex", model: "gpt-6-luna" };

describe("effective model default", () => {
  it("prefers the project's default over the global one", () => {
    expect(effectiveAgentModel({ agentModel: claude }, codex)).toEqual({ model: claude, source: "project" });
  });
  it("falls back to the global default, then to nothing", () => {
    expect(effectiveAgentModel({}, codex)).toEqual({ model: codex, source: "global" });
    expect(effectiveAgentModel(null, codex)).toEqual({ model: codex, source: "global" });
    expect(effectiveAgentModel({ agentModel: undefined }, null)).toBeNull();
  });
});

describe("startingAgent", () => {
  const last = { provider: "claude", model: "claude-haiku-5-5", mode: "plan", thinking: "low" };
  it("keeps the latest session when no default is chosen", () => {
    expect(startingAgent(last, null)).toBe(last);
    expect(startingAgent(null, null)).toBeNull();
  });
  it("replaces provider, model and reasoning; keeps the mode only for the same provider", () => {
    expect(startingAgent(last, claude)).toEqual({ provider: "claude", model: "claude-sonnet-5-5", mode: "plan", thinking: "high", speed: undefined });
    // Unset mode ("") and speed (undefined) get the picker's suggestion.
    expect(startingAgent(last, codex)).toEqual({ provider: "codex", model: "gpt-6-luna", mode: "", thinking: "", speed: undefined });
    expect(startingAgent(null, codex)).toEqual({ provider: "codex", model: "gpt-6-luna", mode: "", thinking: "", speed: undefined });
  });
  it("keeps the latest session's speed only for the same provider", () => {
    expect(startingAgent({ ...last, speed: "fast" }, claude)?.speed).toBe("fast");
    expect(startingAgent({ ...last, speed: "fast" }, codex)?.speed).toBeUndefined();
    expect(startingAgent({ ...last, speed: "" }, claude)?.speed).toBe("");
  });
  it("uses the default's own permission mode over the latest session's", () => {
    expect(startingAgent(last, { ...claude, mode: "acceptEdits" })?.mode).toBe("acceptEdits");
    expect(startingAgent(null, { ...codex, mode: "full-access" })?.mode).toBe("full-access");
  });
});

describe("stored values", () => {
  it("builds a model only when provider and model are both set", () => {
    expect(agentModelFromValues({ defaultProvider: "claude", defaultModel: "m", defaultThinking: "" })).toEqual({ provider: "claude", model: "m" });
    expect(agentModelFromValues({ defaultProvider: "claude", defaultModel: "m", defaultThinking: "high" })).toEqual({ provider: "claude", model: "m", thinking: "high" });
    expect(agentModelFromValues({ defaultProvider: "claude", defaultModel: "m", defaultMode: "plan" })).toEqual({ provider: "claude", model: "m", mode: "plan" });
    expect(agentModelFromValues({ defaultProvider: "claude", defaultModel: "" })).toBeNull();
    expect(agentModelFromValues({})).toBeNull();
    expect(agentModelFromValues(undefined)).toBeNull();
  });
  it("rejects incomplete or unknown fields in the project's model", () => {
    expect(agentModelSchema.safeParse({ provider: "claude" }).success).toBe(false);
    expect(agentModelSchema.safeParse({ provider: "claude", model: "m", extra: 1 }).success).toBe(false);
    expect(agentModelSchema.safeParse(claude).success).toBe(true);
  });
});

it("suggests automatic approval and preserves explicit permissions", () => {
 expect(suggestedMode("claude")).toBe("auto");
 expect(suggestedMode("codex")).toBe("auto-review");
 expect(suggestedMode("codex", "full-access")).toBe("full-access");
 expect(suggestedMode("claude", "plan")).toBe("plan");
 expect(suggestedMode("other")).toBe("");
});

describe("providerBase", () => {
  const claudeModes = ["plan", "default", "acceptEdits", "auto", "bypassPermissions"];
  const codexModes = ["auto", "auto-review", "full-access"];
  it("keeps the built-in providers, also before their modes are known", () => {
    expect(providerBase("claude")).toBe("claude");
    expect(providerBase("codex", [])).toBe("codex");
  });
  it("recognises custom providers by their base's permission modes", () => {
    expect(providerBase("codex-connected", codexModes)).toBe("codex");
    expect(providerBase("claude-connected", claudeModes)).toBe("claude");
    expect(providerBase("my-glm", claudeModes)).toBe("claude");
    expect(suggestedMode(providerBase("codex-connected", codexModes))).toBe("auto-review");
    expect(suggestedMode(providerBase("claude-glm-fast", claudeModes))).toBe("auto");
  });
  it("leaves other providers and unknown modes alone", () => {
    expect(providerBase("codex-connected")).toBe("codex-connected");
    expect(providerBase("opencode", ["build", "plan"])).toBe("opencode");
    expect(suggestedMode(providerBase("opencode", ["auto"]))).toBe("");
  });
});

describe("suggestedThinking", () => {
  const ids = (...list: string[]) => list.map((id) => ({ id }));
  it("suggests Extra High when the model offers it, for any provider", () => {
    expect(suggestedThinking(ids("low", "medium", "high", "xhigh", "max", "ultracode"))).toBe("xhigh");
    expect(suggestedThinking(ids("low", "medium", "high", "xhigh", "max", "ultra"))).toBe("xhigh");
  });
  it("keeps the model's own default when Extra High is not offered", () => {
    expect(suggestedThinking(ids("low", "medium", "high", "max"))).toBe("");
    expect(suggestedThinking([])).toBe("");
    expect(suggestedThinking()).toBe("");
  });
});

describe("quickTaskMode", () => {
  it("defaults to plan when the provider offers it", () => {
    expect(quickTaskMode({ provider: "claude", modeIds: ["default", "plan", "auto"] })).toBe("plan");
    expect(quickTaskMode({ provider: "my-glm", modeIds: ["acceptEdits", "bypassPermissions", "plan"] })).toBe("plan");
  });
  it("keeps the usual suggestion without a plan mode, or while the modes are unknown", () => {
    expect(quickTaskMode({ provider: "codex", modeIds: ["read-only", "auto-review"] })).toBe("auto-review");
    expect(quickTaskMode({ provider: "claude" })).toBe("auto");
    expect(quickTaskMode({ provider: "opencode", modeIds: ["build"] })).toBe("");
  });
  it("lets an explicit pick win, even a mode that is not plan", () => {
    expect(quickTaskMode({ provider: "claude", modeIds: ["plan", "auto"], explicit: "auto" })).toBe("auto");
    expect(quickTaskMode({ provider: "claude", modeIds: ["plan"], explicit: "" })).toBe("");
  });
});
