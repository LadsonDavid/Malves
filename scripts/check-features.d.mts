export const STATUSES: string[];
export const CRITICALITY: string[];
export function checkFeatures(
  manifest: unknown,
  base?: string,
): { errors: string[]; summary: Record<string, number>; todo: string[] };
