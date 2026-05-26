import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type FhirIniEntry = {
  section: string;
  lineNo: number;
  raw: string;
  active: boolean;
  key?: string;
  value?: string;
};

function normalizePathish(value: string): string {
  let normalized = value.replaceAll("\\", "/").trim();
  const sourceIndex = normalized.indexOf("/source/");
  if (sourceIndex >= 0) normalized = normalized.slice(sourceIndex + 1);
  normalized = normalized.replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized.toLowerCase();
}

function parseFhirIni(iniText: string): FhirIniEntry[] {
  let section = "";
  const entries: FhirIniEntry[] = [];
  iniText.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    const sectionMatch = trimmed.match(/^;?\[([^\]]+)\]/);
    if (sectionMatch && !trimmed.startsWith(";")) {
      section = sectionMatch[1] ?? "";
      return;
    }
    if (!trimmed || trimmed.startsWith("#")) return;
    const active = !trimmed.startsWith(";");
    const content = active ? trimmed : trimmed.replace(/^;+/, "").trim();
    if (!content || content.startsWith("[") || content.startsWith("**")) return;
    const eq = content.indexOf("=");
    entries.push({
      section,
      lineNo: index + 1,
      raw,
      active,
      key: eq >= 0 ? content.slice(0, eq).trim() : content.trim(),
      value: eq >= 0 ? content.slice(eq + 1).trim() : undefined,
    });
  });
  return entries;
}

function entryLabel(entry: FhirIniEntry): string {
  const status = entry.active ? "active" : "commented";
  return `line ${entry.lineNo} [${entry.section}] ${status}: ${entry.raw.trim()}`;
}

function matchingEntries(entries: FhirIniEntry[], variants: Set<string>, section?: string): FhirIniEntry[] {
  return entries.filter((entry) => {
    if (section && entry.section !== section) return false;
    const raw = normalizePathish(entry.raw.replace(/^;+/, ""));
    const value = normalizePathish(entry.value ?? "");
    return [...variants].some((variant) => variant && (raw.includes(variant) || value.includes(variant)));
  });
}

export function buildScopeHints(worktree: string, sourcePaths: string[]): string {
  const iniPath = path.join(worktree, "source", "fhir.ini");
  if (!existsSync(iniPath)) return `- Unable to read ${iniPath}; inspect source/fhir.ini manually before treating obscure profiles/pages as live build inputs.`;

  const entries = parseFhirIni(readFileSync(iniPath, "utf8"));
  const uniquePaths = [...new Set(sourcePaths)].sort();
  if (uniquePaths.length === 0) return "- No likely source paths were precomputed; inspect source/fhir.ini and current source references manually.";

  return uniquePaths.map((sourcePath) => {
    const normalized = normalizePathish(sourcePath);
    const withoutSource = normalized.startsWith("source/") ? normalized.slice("source/".length) : normalized;
    const basename = path.basename(normalized);
    const variants = new Set([normalized, withoutSource]);
    if (basename && basename.length > 8) variants.add(basename);

    const exactMatches = matchingEntries(entries, variants);
    const activeMatches = exactMatches.filter((entry) => entry.active);
    const commentedMatches = exactMatches.filter((entry) => !entry.active);

    const folder = normalized.match(/^source\/([^/]+)/)?.[1]?.toLowerCase();
    const activeResource = folder
      ? entries.find((entry) => entry.active && entry.section === "resources" && entry.key?.toLowerCase() === folder)
      : undefined;
    const commentedResource = folder
      ? entries.find((entry) => !entry.active && entry.section === "resources" && entry.key?.toLowerCase() === folder)
      : undefined;
    const activeWorkgroup = folder
      ? entries.find((entry) => entry.active && entry.section === "workgroups" && entry.key?.toLowerCase() === folder)
      : undefined;
    const activeProfile = activeMatches.find((entry) => entry.section === "profiles");
    const commentedProfile = commentedMatches.find((entry) => entry.section === "profiles");

    const lines = [`- ${sourcePath}`];
    const activeIndicators = [
      activeResource ? entryLabel(activeResource) : undefined,
      activeWorkgroup ? entryLabel(activeWorkgroup) : undefined,
      activeProfile ? entryLabel(activeProfile) : undefined,
      ...activeMatches.filter((entry) => entry !== activeResource && entry !== activeWorkgroup && entry !== activeProfile).slice(0, 4).map(entryLabel),
    ].filter((line): line is string => Boolean(line));
    const inactiveIndicators = [
      commentedResource ? entryLabel(commentedResource) : undefined,
      commentedProfile ? entryLabel(commentedProfile) : undefined,
      ...commentedMatches.filter((entry) => entry !== commentedResource && entry !== commentedProfile).slice(0, 4).map(entryLabel),
    ].filter((line): line is string => Boolean(line));

    if (activeIndicators.length) lines.push(`  - Active fhir.ini indicators: ${activeIndicators.join(" | ")}`);
    if (inactiveIndicators.length) lines.push(`  - Commented/inactive fhir.ini indicators: ${inactiveIndicators.join(" | ")}`);
    if (normalized.startsWith("source/profiles/") && commentedProfile && !activeProfile) {
      lines.push("  - Scope warning: this profile path appears only in a commented [profiles] entry; treat edits as likely out-of-build unless another active reference proves otherwise.");
    } else if (!activeIndicators.length) {
      lines.push("  - Scope warning: no active fhir.ini indicator was found for this path; verify with source references before keeping edits to obscure profiles, generated artifacts, or standalone pages.");
    }
    return lines.join("\n");
  }).join("\n");
}
