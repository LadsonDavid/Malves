import { connectAccount, GmailAccounts } from "./gmail.js";

/** `malves gmail add|list|remove <email>`. */
export async function gmailCommand(
  sub: string | undefined,
  email: string | undefined,
  dataDir: string,
): Promise<number> {
  const accounts = new GmailAccounts(dataDir);
  if (sub === "list") {
    const all = accounts.list();
    console.log(all.length ? all.join("\n") : "No Gmail accounts connected.");
    return 0;
  }
  if (sub === "remove" && email) {
    console.log(accounts.remove(email) ? `Removed ${email}.` : `${email} wasn't connected.`);
    return 0;
  }
  if (sub === "add") {
    const clientId = process.env.MALVES_GOOGLE_CLIENT_ID;
    const clientSecret = process.env.MALVES_GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error(
        "Set MALVES_GOOGLE_CLIENT_ID and MALVES_GOOGLE_CLIENT_SECRET first (a Google Cloud OAuth client of type Desktop app, with the Gmail API turned on).",
      );
      return 1;
    }
    try {
      const connected = await connectAccount({
        accounts,
        clientId,
        clientSecret,
        show: (url) =>
          console.log(`Open this address in your browser and sign in to the account:\n\n${url}\n`),
      });
      console.log(`Connected ${connected}. Malves can read its mail and save drafts, never send.`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  console.error("Usage: malves gmail add | list | remove <email>");
  return 1;
}
