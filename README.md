# InputDeck

Tune your mouse and keyboard right in the browser — DPI, polling rate, buttons, lift-off, per-key actuation, Rapid Trigger, lighting and receiver screen pictures, saved straight to the device. Nothing to install.

Works in Chrome, Edge and Opera on desktop (it uses [WebHID](https://developer.mozilla.org/docs/Web/API/WebHID_API)).

## Supported devices

- **WLMouse** (HUAN, HUAN M and other models on the Compx protocol)
- **Wraith** W75 V2 HE

More brands are coming.

## Try it without a device

Open the app with `?demo` (for example `http://localhost:5176/?demo`) to use simulated devices.

## Develop

```bash
npm install
npm run dev        # http://localhost:5176
npm test           # driver tests against simulated devices
npm run typecheck
npm run build      # static site in dist/client
```

Built with TanStack Start (single-page mode), React, Tailwind and shadcn/ui.

The app is fully static: deploy the contents of `dist/client` to any static host. It must be served over HTTPS (or localhost) for WebHID to work.
