const MEMORY_UPDATE_PROMPT = `You are a memory management system. Your task is to analyze
  a conversation and update the user's memory profile.

  Current Memory State:
  <current_memory>
  {current_memory}
  </current_memory>

  New Conversation to Process:
  <conversation>
  {conversation}
  </conversation>

  Instructions:
  1. Analyze the conversation for important information about the user
  2. Extract relevant facts, preferences, and context
  3. Update the memory sections as needed

  Output Format (JSON):
  {
    "user": {
      "workContext": { "summary": "...", "shouldUpdate": true/false },
      "personalContext": { "summary": "...", "shouldUpdate": true/false },
      "topOfMind": { "summary": "...", "shouldUpdate": true/false }
    },
    "history": {
      "recentMonths": { "summary": "...", "shouldUpdate": true/false },
      "earlierContext": { "summary": "...", "shouldUpdate": true/false },
      "longTermBackground": { "summary": "...", "shouldUpdate": true/false }
    },
    "newFacts": [
      { "content": "...", "category":
  "preference|knowledge|context|behavior|goal|correction", "confidence": 0.0-1.0 }
    ],
    "factsToRemove": ["fact_id_1"]
  }

  Return ONLY valid JSON, no explanation.`;

const STALENESS_REVIEW_PROMPT = `## Staleness Review

  The following facts were created more than {age_days} days ago and may no longer
  accurately reflect the user's current situation.

  <stale_facts>
  {stale_facts}
  </stale_facts>

  For each fact, decide KEEP or REMOVE:
  - KEEP: Still likely valid
  - REMOVE: Outdated, contradicted by recent context, or no longer relevant

  Add REMOVE decisions to "staleFactsToRemove" in your output JSON.
  Each entry must be {"id": "fact_id", "reason": "brief explanation"}.

  Be conservative — when in doubt, KEEP.`;
export function buildMemoryUpdatePrompt(
    currentMemory: string,
    conversation: string
): string {
    return MEMORY_UPDATE_PROMPT
        .replace("{current_memory}", currentMemory)
        .replace("{conversation}", conversation)
        .replace("{correction_hint}", "")
        .replace("{staleness_review_section}", "")
        .replace("{consolidation_section}", "");
}