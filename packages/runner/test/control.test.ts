import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startControl } from "../src/adapters/terminal/control.js";

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("malves console (serve in the background)", () => {
  it("runs a command with the secret and returns what serve said; refuses web pages and wrong secrets", async () => {
    const heard = new Set<(line: string) => void>();
    const ran: string[] = [];
    const server = await startControl({
      port: 0,
      token: "s3cret-token-0123456789",
      run: (line) => {
        ran.push(line);
        for (const l of heard) l(`you said ${line}`);
      },
      listen: (l) => {
        heard.add(l);
        return () => heard.delete(l);
      },
    });
    close = () => server.close();
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ line: "devices" }),
      });

    const ok = await post({ "x-malves-token": "s3cret-token-0123456789" });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("you said devices");

    expect((await post({ "x-malves-token": "wrong-token-0123456789" })).status).toBe(403);
    // A web page can reach 127.0.0.1 too, but always sends an Origin header.
    expect(
      (await post({ "x-malves-token": "s3cret-token-0123456789", origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect(ran).toEqual(["devices"]);
  });
});
