export function extractJsonBlock(raw: string): any {
  const input = raw.trim();
  let firstErrorMessage = "Unknown error";

  // Attempt 1: Try direct parse
  try {
    return JSON.parse(input);
  } catch (e1: unknown) {
    // FIX: Type guard to check if it's an Error object
    if (e1 instanceof Error) {
      firstErrorMessage = e1.message;
    }
  }

  // Attempt 2: Remove code fences
  const cleaned = input.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // proceed
  }

  // Attempt 3a: Fallback between first '{' and last '}'
  const braceStart = input.indexOf("{");
  const braceEnd = input.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd !== -1 && braceStart < braceEnd) {
    try {
      const jsonStr = input.substring(braceStart, braceEnd + 1);
      return JSON.parse(jsonStr);
    } catch (e) {
      // proceed
    }
  }

  // Attempt 3b: Fallback between first '[' and last ']'
  const bracketStart = input.indexOf("[");
  const bracketEnd = input.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd !== -1 && bracketStart < bracketEnd) {
    try {
      const jsonStr = input.substring(bracketStart, bracketEnd + 1);
      return JSON.parse(jsonStr);
    } catch (e) {
      // proceed
    }
  }

  // Final fallback
  return {
    error: firstErrorMessage,
    raw_input: input,
  };
}
