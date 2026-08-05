import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's class merger: conditional classes, with later Tailwind utilities winning. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
