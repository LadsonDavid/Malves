import { decodeLeadsInvite, type LeadsInvite, type LeadsPage } from "@malves/protocol";
import * as SecureStore from "expo-secure-store";

const KEY = "lead-engine";

/** Where the lead engine is, and its key. Kept in the Android Keystore. */
export async function loadLeadEngine(): Promise<LeadsInvite | undefined> {
  const stored = await SecureStore.getItemAsync(KEY);
  if (!stored) return undefined;
  try {
    return JSON.parse(stored) as LeadsInvite;
  } catch {
    return undefined;
  }
}

export async function saveLeadEngine(qrText: string): Promise<LeadsInvite> {
  const invite = decodeLeadsInvite(qrText);
  await SecureStore.setItemAsync(KEY, JSON.stringify(invite));
  return invite;
}

export async function forgetLeadEngine(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

/** The ranked list, each company with its reason (R7). */
export async function fetchLeads(engine: LeadsInvite, limit = 50): Promise<LeadsPage> {
  const response = await fetch(`${engine.url}/api/leads?limit=${limit}`, {
    headers: { authorization: `Bearer ${engine.key}` },
  });
  if (response.status === 401)
    throw new Error("The lead engine refused the key. Scan its code again.");
  if (!response.ok) throw new Error(`The lead engine answered ${response.status}.`);
  return (await response.json()) as LeadsPage;
}
