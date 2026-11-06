import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Handover } from "../packages/runner/dist/adapters/assistant/handover.js";
import { humanHasControl } from "../packages/runner/dist/adapters/assistant/ownership.js";
import { semanticDesktopFromEnv } from "../packages/runner/dist/adapters/assistant/semantic-desktop.js";
import { dataDir } from "../packages/runner/dist/system.js";

// Explicit, visible Windows fixture only. Never select an existing user's window.
if (process.platform !== "win32" || !process.argv.includes("--fixture")) {
  throw new Error("Run on Windows with --fixture to verify only the temporary test window.");
}
const data = dataDir();
if (humanHasControl(data)) throw new Error("Human control is locked; fixture input is disabled.");
const compiler = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe",
);
if (!existsSync(compiler)) throw new Error("The Windows Forms fixture compiler isn't available.");
const root = mkdtempSync(path.join(tmpdir(), "malves-desktop-fixture-"));
const source = path.join(root, "Fixture.cs");
const program = path.join(root, "MalvesDesktopFixture.exe");
let fixture;
const handover = new Handover({ onChange: () => {}, maxMs: 60000 });
try {
  writeFileSync(
    source,
    `using System; using System.Windows.Forms; class MalvesDesktopFixture { [STAThread] static void Main(){ var form=new Form();form.Text="Malves semantic verification fixture";form.Width=460;form.Height=180; var input=new TextBox();input.AccessibleName="Fixture project name";input.Text="initial";input.Left=20;input.Top=20;input.Width=350;var save=new Button();save.Text="Save fixture";save.AccessibleName="Save fixture";save.Left=20;save.Top=65;save.Width=350;save.Click+=(sender,e)=>{string result=input.Text=="verified fixture"?"Saved fixture verified":"Unexpected fixture value";save.Text=result;save.AccessibleName=result;};form.Controls.Add(input);form.Controls.Add(save);Application.Run(form);}}`,
  );
  execFileSync(
    compiler,
    [
      "/nologo",
      "/target:winexe",
      "/reference:System.Windows.Forms.dll",
      "/reference:System.Drawing.dll",
      `/out:${program}`,
      source,
    ],
    { windowsHide: true, stdio: "pipe", timeout: 30000 },
  );
  // This is an interactive test window, not a hidden service/helper.
  fixture = spawn(program, [], { windowsHide: false, stdio: "ignore" });
  const provider = await semanticDesktopFromEnv(
    () => handover.state.active && !handover.state.paused && !humanHasControl(data),
    () => handover.revision,
    data,
  );
  if (!provider) throw new Error("No verified desktop provider is configured.");
  handover.start();
  let app;
  let inventoryCount = 0;
  for (let i = 0; i < 20; i++) {
    const apps = await provider.apps();
    inventoryCount = apps.length;
    app = apps.find((candidate) => candidate.pid === fixture.pid);
    if (app) break;
    if (fixture.exitCode !== null)
      throw new Error(`Fixture exited before discovery (${fixture.exitCode}).`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!app)
    throw new Error(
      `The owned fixture app was not discovered (${inventoryCount} inventory entries). No input was sent.`,
    );
  const windows = await provider.windows(app.name);
  if (windows.length !== 1)
    throw new Error("The owned fixture window was not unique. No input was sent.");
  if (windows[0].pid !== fixture.pid)
    throw new Error(
      "The selected window does not belong to the owned fixture process. No input was sent.",
    );
  let snapshot = await provider.observe(app.name, windows[0].id);
  const field = snapshot.targets.find((target) => target.name === "Fixture project name");
  if (!field) throw new Error("The named fixture field was unavailable. No input was sent.");
  const typed = await provider.act(field.ref, "set-value", "verified fixture");
  snapshot = await provider.observe(app.name, windows[0].id);
  const save = snapshot.targets.find((target) => target.name === "Save fixture");
  if (!save) throw new Error("The named fixture button was unavailable.");
  const clicked = await provider.act(save.ref, "click");
  const after = await provider.observe(app.name, windows[0].id);
  const verified = after.targets.some((target) => target.name === "Saved fixture verified");
  console.log(
    JSON.stringify({
      ownedWindowsFixture: true,
      namedFieldObserved: true,
      fieldDeliveryVerified: typed.includes("Delivery: delivered_verified"),
      clickDispatched: clicked.includes("delivered_"),
      applicationPostconditionVerified: verified,
      existingAppsUntouched: true,
    }),
  );
  if (!verified) throw new Error("The fixture's expected postcondition was not observed.");
} finally {
  handover.stop("Bounded fixture verification ended.");
  if (fixture?.exitCode === null) {
    const exited = once(fixture, "exit");
    fixture.kill();
    await exited;
  }
  const resolved = path.resolve(root);
  if (resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`))
    rmSync(resolved, { recursive: true, force: true });
  else {
    console.error("Refusing cleanup outside the fixture temp directory.");
    process.exitCode = 1;
  }
}
