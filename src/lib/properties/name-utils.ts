export function normalizePropertyName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function normalizePropertyNameForComparison(name: string): string {
  return normalizePropertyName(name).toLocaleLowerCase();
}
