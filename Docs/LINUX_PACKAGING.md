# Linux packaging and rendering compatibility

Telegram Drive ships Linux release artifacts for different installation models. All of them use the same application identifier and data locations, and none of the packages should remove user configuration, cached metadata, Telegram sessions, or supporter activation during an install or upgrade.

## Choose a package

| Format | Best fit | Update ownership |
| --- | --- | --- |
| `.AppImage` | Portable use across distributions | Telegram Drive's signed desktop updater |
| `.deb` | Debian, Ubuntu, and derivatives | The installed application/updater behavior provided by that release |
| `.rpm` | RPM-based distributions | The installed application/updater behavior provided by that release |
| `.pkg.tar.zst` | Arch Linux, EndeavourOS, and compatible systems | Pacman; the app may report an available version but opens the GitHub release instead of replacing pacman-owned files |

Install the verified Arch release asset with:

```bash
sudo pacman -U ./telegram-drive-bin-X.Y.Z-1-x86_64.pkg.tar.zst
```

To update, download the newer package from the official release and run the same `pacman -U` command. The package installs its program under `/usr`, while application state remains in the user's standard configuration/data directories.

## AppImage rendering policy

The AppImage starts with WebKitGTK's shared-memory DMA-BUF transport fallback when the Linux Rendering Fix setting is enabled. This compatibility policy runs before WebKitGTK starts and is deliberately limited to AppImage launches. It does not force `GDK_BACKEND` or `EGL_PLATFORM`, and an explicitly supplied WebKit rendering variable is never removed or replaced.

The automatic fallback can be disabled from Settings → General → Performance & Compatibility. A restart is required. Native `.deb`, `.rpm`, and pacman packages use the WebKitGTK behavior chosen by the installed distribution.

If the window is blank and Settings cannot be reached, launch a one-time conservative mode:

```bash
TELEGRAM_DRIVE_SAFE_RENDERING=1 ./Telegram.Drive_X.Y.Z_amd64.AppImage
```

This disables WebKit compositing for that launch and can be slower. It is a diagnostic/last-resort mode, not the normal default.

For an older published build that predates the safe-rendering flag, the legacy diagnostic workaround is:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./Telegram.Drive_X.Y.Z_amd64.AppImage
```

Do not add these variables globally to a shell profile unless testing shows they are required for other applications too.

## Report a Linux startup problem

Copy Telegram Drive's diagnostics from Settings when possible. Also include:

- distribution and version;
- package format and Telegram Drive version;
- X11 or Wayland session;
- desktop environment;
- GPU model and driver;
- whether the native package and AppImage behave differently;
- terminal output from the failing launch; and
- whether `TELEGRAM_DRIVE_SAFE_RENDERING=1` changes the result.

Review diagnostic output before posting it publicly. Do not include Telegram credentials, API hashes, recovery codes, supporter tokens, or private filenames.

## Release safeguards

The release workflow does not rewrite AppImage bytes after Tauri signs and uploads them. This keeps the AppImage, its updater signature, updater metadata, checksums, and provenance aligned.

The Arch package is produced from the exact `.deb` artifact already built by the protected desktop release job. The packaging step:

- renders a PKGBUILD with exact SHA-256 checksums and no `SKIP` entries;
- builds as an unprivileged user in a digest-pinned Arch container;
- runs `namcap`, package-content, dependency, desktop-entry, reinstall-preservation, and X11 startup checks;
- marks the installation as pacman-managed so Tauri does not overwrite files under `/usr`;
- includes a resolved Arch runtime CycloneDX SBOM; and
- enters release checksums and provenance before the draft is published.

CI provides a structural and headless X11 smoke test. Before treating a rendering issue as closed, also test the release candidate on real current Arch/EndeavourOS Wayland hardware and on any GPU/driver family involved in the original report.

## AUR status

The release workflow does not publish to the Arch User Repository. The repository currently has no checked-in license text, so the package uses an explicit upstream-license-unspecified notice rather than inventing an MIT grant. Add and review the intended license first; AUR publication should then be a separate, explicitly authorized action with a release checksum and generated `.SRCINFO`.

## Rollback

Install a previously downloaded release package with the appropriate package tool. Do not delete the application data directory as part of a package rollback. If the issue is AppImage-only, the native distribution package is the preferred temporary alternative while retaining the same data and entitlement identifiers.
