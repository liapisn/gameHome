/** Minimum uploads before a tour build makes sense. */
export const MIN_PHOTOS = 5;

export interface JobProgress {
  step?: "plans" | "photos" | "poses" | "furnish" | "done";
  label?: string;
  done?: number;
  total?: number;
}
