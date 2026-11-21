'use strict';

// Well-known Dataverse solution component types (solutioncomponent.componenttype).
// Types >= 10000 are assigned per organization; their names are resolved at runtime.
const COMPONENT_TYPES = {
  1: 'Table',
  2: 'Column',
  3: 'Relationship',
  4: 'Attribute Picklist Value',
  5: 'Attribute Lookup Value',
  6: 'View Attribute',
  7: 'Localized Label',
  8: 'Relationship Extra Condition',
  9: 'Choice',
  10: 'Table Relationship',
  11: 'Table Relationship Role',
  12: 'Table Relationship Relationships',
  13: 'Managed Property',
  14: 'Key',
  16: 'Privilege',
  17: 'Privilege Object Type Code',
  20: 'Security Role',
  21: 'Role Privilege',
  22: 'Display String',
  23: 'Display String Map',
  24: 'Form',
  25: 'Organization',
  26: 'View',
  29: 'Process',
  31: 'Report',
  32: 'Report Related Table',
  33: 'Report Related Category',
  34: 'Report Visibility',
  35: 'Attachment',
  36: 'Email Template',
  37: 'Contract Template',
  38: 'KB Article Template',
  39: 'Mail Merge Template',
  44: 'Duplicate Rule',
  45: 'Duplicate Rule Condition',
  46: 'Table Map',
  47: 'Attribute Map',
  48: 'Ribbon Command',
  49: 'Ribbon Context Group',
  50: 'Ribbon Customization',
  52: 'Ribbon Rule',
  53: 'Ribbon Tab To Command Map',
  55: 'Ribbon Diff',
  59: 'Chart',
  60: 'Form',
  61: 'Web Resource',
  62: 'Site Map',
  63: 'Connection Role',
  64: 'Complex Control',
  65: 'Hierarchy Rule',
  66: 'Custom Control',
  68: 'Custom Control Default Config',
  70: 'Field Security Profile',
  71: 'Field Permission',
  80: 'Model-driven App',
  90: 'Plug-in Type',
  91: 'Plug-in Assembly',
  92: 'Plug-in Step',
  93: 'Plug-in Step Image',
  95: 'Service Endpoint',
  150: 'Routing Rule',
  151: 'Routing Rule Item',
  152: 'SLA',
  153: 'SLA Item',
  154: 'Convert Rule',
  155: 'Convert Rule Item',
  161: 'Mobile Offline Profile',
  162: 'Mobile Offline Profile Item',
  165: 'Similarity Rule',
  166: 'Data Source Mapping',
  201: 'SDK Message',
  202: 'SDK Message Filter',
  203: 'SDK Message Pair',
  204: 'SDK Message Request',
  205: 'SDK Message Request Field',
  206: 'SDK Message Response',
  207: 'SDK Message Response Field',
  208: 'Import Map',
  210: 'Web Wizard',
  300: 'Canvas App',
  371: 'Connector',
  372: 'Connector',
  380: 'Environment Variable Definition',
  381: 'Environment Variable Value',
  400: 'AI Project Type',
  401: 'AI Project',
  402: 'AI Configuration',
  430: 'Entity Analytics Configuration',
  431: 'Attribute Image Configuration',
  432: 'Entity Image Configuration',
};

// workflow.category: what a "Process" (component type 29) actually is.
const WORKFLOW_CATEGORIES = {
  0: 'Classic Workflow',
  1: 'Dialog',
  2: 'Business Rule',
  3: 'Action',
  4: 'Business Process Flow',
  5: 'Cloud Flow',
  6: 'Desktop Flow',
  7: 'AI Flow',
};

// Names Dataverse's component summary uses, mapped to the names makers see in Power Apps.
const FRIENDLY = {
  entity: 'Table', attribute: 'Column', 'option set': 'Choice', optionset: 'Choice',
  'entity relationship': 'Relationship', 'system form': 'Form', 'saved query': 'View',
  'saved query visualization': 'Chart', workflow: 'Process', 'entity key': 'Key',
};

/** Friendly type name: known types use the Power Apps name; others keep what Dataverse says. */
function friendlyTypeName(type, reportedName, dynamicNames) {
  if (COMPONENT_TYPES[type]) return COMPONENT_TYPES[type];
  const r = String(reportedName || '').trim();
  if (r && FRIENDLY[r.toLowerCase()]) return FRIENDLY[r.toLowerCase()];
  return r || componentTypeName(type, dynamicNames);
}

function componentTypeName(type, dynamicNames) {
  if (COMPONENT_TYPES[type]) return COMPONENT_TYPES[type];
  if (dynamicNames && dynamicNames[type]) return dynamicNames[type];
  return `Component (type ${type})`;
}

module.exports = { COMPONENT_TYPES, WORKFLOW_CATEGORIES, componentTypeName, friendlyTypeName };
