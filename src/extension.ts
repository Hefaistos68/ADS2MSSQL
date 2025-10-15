import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'jsonc-parser';

interface AdsConnectionProfile {
  server: string;
  database?: string;
  authenticationType?: string;
  user?: string;
  password?: string; // not stored in ADS settings normally
  groupId?: string;
  groupFullName?: string;
  profileName?: string;
  azureTenantId?: string;
}

interface AdsConnectionGroupRaw {
  id: string;
  name: string;
  parentId?: string;
  fullName?: string; // computed or stored
}

interface MssqlConnectionProfile {
  server: string;
  database?: string;
  authenticationType: string; // e.g. 'SqlLogin' | 'Integrated' | 'AzureMFA'
  user?: string;
  password?: string;
  profileName?: string;
  groupFullName?: string; // attempt to carry group association
}

interface VscodeMssqlStoredConnection {
  server: string;
  database?: string;
  authenticationType?: string;
  user?: string;
  password?: string;
  group?: string; // flattened group path
  profileName?: string;
}

interface VscodeMssqlStoredGroupPersisted { id: string; name: string; parentId?: string; color?: string; description?: string }
interface InternalGroup { id: string; name: string; parentId?: string; fullName: string }

function getAdsSettingsPath(configOverride: string | undefined): string | undefined {
  if (configOverride) {
    return configOverride;
  }
  const platform = process.platform; // win32, darwin, linux
  const home = process.env[platform === 'win32' ? 'USERPROFILE' : 'HOME'];
  if (!home) { return undefined; }
  if (platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'azuredatastudio', 'User', 'settings.json');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'azuredatastudio', 'User', 'settings.json');
  }
  return path.join(home, '.config', 'azuredatastudio', 'User', 'settings.json');
}

function extractAdsConnectionsAndGroups(settingsJson: any): { connections: AdsConnectionProfile[]; groups: AdsConnectionGroupRaw[] } {
  if (!settingsJson) return { connections: [], groups: [] };

  const GROUP_KEYS = [
    'datasource.connectionGroups', // observed in provided settings.json
    'mssql.connectionGroups',
    'sql.connectionGroups'
  ];
  const CONNECTION_KEYS = [
    'datasource.connections', // observed in provided settings.json
    'mssql.connections',
    'sql.connections'
  ];

  const groups: AdsConnectionGroupRaw[] = [];
  for (const key of GROUP_KEYS) {
    const arr = settingsJson[key];
    if (Array.isArray(arr)) {
      for (const g of arr) {
        if (g && typeof g.id === 'string' && typeof g.name === 'string') {
          groups.push({ id: g.id, name: g.name, parentId: g.parentId, fullName: g.fullName });
        }
      }
      // Prefer first populated key
      if (groups.length) break;
    }
  }

  const groupById = new Map<string, AdsConnectionGroupRaw>();
  groups.forEach(g => groupById.set(g.id, g));

  // Build hierarchical fullName; skip including artificial root label like 'ROOT' in final path.
  function computeFullName(g: AdsConnectionGroupRaw): string {
    if (g.fullName) return g.fullName;
    if (!g.parentId) {
      // Treat name 'ROOT' (case-insensitive) as invisible root
      g.fullName = /^root$/i.test(g.name) ? '' : g.name;
      return g.fullName;
    }
    const parent = groupById.get(g.parentId);
    const parentName = parent ? computeFullName(parent) : '';
    const selfName = g.name;
    g.fullName = parentName ? (parentName + (selfName ? '/' + selfName : '')) : ( /^root$/i.test(selfName) ? '' : selfName );
    return g.fullName;
  }
  groups.forEach(g => computeFullName(g));

  // Normalize empty fullName (root) to undefined for simpler downstream logic
  groups.forEach(g => { if (!g.fullName) g.fullName = undefined; });

  const connections: AdsConnectionProfile[] = [];
  for (const key of CONNECTION_KEYS) {
    const arr = settingsJson[key];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const conn = mapRawAdsConnection(raw, groupById);
      if (conn) connections.push(conn);
    }
  }

  // Fallback heuristic: scan any top-level array for objects with an options.server if none collected
  if (connections.length === 0) {
    for (const [k, v] of Object.entries(settingsJson)) {
      if (Array.isArray(v)) {
        for (const raw of v) {
          const conn = mapRawAdsConnection(raw, groupById);
          if (conn) connections.push(conn);
        }
      }
    }
  }

  return { connections, groups };
}

