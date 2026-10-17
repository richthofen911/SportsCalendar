// Team-name matching, shared by the ESPN result lookup and tools/verify.mjs.
//
// The two sources name clubs differently ("FC Barcelona" on Wikipedia, "Barcelona"
// on ESPN; "1. FC Union Berlin" against "Union Berlin"), so comparisons run on a
// normalised form with the noise words stripped, then a small alias table for the
// cases normalisation cannot bridge.
export const NOISE = new Set([
  "fc", "cf", "afc", "ac", "sc", "fk", "sk", "cp", "if", "ca", "club", "de", "the",
  "04", "05", "09", "1899", "1900", "1907", "2004",
]);

export function norm(name) {
  return (name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !NOISE.has(t))
    .join(" ");
}

export const ALIAS = [
  ["athletic club", "athletic bilbao"],
  ["stade rennais", "rennes"],
  ["real betis", "betis"],
  ["sv elversberg", "elversberg"],
  ["inter milan", "inter"],
  ["olympique marseille", "marseille"],
  ["olympique lyonnais", "lyon"],
  ["1 fc heidenheim", "heidenheim"],
  ["borussia monchengladbach", "monchengladbach"],
  ["bayer 04 leverkusen", "leverkusen"],
  ["manchester united", "man united"],
];

export function sameTeam(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return ALIAS.some((g) => g.includes(x) && g.includes(y));
}

// Ligue 1 has both Paris FC and Paris Saint-Germain, so containment alone can
// pair the wrong clubs. Try exact names first, then aliases, and only then fall
// back to containment.
export function pickByTeam(rows, name, teamOf) {
  const target = norm(name);
  return (
    rows.find((r) => norm(teamOf(r)) === target) ||
    rows.find((r) => ALIAS.some((g) => g.includes(target) && g.includes(norm(teamOf(r))))) ||
    rows.find((r) => sameTeam(teamOf(r), name)) ||
    null
  );
}
