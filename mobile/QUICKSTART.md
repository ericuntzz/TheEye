# Atria Mobile — Quick Start

> Get the app running on your phone in under 2 minutes.

## Prerequisites (already done)

- **Atria dev build** is installed on your iPhone (the dark blue "A" icon)
- You do NOT need Expo Go — delete it if it's on your phone
- You do NOT need Xcode unless doing a fresh native rebuild
- Your shell is using **Node 22 LTS** for this repo

## Every time you want to test

### 1. Start the phone-testing stack

```bash
cd /Users/fin/.openclaw/workspace/Atria
export PATH="$(brew --prefix node@22)/bin:$PATH"
npm run dev:phone
```

This does the right thing for phone testing:

- starts the Next.js backend
- starts the Expo dev-client server
- auto-detects your Mac's LAN IP
- sets the mobile app to use that LAN URL instead of `localhost`
- reuses healthy API/Expo servers if they are already running

Do not use `npm run dev` + `localhost:3000` for phone testing. Your iPhone cannot reach your Mac's `localhost`.

### 2. Open the Atria app on your phone

- Make sure your phone is on the **same Wi-Fi** as your Mac
- Open the **Atria** app (dark blue "A" icon, NOT Expo Go)
- Scan the QR code from the terminal, or open the printed Expo dev-client link
- If it doesn't connect: shake your phone → "Enter URL manually" → paste the printed `exp://...` URL

### 3. Log in

- Email: `eric.j.unterberger@gmail.com`
- Password: `Letmein123!`

That's it. You're in.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Point camera at a trained area" forever | You're in Expo Go, not the Atria dev build. Delete Expo Go, open the Atria app. |
| App can't find dev server | Check phone and Mac are on same Wi-Fi. Restart `npm run dev:phone`. |
| App crashes on launch | Make sure `npm run dev:phone` is still running. |
| App opens but API requests fail or you see MIME `text/html` errors | Reopen the latest Expo QR/deep-link from the terminal. |
| Creating a property shows a generic `Error 500` | Stop any old Atria dev servers you started manually, then rerun `npm run dev:phone`. |
| Camera/inspection not working | Make sure you're in the Atria dev build, not Expo Go, and restart `npm run dev:phone`. |
| Web/API suddenly throws `.next` ENOENT or manifest errors | Make sure you're on Node 22, then restart with `npm run dev:phone`. |
| Need to rebuild after native changes | `cd mobile && npx expo prebuild --platform ios --clean && npx expo run:ios --device` (requires Xcode) |
| Your Mac's IP changed | `npm run dev:phone` handles this automatically. You should not need to edit `mobile/.env` manually. |

## What NOT to do

- **Don't install Expo Go** — it can't run native modules (onnxruntime, BLE) that Atria needs
- **Don't run `npx expo run:ios`** unless you're doing a fresh native rebuild (requires Xcode)
- **Don't use `npx expo start`** without `--dev-client` — that targets Expo Go
- **Don't use Node 25** for this repo — it breaks Next.js builds here
- **Don't point the phone at `localhost:3000`** — use `npm run dev:phone`