function mapRawAdsConnection(raw: any, groupById: Map<string, AdsConnectionGroupRaw>): AdsConnectionProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const opt = raw.options || raw; // allow either wrapped or direct
  const server: string | undefined = opt.server || opt.dataSource;
  if (typeof server !== 'string' || server.trim() === '') return undefined;
  const database: string | undefined = opt.database || opt.originalDatabase || opt.databaseDisplayName || undefined;
  const authenticationType = opt.authenticationType;
  const user = opt.user || opt.userName || undefined;
  const groupId = raw.groupId || opt.groupId || undefined;
  const profileNameRaw = opt.connectionName || opt.connectionDisplayName || '';
  const profileName = profileNameRaw && profileNameRaw.trim().length > 0 ? profileNameRaw : undefined;
  const azureTenantId = opt.azureTenantId;
  const conn: AdsConnectionProfile = { server, database, authenticationType, user, groupId, profileName, azureTenantId };
  if (groupId && groupById.has(groupId)) {
    const gf = groupById.get(groupId)!.fullName;
    if (gf) conn.groupFullName = gf;
  }
  return conn;
}

function toMssqlProfile(ads: AdsConnectionProfile): MssqlConnectionProfile {
  return {
    server: ads.server,
    database: ads.database,
    authenticationType: mapAuthType(ads.authenticationType),
    user: ads.user,
    profileName: ads.profileName || `${ads.server}${ads.database ? ' - ' + ads.database : ''}`,
    groupFullName: ads.groupFullName
  };
}

function mapAuthType(type?: string): string {
  switch ((type || '').toLowerCase()) {
    case 'sqllogin':
    case 'sql':
      return 'SqlLogin';
    case 'integrated':
    case 'windows':
      return 'Integrated';
    case 'azuremfa':
    case 'azure':
      return 'AzureMFA';
    default:
      return 'SqlLogin';
  }
}

function connectionKey(p: MssqlConnectionProfile): string {
  return `${p.server}|${p.database || ''}|${p.authenticationType}|${p.user || ''}`.toLowerCase();
}

async function getExistingMssqlConnectionsFromSettings(): Promise<VscodeMssqlStoredConnection[]> {
  const config = vscode.workspace.getConfiguration('mssql');
  const existing = config.get<any[]>('connections', []);
  if (Array.isArray(existing)) {
    return existing as VscodeMssqlStoredConnection[];
  }
  return [];
}

function toStoredConnection(p: MssqlConnectionProfile): VscodeMssqlStoredConnection {
  return {
    server: p.server,
    database: p.database,
    authenticationType: p.authenticationType,
    user: p.user,
    profileName: p.profileName,
    group: p.groupFullName
  };
}

