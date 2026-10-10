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
  if (input.relation !== "new" && input.relation !== "follow_up") return null;
  const sameSource = input.activeSourceId === input.sourceId;
  // A follow-up is a new answer task even when it stays on the same topic.
  // Models may express it as either show or revise; neither may be discarded.
  if (!sameSource) return "new";
  // Rewording an already displayed source waits for the stable transcript once.
  if (input.isFinal && !input.alreadyRevisedSource) return "revision";
  return null;
}
