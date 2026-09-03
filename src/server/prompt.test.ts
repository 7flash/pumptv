import { expect, test } from "bun:test";
import type { ShotPlan } from "./prompt.ts";
import { sanitizeShotPlanForH3 } from "./prompt.ts";

const basePlan: ShotPlan = {
  premise: "Reveal the current BTC price to Jimothy.",
  transition: "Push toward the register.",
  action: "The register display shows 77594.91 while Jimothy leans closer.",
  continuity: "Stay in the same store.",
  camera: "Slow push-in.",
  visualDetails: "A receipt reading JIMOTHY curls beside the glowing display.",
  audio: "Register hum and room tone.",
  dialogue: "",
  endingBeat: "The screen shows $77,594.91 as Jimothy reacts.",
};

test("exact fact text is structurally removed from motion fields", () => {
  const plan = sanitizeShotPlanForH3({
    plan: basePlan,
    directive: "Reveal the current BTC price to Jimothy.",
    factOverlayText: "BTC $77,594.91",
    factKeyframeProvided: true,
  });

  const motion = [plan.action, plan.visualDetails, plan.endingBeat].join(" ");
  expect(motion).not.toContain("77594.91");
  expect(motion).not.toContain("77,594.91");
  expect(plan.visualDetails).not.toContain("JIMOTHY");
  expect(plan.action).toContain("Jimothy");
  expect(plan.endingBeat).toContain("supplied final keyframe");
});

test("explicit typography requests are preserved while exact facts stay final-frame only", () => {
  const plan = sanitizeShotPlanForH3({
    plan: {
      ...basePlan,
      visualDetails: "A receipt reading JIMOTHY slides from the printer.",
    },
    directive:
      "Print the word JIMOTHY on the receipt, then reveal the current BTC price.",
    factOverlayText: "BTC $77,594.91",
    factKeyframeProvided: true,
  });

  expect(plan.visualDetails).toContain("JIMOTHY");
  expect(plan.action).not.toContain("77594.91");
  expect(plan.endingBeat).not.toContain("77,594.91");
});
