type TransitionInput = {
  hasActiveQuestion: boolean;
  activeSourceId: string;
  sourceId: string;
  isFinal: boolean;
  alreadyRevisedSource: boolean;
  action: "wait" | "show" | "revise" | "keep";
  relation: string;
};

export function questionTransition(input: TransitionInput): "first" | "new" | "revision" | null {
  if (input.action !== "show" && input.action !== "revise") return null;
  if (!input.hasActiveQuestion) return "first";
  const sameSource = input.activeSourceId === input.sourceId;
  if (input.action === "show" && input.relation === "new" && !sameSource) return "new";
  if (input.action === "revise" && input.isFinal && !input.alreadyRevisedSource &&
      (sameSource || input.relation === "follow_up")) return "revision";
  return null;
}
