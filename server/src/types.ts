// All shared TypeScript types used across the app
// If you need to understand what data looks like at any point in the pipeline, look here

// One food item as parsed from the user's raw text by Claude
// This is the "before enrichment" state - just what the user described
export interface ParsedFood {
  // Human-friendly name Claude extracted from the text (e.g. "scrambled eggs")
  name: string;
  // How much of it (e.g. 2, 0.5, 1)
  quantity: number;
  // Unit of the quantity (e.g. "large eggs", "oz", "cup", "slice", "serving")
  unit: string;
}

// Full nutrient profile for one food item
// All values are per the serving described in the ParsedFood that produced this
export interface Nutrients {
  // Macros
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number;
  sugar_g: number;
  saturated_fat_g: number;

  // Vitamins
  vitamin_a_mcg: number;
  vitamin_c_mg: number;
  vitamin_d_mcg: number;
  vitamin_e_mg: number;
  vitamin_k_mcg: number;
  vitamin_b12_mcg: number;
  vitamin_b6_mg: number;
  folate_mcg: number;
  thiamin_mg: number;
  riboflavin_mg: number;
  niacin_mg: number;

  // Minerals
  calcium_mg: number;
  iron_mg: number;
  magnesium_mg: number;
  potassium_mg: number;
  sodium_mg: number;
  zinc_mg: number;
  selenium_mcg: number;
  phosphorus_mg: number;

  // Extras worth tracking
  cholesterol_mg: number;
  caffeine_mg: number;
  alcohol_g: number;
}

// A single food entry ready to be saved - parsed food + its nutrient data
export interface FoodEntry {
  // Unique ID for this entry (so you can delete/edit individual items later)
  id: string;
  // The human name as Claude understood it (e.g. "Scrambled eggs (2 large)")
  food_name: string;
  // How the serving was described (e.g. "2 large eggs", "1 bowl", "6 oz")
  serving_description: string;
  // Where the nutrient data came from
  // "claude_estimate" = Claude estimated, "water" = plain water bypass
  source: "claude_estimate" | "water";
  // Full nutrient profile for this serving (all zeros for water)
  nutrients: Nutrients;
  // Volume of water in milliliters - only set when source is "water", used for hydration insights
  water_ml?: number;
}

// The full contents of one daily food log file (e.g. data/users/billy/food/2026-04-12.json)
export interface DayLog {
  // The date this log is for, YYYY-MM-DD format
  date: string;
  // The user this log belongs to
  userId: string;
  // All the individual food entries logged for this day
  entries: FoodEntry[];
  // Pre-computed daily totals so you don't have to sum manually when reading the file
  daily_totals: Nutrients;
}

// A pending log session - created after parsing/enriching, waiting for user confirmation
// Lives in memory only, never written to disk
export interface PendingSession {
  // Unique session ID sent back to the client so they can confirm later
  sessionId: string;
  // The user this session belongs to
  userId: string;
  // The date these entries will be logged to
  date: string;
  // The enriched entries ready to save once confirmed
  entries: FoodEntry[];
  // When this session was created - used to expire stale sessions after 10 minutes
  createdAt: Date;
}

// What the HTTP server sends back after POST /log (before confirmation)
export interface LogPreviewResponse {
  // The session ID the client must send back to confirm
  sessionId: string;
  // The date entries will be logged to
  date: string;
  // The entries the user is about to confirm
  entries: FoodEntry[];
  // Total calories and key macros as a quick summary
  summary: {
    totalCalories: number;
    totalProtein_g: number;
    totalFat_g: number;
    totalCarbs_g: number;
  };
}

// What the HTTP server sends back after POST /confirm/:sessionId
export interface ConfirmResponse {
  // Whether it worked
  success: boolean;
  // Human-readable message
  message: string;
  // Path to the file that was written
  filePath?: string;
}
