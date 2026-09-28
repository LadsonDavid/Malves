import { Entry } from "@napi-rs/keyring";

/** Where keys and API keys live (§8 "Secrets: OS keychain, never files"). */
export interface Secrets {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
}

const SERVICE = "malves";

export class KeychainSecrets implements Secrets {
  constructor(private readonly scope: string) {}

  get(name: string): string | undefined {
    try {
      return this.entry(name).getPassword() ?? undefined;
    } catch (error) {
      throw keychainError(error);
    }
  }

  set(name: string, value: string): void {
    try {
      this.entry(name).setPassword(value);
    } catch (error) {
      throw keychainError(error);
    }
  }

  delete(name: string): void {
    try {
      this.entry(name).deletePassword();
    } catch {
      // Already gone.
    }
  }

  private entry(name: string): Entry {
    return new Entry(SERVICE, `${this.scope}:${name}`);
  }
}

/**
 * Keeps secrets in memory only: nothing touches the disk, and everything is
 * lost when the process exits (the runner then has a new key, and phones must
 * pair again). For tests and demos on machines without a keychain.
 */
export class MemorySecrets implements Secrets {
  private readonly values = new Map<string, string>();
  get(name: string): string | undefined {
    return this.values.get(name);
  }
  set(name: string, value: string): void {
    this.values.set(name, value);
  }
  delete(name: string): void {
    this.values.delete(name);
  }
}

function keychainError(error: unknown): Error {
  return new Error(
    `Could not use the OS keychain (${error instanceof Error ? error.message : String(error)}). ` +
      "malves keeps its keys there and never in files. On Linux, install and unlock a Secret " +
      "Service keyring (GNOME Keyring or KWallet). For a throwaway demo, MALVES_SECRETS=memory " +
      "keeps keys in memory only, so phones must pair again after every restart.",
  );
}

export function secretsFor(dataDir: string): Secrets {
  if (process.env.MALVES_SECRETS === "memory") return new MemorySecrets();
  // One keychain scope per data directory, so test and real runners don't share keys.
  return new KeychainSecrets(dataDir);
}
