// Compared data, rather than display state, determines whether an output is current.
export function sourceRevision(memory, profile, summary) {
  return JSON.stringify([memory || null, profile?.updatedAt || "", profile?.corePrompt || "", summary?.version || ""]);
}
