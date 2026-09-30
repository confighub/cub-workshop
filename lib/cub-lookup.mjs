import { cub } from "./common.mjs";

// Existence checks for steps that are not idempotent, such as a link create or
// a variant create that fails when its target already exists. As in cub fleet
// up, only cub's explicit not-found answer counts as absence: an
// authentication, permission or network failure is thrown, so a caller stops
// instead of creating over something it could not see. cub has said both
// `unit x not found` and `unit "x" not found in space <id>`.
export function saysNotFound(text, kind, slug) {
  const lines = String(text).split("\n").map((line) => line.trim().replace(/^Failed: /, ""));
  return lines.some((line) => line === `${kind} ${slug} not found` || line.startsWith(`${kind} ${slug} not found `) || line.startsWith(`${kind} "${slug}" not found`));
}

export function cubFound(kind, slug, space = null) {
  try { cub([kind, "get", slug, ...(space ? ["--space", space] : []), "-o", "name"]); return true; }
  catch (error) {
    if (saysNotFound(error.stderr || error.stdout || error.message, kind, slug)) return false;
    throw error;
  }
}

export const spaceExists = (slug) => cubFound("space", slug);
