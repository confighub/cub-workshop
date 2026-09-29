import { cub } from "./common.mjs";

// Existence checks for steps that are not idempotent, such as a link create or
// a variant create that fails when its target already exists. As in cub fleet
// up, only cub's explicit not-found answer counts as absence: an
// authentication, permission or network failure is thrown, so a caller stops
// instead of creating over something it could not see.
export function cubFound(kind, slug, space = null) {
  try { cub([kind, "get", slug, ...(space ? ["--space", space] : []), "-o", "name"]); return true; }
  catch (error) {
    const lines = String(error.stderr || error.stdout || error.message).split("\n").map((line) => line.trim().replace(/^Failed: /, ""));
    if (lines.includes(`${kind} ${slug} not found`)) return false;
    throw error;
  }
}

export const spaceExists = (slug) => cubFound("space", slug);
