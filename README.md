# ADS to MSSQL Connection Importer

Import Azure Data Studio saved MSSQL connection profiles into the VS Code `ms-mssql` extension.

## Features

- Command Palette: `ADS2MSSQL: Import Azure Data Studio MSSQL Connections`
- Auto-detects the Azure Data Studio user `settings.json` path (Windows, macOS, Linux) with optional override.
- Skips duplicates (configurable) by comparing server, database, authentication type, and user.
- Attempts to use exported API from `ms-mssql` extension (`listConnectionProfiles`, `addConnectionProfile`).

## Limitations / Notes

Azure Data Studio typically stores connection profiles separately (e.g., in a `User` settings DB or workspace storage). This extension currently looks for array entries under plausible keys inside `settings.json` (e.g., `mssql.connections`). You may need to adapt `extractAdsConnections` logic to actual ADS storage if different.

Passwords are not migrated (they are not stored in plain JSON). Users will be prompted by the `ms-mssql` extension on first connect if required.

## Configuration

- `ads2mssql.azureDataStudioSettingsPath`: Override ADS `settings.json` path.
- `ads2mssql.skipDuplicates`: Skip import if equivalent connection already exists (default: true).

## Development

Install deps and launch the extension host.

```bash
npm install
npm run watch
```

Press F5 in VS Code to start a new Extension Development Host and run the command from the palette.

## Packaging

```bash
npm install -g @vscode/vsce
npm run package
```

## Assets

Icon created (vector in `resources/icon.svg`, packaged `resources/icon.png`). Replace `icon.png` with a proper 128x128 PNG before publishing.

## Future Enhancements

- Directly parse ADS connection storage location if confirmed (e.g., `User/state.json` or SQLite DB).
- Support grouping and advanced auth properties.
- Add tests and CI.
