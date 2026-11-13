# InputDeck

Tune your mouse and keyboard right in the browser — DPI, polling rate, buttons, lift-off, per-key actuation, Rapid Trigger, lighting and receiver screen pictures, saved straight to the device. Nothing to install.

Works in Chrome, Edge and Opera on desktop (it uses [WebHID](https://developer.mozilla.org/docs/Web/API/WebHID_API)).

## Supported devices

Tested on real hardware:

- **WLMouse** HUAN / HUAN M and other WLMouse mice
- **Pulsar** X2 CrazyLight family on the 8K dongle
- **Wraith** W75 V2 HE

Untested (view-only until you press **Allow changes** on the device page):

- **Mice:** Pulsar (other models), Logitech (HID++ 2.0: Superlight, G502, G305…), Razer (DeathAdder, Viper, Basilisk, Cobra, Orochi), Lamzu, Vancer, LunaFury, Attack Shark, CRDRAKO, Orbital Pathfinder / Ghost, ATK, VXE / VGN, Kysona, Scyrox, Teevolution, Glorious wireless
- **Keyboards:** Lofree Hyzen, DAREU (80 boards on DAREU's own firmware, incl. A68 / A98 / EK series), any VIA-enabled keyboard — lighting and key remapping on every layer (Keychron, NuPhy, Lofree Flow 2, Zoom, Mode, CIDOO, Kzzi, Akko / Monsgeek / Epomaker VIA models and custom boards)

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

## Feedback and issues

Found a bug, wrong values, or want your device supported? [Open an issue](../../issues/new/choose). For bugs, paste the report from the **Feedback** button on the device page — it includes read-only diagnostics.

Untested drivers stay view-only until you press **Allow changes**; if you try one on real hardware, please tell us whether it worked.

## License

[MIT](LICENSE)
