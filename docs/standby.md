# Standby Malves on your server

When the laptop is asleep or off, nothing on it can answer. A **standby copy** of
Malves runs on your always-on Oracle VM so you can still talk to Malves and use
your memory, chats, skills and books from the phone.

## What the standby copy can and cannot do

| Can | Cannot |
|---|---|
| Talk to Malves, in new or old chats | Start or read tasks, coding agents, IDEs |
| Recall memory; remember things from normal chats | Use Chrome or the desktop (handover, screen) |
| Search your books with page citations | Ring your phone, send push notifications |
| Read skills; change its character and your profile (on your yes) | Anything that needs the laptop |

If you ask for laptop work, it says the work waits until the laptop is back.
`MALVES_STANDBY=1` is what restricts it, in code (`STANDBY_TOOLS` in
`assistant.ts`), not by a prompt.

## How it fits together

```
 laptop (Windows)                         Oracle VM (always on, Tailscale)
 ├ malves serve  (everything)             ├ malves serve  (MALVES_STANDBY=1)
 ├ Vault/  ◄──────── Syncthing ─────────► ├ Vault/   (send + receive, both ways)
 └ Books/  ───────── Syncthing ─────────► └ Books/   (laptop sends, VM only receives)
   memory-index.db, books-index.db          its own memory-index.db, books-index.db
   (not synced: each side builds its own)   (built from the synced files)
```

- **Sync is Syncthing**, not custom code: continuous, two-way, handles conflicts by
  keeping both files. Chats and memory notes have unique file names, so work done
  on the VM while the laptop is off merges back without clashes.
- **Index databases are not synced.** Each side rebuilds from the Markdown and PDFs.
  The first book index on the VM takes a few minutes; `poppler-utils` must be installed.
- **A chat carries on from its file.** The standby copy starts with no memory of the
  conversation in RAM, so it loads the last turns from the chat's Markdown file.
- The brain (freellmapi) already lives on the VM, so the standby copy talks to it on
  `127.0.0.1`.

## Set it up (on the VM, once)

You do these steps; nothing here touches your server on its own.

1. Packages: Node 22.12+, pnpm, git, `poppler-utils`, Syncthing, Tailscale (already there).
2. Get the code and build it:
   ```sh
   git clone <your malves repo> ~/malves && cd ~/malves
   pnpm install && pnpm build
   ```
3. Syncthing on the laptop and the VM, paired with each other:
   - folder **MalvesVault** (laptop path = your `MALVES_VAULT`): send & receive on both;
   - folder **Books**: on the laptop *Send Only*, on the VM *Receive Only*.
4. `~/malves/.env.standby` on the VM (do **not** copy the laptop's backup, Firebase
   or lead settings):
   ```
   MALVES_MODELS_URL=http://127.0.0.1:3001
   MALVES_MODELS_KEY=<your freellmapi key>
   MALVES_VAULT=/home/ubuntu/MalvesVault
   MALVES_BOOKS=/home/ubuntu/Books
   MALVES_BOOKS_EMBED=0
   MALVES_STANDBY=1
   MALVES_USER_NAME=<your name>
   MALVES_HOME=/home/ubuntu/.malves-standby
   ```
5. Run it as a service: copy `deploy/standby/malves-standby.service` to
   `/etc/systemd/system/`, fix the user and paths, then
   `sudo systemctl enable --now malves-standby`.
6. Pair the phone with it: `node packages/runner/dist/main.js console pair` on the VM,
   scan the code in the app.

## Status

| Piece | State |
|---|---|
| Standby mode (`MALVES_STANDBY=1`), restricted tools, server-copy persona | Built, tested |
| Chats resume from their Markdown file | Built, tested |
| Syncthing layout, systemd unit, setup steps | Written here, **not run on a real VM** |
| Running `malves serve` on Linux | Platform-specific code is guarded for Windows only; **untested on Linux** |
| Phone holds two pairings and switches to the standby copy when the laptop has been unreachable for 6 s; switches back the moment the laptop is online | Built; logic tested, **not tried on a real phone** |

## On the phone

Settings → This computer → **Pair standby**, then scan the code the server shows. After
that the app switches by itself: if the computer stays unreachable for 6 seconds it
connects to the standby copy and shows "Your computer is off or out of reach"; when the
computer is back it returns to it. A standby that has not connected never replaces a
computer that is only slow. **Remove standby** forgets it.

## Security

- The VM holds your vault and books as plain files. It is your own server, reachable
  over Tailscale only: keep its SSH key-only and the Malves port off the public internet.
- The standby copy needs your freellmapi key; it never needs the laptop's other secrets.
- Syncthing traffic is encrypted between your devices; pair only your own.
