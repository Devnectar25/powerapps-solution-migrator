'use strict';

/**
 * Helpers that inspect and patch an exported solution package (.zip).
 */

const AdmZip = require('adm-zip');

const UNIQUE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,64}$/;

function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findEntry(zip, name) {
  return zip.getEntries().find((e) => e.entryName.toLowerCase() === name.toLowerCase());
}

function readText(entry) {
  let text = entry.getData().toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * Splits solution.xml so that only the solution's own manifest header (before <Publisher>)
 * is touched — the publisher block has its own UniqueName / LocalizedNames.
 */
function splitManifest(xml) {
  const start = xml.indexOf('<SolutionManifest');
  if (start < 0) throw new Error('solution.xml does not contain a <SolutionManifest> element.');
  let pubIdx = xml.indexOf('<Publisher', start);
  if (pubIdx < 0) pubIdx = xml.length;
  return { before: xml.slice(0, start), head: xml.slice(start, pubIdx), rest: xml.slice(pubIdx) };
}

function readManifest(buffer) {
  const zip = new AdmZip(buffer);
  const entry = findEntry(zip, 'solution.xml');
  if (!entry) throw new Error('The package does not contain solution.xml.');
  const xml = readText(entry);
  const { head } = splitManifest(xml);
  const uniqueName = (head.match(/<UniqueName>([^<]*)<\/UniqueName>/) || [])[1] || null;
  const displayName = (head.match(/<LocalizedName\s+description="([^"]*)"/) || [])[1] || null;
  const version = (head.match(/<Version>([^<]*)<\/Version>/) || [])[1] || null;
  const managed = (head.match(/<Managed>([^<]*)<\/Managed>/) || [])[1] === '1';
  return { uniqueName, displayName, version, managed };
}

/**
 * Returns a new package whose solution unique name / display name are replaced.
 */
function renameSolution(buffer, { uniqueName, displayName }) {
  if (uniqueName && !UNIQUE_NAME_RE.test(uniqueName)) {
    throw new Error(`"${uniqueName}" is not a valid solution unique name. Use letters, digits and underscores; start with a letter or underscore.`);
  }
  const zip = new AdmZip(buffer);
  const entry = findEntry(zip, 'solution.xml');
  if (!entry) throw new Error('The package does not contain solution.xml.');
  const xml = readText(entry);
  const parts = splitManifest(xml);
  let head = parts.head;

  if (uniqueName) {
    if (!/<UniqueName>[^<]*<\/UniqueName>/.test(head)) throw new Error('Could not locate the solution <UniqueName> in solution.xml.');
    head = head.replace(/<UniqueName>[^<]*<\/UniqueName>/, `<UniqueName>${escapeXmlText(uniqueName)}</UniqueName>`);
  }
  if (displayName) {
    head = head.replace(/<LocalizedNames>[\s\S]*?<\/LocalizedNames>|<LocalizedNames\s*\/>/, (block) => {
      if (/<LocalizedName\s/.test(block)) {
        return block.replace(/(<LocalizedName\s+description=")[^"]*(")/g, `$1${escapeXmlAttr(displayName)}$2`);
      }
      return `<LocalizedNames><LocalizedName description="${escapeXmlAttr(displayName)}" languagecode="1033" /></LocalizedNames>`;
    });
  }

  zip.updateFile(entry.entryName, Buffer.from(parts.before + head + parts.rest, 'utf8'));
  return zip.toBuffer();
}

/**
 * Lightweight inventory of items that typically need attention after a (cross-tenant) move.
 */
function inspectPackage(buffer) {
  const zip = new AdmZip(buffer);
  const customizations = findEntry(zip, 'customizations.xml');
  const xml = customizations ? readText(customizations) : '';
  const count = (re) => (xml.match(re) || []).length;
  const envVarFolders = new Set(
    zip.getEntries()
      .map((e) => e.entryName.match(/^environmentvariabledefinitions\/([^/]+)\//i))
      .filter(Boolean)
      .map((m) => m[1].toLowerCase()),
  );
  const envVarNames = [...new Set(zip.getEntries()
    .map((e) => e.entryName.match(/^environmentvariabledefinitions\/([^/]+)\//i))
    .filter(Boolean)
    .map((m) => m[1]))];
  const connectionReferenceNames = [...xml.matchAll(/<connectionreference\s[^>]*connectionreferencelogicalname="([^"]+)"[^>]*>([\s\S]*?)<\/connectionreference>/gi)]
    .map((m) => ({ logicalName: m[1], displayName: ((m[2].match(/<connectionreferencedisplayname>([^<]*)</i) || [])[1] || m[1]) }));
  return {
    connectionReferenceNames,
    environmentVariableNames: envVarNames,
    sizeBytes: buffer.length,
    files: zip.getEntries().length,
    connectionReferences: count(/<connectionreference\s/gi),
    environmentVariables: envVarFolders.size,
    canvasApps: zip.getEntries().filter((e) => /^CanvasApps\/.+\.msapp$/i.test(e.entryName)).length,
    canvasAppDetails: zip.getEntries().filter((e) => /^CanvasApps\/.+\.msapp$/i.test(e.entryName)).map((e) => inspectMsapp(e)),
    flows: zip.getEntries().filter((e) => /^Workflows\/.+\.json$/i.test(e.entryName)).length,
  };
}

/**
 * Reads a canvas app (.msapp, itself a zip) from the package: app name, the time this version
 * was saved in Studio, and its screens. Lets the user confirm what was actually exported.
 */
function inspectMsapp(entry) {
  const file = entry.entryName.split('/').pop();
  const out = { file, name: file.replace(/_DocumentUri\.msapp$/i, '').replace(/\.msapp$/i, ''), savedUtc: null, screens: [] };
  try {
    const app = new AdmZip(entry.getData());
    const json = (name) => {
      const e = findEntry(app, name);
      if (!e) return null;
      try { return JSON.parse(readText(e)); } catch { return null; }
    };
    const props = json('Properties.json');
    if (props && props.Name) out.name = props.Name;
    const header = json('Header.json');
    if (header && header.LastSavedDateTimeUTC) out.savedUtc = header.LastSavedDateTimeUTC;
    for (const e of app.getEntries()) {
      if (!/^Controls\/[^/]+\.json$/i.test(e.entryName)) continue;
      let ctl;
      try { ctl = JSON.parse(readText(e)); } catch { continue; }
      const top = ctl && ctl.TopParent;
      const tpl = top && top.Template;
      if (!top || !tpl || tpl.IsComponentDefinition) continue;
      if (tpl.Name === 'screen' || /\/screen$/i.test(tpl.Id || '')) out.screens.push(top.Name);
    }
    if (!out.screens.length) {
      // Newer apps also carry YAML sources, one file per screen.
      for (const e of app.getEntries()) {
        const m = e.entryName.match(/^Src\/([^/]+)\.(pa|fx)\.yaml$/i);
        if (m && !/^(App|_EditorState|Themes)$/i.test(m[1])) out.screens.push(m[1]);
      }
    }
    out.screens.sort((a, b) => a.localeCompare(b));
  } catch (err) {
    out.error = `Could not read the app file: ${err.message}`;
  }
  return out;
}

module.exports = { UNIQUE_NAME_RE, readManifest, renameSolution, inspectPackage };