function uuidv4(): string {
  // Use crypto.randomUUID if available
  const g: any = globalThis as any;
  if (g.crypto && typeof g.crypto.randomUUID === 'function') return g.crypto.randomUUID();
  // Fallback
  const rnd = (n: number) => (crypto.getRandomValues(new Uint8Array(n)) as Uint8Array);
  const bytes = rnd(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const toHex: string[] = [];
  for (let b of bytes) toHex.push(b.toString(16).padStart(2,'0'));
  return `${toHex[0]}${toHex[1]}${toHex[2]}${toHex[3]}-${toHex[4]}${toHex[5]}-${toHex[6]}${toHex[7]}-${toHex[8]}${toHex[9]}-${toHex[10]}${toHex[11]}${toHex[12]}${toHex[13]}${toHex[14]}${toHex[15]}`;
}

function loadExistingGroupsFromSettings(): InternalGroup[] {
  const cfg = vscode.workspace.getConfiguration('mssql');
  const raw = cfg.get<any[]>('connectionGroups', []) || [];
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, any>();
  raw.forEach(g => { if (g && g.id && g.name) byId.set(g.id, g); });
  // Build fullName by traversing parents until none; skip ROOT prefix
  const cache = new Map<string,string>();
  function fullName(id: string): string {
    if (cache.has(id)) return cache.get(id)!;
    const g = byId.get(id); if (!g) return '';
    if (!g.parentId) {
      const fn = /^root$/i.test(g.name) ? '' : g.name; cache.set(id, fn); return fn;
    }
    const parent = fullName(g.parentId);
    const fn = parent ? (parent + '/' + g.name) : (/^root$/i.test(g.name) ? '' : g.name);
    cache.set(id, fn); return fn;
  }
  const internal: InternalGroup[] = [];
  raw.forEach(g => { if (g && g.id && g.name) internal.push({ id: g.id, name: g.name, parentId: g.parentId, fullName: fullName(g.id) }); });
  return internal;
}

function ensureInternalGroups(paths: Set<string>, existing: InternalGroup[], log: (...args: any[]) => void): InternalGroup[] {
  const result = [...existing];
  const fullNameMap = new Map(result.map(g => [g.fullName, g] as [string, InternalGroup]));
  // Ensure we have a root marker (fullName '') if not represented by a ROOT group
  let root = result.find(g => g.fullName === '');
  if (!root) {
    root = { id: uuidv4(), name: 'ROOT', parentId: undefined, fullName: '' };
    result.push(root);
    fullNameMap.set('', root);
  }
  const ensure = (p: string) => {
    if (!p) return; // child of root
    if (fullNameMap.has(p)) return;
    const segments = p.split('/');
    const parentPath = segments.slice(0, -1).join('/');
    if (parentPath) ensure(parentPath);
    const parentGroup = parentPath ? fullNameMap.get(parentPath) : root;
    const g: InternalGroup = { id: uuidv4(), name: segments[segments.length - 1], parentId: parentGroup?.id, fullName: p };
    result.push(g);
    fullNameMap.set(p, g);
  };
  Array.from(paths).filter(p => !!p).sort().forEach(p => ensure(p));
  log('ensureInternalGroups final count', result.length);
  return result;
}

function serializeGroups(groups: InternalGroup[]): VscodeMssqlStoredGroupPersisted[] {
  // Exclude internal fullName when persisting; keep ROOT group
  const persisted: VscodeMssqlStoredGroupPersisted[] = [];
  groups.forEach(g => {
    persisted.push({ id: g.id, name: g.name, parentId: g.parentId });
  });
  return persisted;
}

function buildStoredConnectionRecord(p: MssqlConnectionProfile, groupMap: Map<string, InternalGroup>, ads: AdsConnectionProfile | undefined): any {
  // Attempt to enrich with ADS metadata if present
  const isAzure = /azuremfa/i.test(p.authenticationType);
  let email: string | undefined;
  if (p.user) {
    const matchEmail = p.user.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (matchEmail) email = matchEmail[0];
  }
  const record: any = {
    authenticationType: p.authenticationType,
    connectTimeout: 30,
    applicationName: 'vscode-mssql',
    server: p.server,
    trustServerCertificate: true,
    database: p.database || '',
    profileName: p.profileName,
    user: p.user || '',
    password: '',
    commandTimeout: 30,
    encrypt: 'Mandatory',
    id: uuidv4(),
    profileSource: 0
  };
  const groupFull = p.groupFullName || '';
  if (groupFull) {
    // groupFull -> id
    // groupMap keyed by fullName
    const grp = Array.from(groupMap.values()).find(g => g.fullName === groupFull);
    if (grp) record.groupId = grp.id;
  }
  if (isAzure && ads) {
    if (ads.azureTenantId) record.tenantId = ads.azureTenantId;
    if ((ads as any).azureAccount) record.accountId = (ads as any).azureAccount;
    if (email) record.email = email;
    record.azureAccountToken = '';
    if ((ads as any).expiresOn) record.expiresOn = (ads as any).expiresOn;
  }
  return record;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('ADS2MSSQL extension activating');
  const disposable = vscode.commands.registerCommand('ads2mssql.importConnections', async () => {
    try {
      const config = vscode.workspace.getConfiguration();
      const overridePath = config.get<string>('ads2mssql.azureDataStudioSettingsPath');
      const skipDuplicates = config.get<boolean>('ads2mssql.skipDuplicates', true);
      const importGroups = config.get<boolean>('ads2mssql.importGroups', true);
      const createGroupsInTarget = config.get<boolean>('ads2mssql.createGroupsInTarget', true);
      const debugLogging = config.get<boolean>('ads2mssql.debugLogging', false);
  const writeMode = config.get<string>('ads2mssql.writeMode', 'settings');
  const writeGroups = config.get<boolean>('ads2mssql.writeGroups', true);
      const output = debugLogging ? vscode.window.createOutputChannel('ADS2MSSQL') : undefined;
      const log = (...args: any[]) => { if (debugLogging && output) output.appendLine(args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ')); };
  if (debugLogging && output) { output.show(true); log('--- Import started ---'); log('Config', { skipDuplicates, importGroups, createGroupsInTarget, writeMode, writeGroups }); }

      const adsSettingsPath = getAdsSettingsPath(overridePath);
      if (!adsSettingsPath) { vscode.window.showErrorMessage('Cannot determine Azure Data Studio settings path.'); log('No ADS settings path'); return; }
      if (!fs.existsSync(adsSettingsPath)) { vscode.window.showErrorMessage(`Azure Data Studio settings not found at ${adsSettingsPath}`); log('ADS settings file missing:', adsSettingsPath); return; }

      const raw = fs.readFileSync(adsSettingsPath, 'utf8');
      const json = parse(raw);
      const { connections: adsConnections, groups: adsGroups } = extractAdsConnectionsAndGroups(json);
      log('Groups discovered', adsGroups.length); adsGroups.forEach(g => log('Group', g.fullName || g.name, g));
      log('Connections discovered', adsConnections.length); adsConnections.forEach(c => log('Conn', c.profileName || c.server, { server: c.server, db: c.database, group: c.groupFullName }));
      if (adsConnections.length === 0) { vscode.window.showInformationMessage('No Azure Data Studio MSSQL connections found in settings.json.'); log('No connections found'); return; }

      const mssqlProfiles = adsConnections.map(toMssqlProfile);
  let existingStored: VscodeMssqlStoredConnection[] = [];
      if (skipDuplicates && writeMode === 'settings') {
        existingStored = await getExistingMssqlConnectionsFromSettings();
        log('Existing stored profiles count', existingStored.length);
      }
      const existingKeys = new Set(existingStored.map(e => connectionKey({ server: e.server, database: e.database, authenticationType: e.authenticationType || 'SqlLogin', user: e.user, profileName: e.profileName, groupFullName: e.group } as MssqlConnectionProfile)));

  let imported = 0; let groupsCreated = 0; let groupsAttempted = 0; // groupsCreated will remain 0 in settings mode (no API)

  const uniqueGroups = new Set<string>();
  if (importGroups) { adsConnections.forEach(c => { if (c.groupFullName) uniqueGroups.add(c.groupFullName); }); log('Unique referenced groups', Array.from(uniqueGroups)); }
  // In settings write mode we cannot programmatically create groups; they are implicit via group property.

      const toPersistConnections: any[] = [...existingStored];
      // Build / merge groups first if writing groups
      let internalGroups: InternalGroup[] = loadExistingGroupsFromSettings();
      if (writeMode === 'settings' && importGroups && writeGroups) {
        internalGroups = ensureInternalGroups(uniqueGroups, internalGroups, log);
      }
      const groupMap = new Map(internalGroups.map(g => [g.fullName, g] as [string, InternalGroup]));
      for (let i = 0; i < mssqlProfiles.length; i++) {
        const profile = mssqlProfiles[i];
        if (skipDuplicates && existingKeys.has(connectionKey(profile))) { log('Skip duplicate', profile.profileName || profile.server); continue; }
        // capture original ads connection for azure extras
        const adsOriginal = adsConnections[i];
        const stored = buildStoredConnectionRecord(profile, groupMap, adsOriginal);
        toPersistConnections.push(stored);
        imported++;
        log('Queued profile record', stored.profileName || stored.server, stored);
      }
      let groupsPersisted = 0;
      if (writeMode === 'settings') {
        const mssqlConfig = vscode.workspace.getConfiguration('mssql');
        await mssqlConfig.update('connections', toPersistConnections, vscode.ConfigurationTarget.Global);
        log('Persisted connections to settings: total', toPersistConnections.length);
        if (writeGroups && importGroups) {
          const persistedGroups = serializeGroups(internalGroups);
          await mssqlConfig.update('connectionGroups', persistedGroups, vscode.ConfigurationTarget.Global);
          groupsPersisted = uniqueGroups.size; // approximate
          log('Persisted connectionGroups total', persistedGroups.length);
        }
      }

      const summaryParts = [`Imported ${imported} connection(s)`];
  if (importGroups) summaryParts.push(`Groups referenced: ${uniqueGroups.size}`);
  if (writeGroups && importGroups) summaryParts.push(`Groups persisted: ${groupsPersisted}`);
  if (createGroupsInTarget) summaryParts.push(`Groups created: ${groupsCreated}/${groupsAttempted}`); // will be 0 in settings mode
      vscode.window.showInformationMessage(summaryParts.join(' | '));
      log('Summary', summaryParts.join(' | ')); log('--- Import finished ---');
    } catch (err: any) {
      vscode.window.showErrorMessage(`Import failed: ${err.message || err}`);
    }
  });

  context.subscriptions.push(disposable);
  const hello = vscode.commands.registerCommand('ads2mssql.hello', () => {
    vscode.window.showInformationMessage('ADS2MSSQL diagnostic command is available.');
  });
  context.subscriptions.push(hello);
  console.log('ADS2MSSQL extension activated');
}

export function deactivate() {}
