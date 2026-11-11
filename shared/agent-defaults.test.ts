import { describe, expect, it } from "vitest";
import { agentModelFromValues, agentModelSchema, chosenThinking, effectiveAgentModel, effectiveDispatcherModel, pickerSeed, providerBase, quickTaskMode, startingAgent, suggestedMode } from "./agent-defaults";
import { dispatcherDefaultModel } from "./dispatcher";

const claude = { provider: "claude", model: "claude-sonnet-5-5", thinking: "high" };
const codex = { provider: "codex", model: "gpt-6-luna" };

describe("dispatcher model (DISPATCHER-SPEC §0, §3)", () => {
  const opus = { provider: "claude", model: "claude-opus-5-5", mode: "default" };
  it("prefers the group's default, then the host setting, then the server default", () => {
    expect(effectiveDispatcherModel({ defaults: { dispatcherModel: opus } }, claude)).toEqual(opus);
    expect(effectiveDispatcherModel({ defaults: {} }, claude)).toEqual(claude);
    expect(effectiveDispatcherModel({ defaults: { dispatcherModel: null } }, claude)).toEqual(claude);
    expect(effectiveDispatcherModel({}, null)).toEqual(dispatcherDefaultModel);
    expect(effectiveDispatcherModel(undefined, undefined)).toEqual(dispatcherDefaultModel);
  });
  it("passes a group's other provider through: the start refuses it, not the chain", () => {
    expect(effectiveDispatcherModel({ defaults: { dispatcherModel: codex } }, claude)).toEqual(codex);
  });
});

describe("effective model default", () => {
  const opus = { provider: "claude", model: "claude-opus-5-5" };
  it("prefers the project's default over the group's and the global one", () => {
    expect(effectiveAgentModel({ agentModel: claude }, { defaults: { agentModel: opus } }, codex)).toEqual({ model: claude, source: "project" });
    expect(effectiveAgentModel({ agentModel: claude }, null, codex)).toEqual({ model: claude, source: "project" });
  });
  it("uses the group's default when the project has none, before the global one", () => {
    expect(effectiveAgentModel({}, { defaults: { agentModel: opus } }, codex)).toEqual({ model: opus, source: "group" });
    expect(effectiveAgentModel(null, { defaults: { agentModel: opus } }, null)).toEqual({ model: opus, source: "group" });
  });
  it("falls back to the global default, then to nothing", () => {
    expect(effectiveAgentModel({}, {}, codex)).toEqual({ model: codex, source: "global" });
    expect(effectiveAgentModel(null, { defaults: {} }, codex)).toEqual({ model: codex, source: "global" });
    expect(effectiveAgentModel({}, undefined, codex)).toEqual({ model: codex, source: "global" });
    expect(effectiveAgentModel({ agentModel: undefined }, null, null)).toBeNull();
  });
});

describe("startingAgent", () => {
  it("starts from nothing when no default is set: never from an earlier session", () => {
    expect(startingAgent(null)).toBeNull();
    expect(startingAgent(undefined)).toBeNull();
  });
  it("takes provider, model, reasoning and mode from the default; no speed", () => {
    expect(startingAgent(claude)).toEqual({ provider: "claude", model: "claude-sonnet-5-5", mode: "", thinking: "high", speed: undefined });
    // Unset mode ("") gets the picker's suggestion; unset reasoning ("") is the model's own default.
    expect(startingAgent(codex)).toEqual({ provider: "codex", model: "gpt-6-luna", mode: "", thinking: "", speed: undefined });
    expect(startingAgent({ ...codex, mode: "full-access" })?.mode).toBe("full-access");
  });
});

describe("pickerSeed (the form's first choice)", () => {
  it("leaves provider and model empty with no default", () => {
    expect(pickerSeed(null)).toEqual({ provider: "", model: "", mode: undefined, thinking: undefined, speed: undefined });
    expect(pickerSeed(undefined).provider).toBe("");
  });
  it("seeds a resolved default", () => {
    expect(pickerSeed(startingAgent(claude))).toEqual({ provider: "claude", model: "claude-sonnet-5-5", mode: undefined, thinking: "high", speed: undefined });
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

describe("chosenThinking", () => {
  const ids = (...list: string[]) => list.map((id) => ({ id }));
  it("keeps the model's own default when no reasoning is chosen, even when Extra High is offered", () => {
    expect(chosenThinking(undefined, ids("low", "medium", "high", "xhigh", "max"))).toBe("");
    expect(chosenThinking("", ids("low", "xhigh"))).toBe("");
  });
  it("uses a chosen reasoning the model offers, else the model default", () => {
    expect(chosenThinking("high", ids("low", "high", "xhigh"))).toBe("high");
    expect(chosenThinking("xhigh", ids("low", "high"))).toBe("");
    expect(chosenThinking("high", [])).toBe("");
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
