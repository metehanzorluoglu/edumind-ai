# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## LAN development (opening the app from another device)

By default `EXPO_PUBLIC_API_BASE_URL` is unset and the app falls back to
`http://localhost:8000`, which only works when the app itself is opened on
the same machine the backend runs on. To also open the app from another
computer or phone on the same Wi-Fi:

1. Copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_BASE_URL` to your
   dev machine's LAN IP, e.g. `http://192.168.0.99:8000` (find it with
   `ipconfig getifaddr en0` on macOS Wi-Fi, or `hostname -I` on Linux).
2. Start the backend bound to all interfaces (already the default —
   see `../../rag-backend/README.md#run`):
   ```bash
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```
3. Start this app with `--lan` (its dev server already binds to all
   interfaces by default, but `--lan` makes it explicit and is what prints
   a LAN URL/QR code for physical devices):
   ```bash
   npm run web:lan
   # equivalent to: npx expo start --web --lan --port 8081
   ```
4. In `rag-backend/.env`, make sure `CORS_ORIGINS` and
   `ALLOWED_AUTH_REDIRECT_URIS` both include the LAN origin
   (`http://192.168.0.99:8081` / `http://192.168.0.99:8081/auth-callback`)
   in addition to `localhost:8081` — a browser sends whichever origin it
   was actually opened from, and CORS/redirect validation are exact-match
   allowlists. See `rag-backend/.env.example` for details.
5. Open `http://192.168.0.99:8081` from the other device's browser.

For native physical devices (not just web) and troubleshooting (guest-network
isolation, AP client isolation, etc.), see
`../../packages/education-assistant-client/docs/PHYSICAL_DEVICE_NETWORKING.md`.

## Development-only features

- **Settings tab**: a real, always-visible profile/status/app-info screen (avatar, signed-in
  provider, live backend/Ollama/Qdrant status, document and conversation counts). Its
  **Developer Options** section — overriding the backend base URL — is collapsed by default and
  present in every build, dev or production; there is no separate bearer-token entry anywhere
  (authentication is JWT-based, issued by signing in — see `lib/AuthProvider.tsx`).
- **Load sample corpus** (Documents tab, dev builds only): uploads one small, original, fictional
  document (`lib/sampleDocument.ts`) so you can exercise chat, search, and citations without a real
  private document corpus. Source cards label anything from this document as sample content — never
  treat it as real research evidence, and never mix it into real evaluation results. Remove it from
  the backend afterward with `python -m cli.documents remove <id>` (see `../../rag-backend/README.md`).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
