// parser.ts
// Takes raw natural language food text and uses Claude to break it into
// a structured list of individual food items with quantities
// Example input: "2 eggs scrambled, a bowl of oatmeal, chipotle chicken burrito bowl for lunch"
// Example output: [{name: "scrambled eggs", quantity: 2, unit: "large egg"}, ...]

import Anthropic from "@anthropic-ai/sdk";
import { ParsedFood } from "./types";

// Which Claude model to use - set CLAUDE_MODEL in .env to override
// Update this string when Anthropic releases newer models (no "latest" alias exists)
// Full list: https://docs.anthropic.com/en/docs/about-claude/models
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

// The prompt that tells Claude exactly what we want back
// We're strict about JSON format so we can parse it reliably
const PROMPT = `You are a food logging assistant. The user will give you a natural language description of everything they ate.

Your job is to break it into individual food items and return a JSON object.

Rules:
- Return exactly {"items": [...]} with no other text
- Each item must have: name (string), quantity (number), unit (string)
- Split combined items: "eggs and toast" becomes two separate entries
- Be specific with units: use "large egg", "oz", "cup", "slice", "tbsp", "fl oz", "medium", "serving", etc.
- For restaurant items where quantity is unclear, use quantity: 1 and unit: "serving"
- For drinks, use "fl oz" when possible (e.g. a standard glass of wine = 5 fl oz)
- For WATER specifically: always use "ml" as the unit, converting as needed (1 L = 1000 ml, 1 cup = 237 ml, 1 fl oz = 30 ml)
- Do not include water unless explicitly mentioned
- Preserve brand/restaurant names in the item name (e.g. "Chipotle chicken al-pastor burrito bowl")

Example output:
{"items": [
  {"name": "scrambled eggs", "quantity": 2, "unit": "large egg"},
  {"name": "white toast with butter", "quantity": 1, "unit": "slice"},
  {"name": "Chipotle chicken al-pastor burrito bowl", "quantity": 1, "unit": "serving"}
]}`;

// Main function - takes the user's raw food text, returns parsed food items
// Throws if the Claude call fails or if the response can't be parsed as JSON
export async function parseFood(text: string): Promise<ParsedFood[]> {
  // Create the client here (not at module level) so it reads ANTHROPIC_API_KEY
  // AFTER dotenv has already loaded - avoids capturing a stale shell env var
  const anthropic = new Anthropic();

  // Call Claude with our parsing prompt
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        // Include both the instructions and the food text in one message
        content: `${PROMPT}\n\nParse this food log:\n\n${text}`,
      },
    ],
  });

  // Claude returns an array of content blocks - we expect one text block
  const block = message.content[0];
  if (block.type !== "text") {
    throw new Error("Claude returned an unexpected response type");
  }

  // Extract the JSON from Claude's response
  // We look for the first {...} block in case Claude adds any surrounding text
  const jsonMatch = block.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Could not find JSON in Claude response: ${block.text}`);
  }

  // Parse the JSON string into an object
  const parsed = JSON.parse(jsonMatch[0]);

  // Grab the items array
  const items: ParsedFood[] = parsed.items;

  // Basic sanity check - make sure we got an array back
  if (!Array.isArray(items)) {
    throw new Error(`Claude returned unexpected format: ${block.text}`);
  }

  return items;
}
