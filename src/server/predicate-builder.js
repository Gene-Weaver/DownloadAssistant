/*
 * Translate a gbif.org occurrence-search URL into a GBIF download-request body
 * (the async DWCA download API). This is what lets us get EVERY record past the
 * 100k offset wall.
 *
 * Verified details (2026): the request body is
 *   { creator, notificationAddresses, sendNotification, format:'DWCA',
 *     checklistKey?, predicate }
 * where predicate is an AND of equals/in nodes on UPPER_CASE keys. For an
 * alphanumeric Catalogue-of-Life-XR taxonKey (e.g. 94JD) the checklistKey must
 * appear BOTH top-level AND inside the TAXON_KEY node, otherwise the obsolete
 * backbone is assumed and the key matches nothing.
 */

const { deriveSlug } = require('./gbif-api');

const COL_XR_CHECKLIST = '7ddf754f-d193-4cc9-b351-99906754a03b';
const TAXON_KEY_PARAMS = new Set([
  'taxonKey', 'taxon_key', 'taxonKeys', 'acceptedTaxonKey', 'speciesKey', 'genusKey',
  'familyKey', 'orderKey', 'classKey', 'phylumKey', 'kingdomKey', 'subgenusKey',
]);

// URL param -> download predicate KEY (equals for one value, in for many).
const KEY_MAP = {
  taxonKey: 'TAXON_KEY', taxon_key: 'TAXON_KEY', taxonKeys: 'TAXON_KEY',
  acceptedTaxonKey: 'ACCEPTED_TAXON_KEY', speciesKey: 'SPECIES_KEY', genusKey: 'GENUS_KEY',
  familyKey: 'FAMILY_KEY', orderKey: 'ORDER_KEY', classKey: 'CLASS_KEY',
  phylumKey: 'PHYLUM_KEY', kingdomKey: 'KINGDOM_KEY',
  basisOfRecord: 'BASIS_OF_RECORD', basis_of_record: 'BASIS_OF_RECORD',
  mediaType: 'MEDIA_TYPE', occurrenceStatus: 'OCCURRENCE_STATUS',
  country: 'COUNTRY', publishingCountry: 'PUBLISHING_COUNTRY',
  datasetKey: 'DATASET_KEY', publishingOrg: 'PUBLISHING_ORG',
  institutionCode: 'INSTITUTION_CODE', collectionCode: 'COLLECTION_CODE',
  catalogNumber: 'CATALOG_NUMBER', recordedBy: 'RECORDED_BY',
  continent: 'CONTINENT', typeStatus: 'TYPE_STATUS', month: 'MONTH',
  iucnRedListCategory: 'IUCN_RED_LIST_CATEGORY', license: 'LICENSE',
  establishmentMeans: 'ESTABLISHMENT_MEANS', hasCoordinate: 'HAS_COORDINATE',
  hasGeospatialIssue: 'HAS_GEOSPATIAL_ISSUE', gadmGid: 'GADM_GID', protocol: 'PROTOCOL',
};
// Params whose predicate value must be upper-cased (URL uses lowercase).
const UPPERCASE_VALUE = new Set(['occurrenceStatus']);
// Params that express a min,max range (single value => equals).
const RANGE_KEY = { year: 'YEAR', eventDate: 'EVENT_DATE', coordinateUncertaintyInMeters: 'COORDINATE_UNCERTAINTY_IN_METERS' };
// UI-only or specially-handled params — never a plain equals predicate.
const DROP = new Set(['view', 'entity', 'offset', 'limit', 'dwca_extension', 'facet', 'q', 'geometry', 'checklistKey']);

function equalsNode(key, value, checklistKey) {
  const node = { type: 'equals', key, value: String(value) };
  if (checklistKey && (key === 'TAXON_KEY' || key === 'ACCEPTED_TAXON_KEY')) node.checklistKey = checklistKey;
  return node;
}

function keyNode(key, values, checklistKey) {
  if (values.length === 1) return equalsNode(key, values[0], checklistKey);
  const node = { type: 'in', key, values: values.map(String) };
  if (checklistKey && (key === 'TAXON_KEY' || key === 'ACCEPTED_TAXON_KEY')) node.checklistKey = checklistKey;
  return node;
}

function rangeNodes(key, raw) {
  // "1990,2000" => AND(>=1990, <=2000); single value => equals.
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return [
      { type: 'greaterThanOrEquals', key, value: parts[0] },
      { type: 'lessThanOrEquals', key, value: parts[1] },
    ];
  }
  return [{ type: 'equals', key, value: parts[0] }];
}

/*
 * Build the predicate + resolve whether a CoL-XR checklistKey is needed.
 * Returns { predicate, checklistKey|null }.
 */
function buildPredicate(searchUrl) {
  const u = new URL(searchUrl);
  const params = u.searchParams;

  // Does the taxon filter use an alphanumeric (CoL-XR) key?
  let alphanumericTaxon = false;
  for (const [k, v] of params) {
    if (TAXON_KEY_PARAMS.has(k) && /[a-z]/i.test(v)) alphanumericTaxon = true;
  }
  const urlChecklist = params.get('checklistKey');
  const checklistKey = urlChecklist || (alphanumericTaxon ? COL_XR_CHECKLIST : null);

  // Group multi-valued params.
  const grouped = new Map();
  for (const [k, v] of params) {
    if (DROP.has(k) || k.startsWith('_')) continue;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(v);
  }

  const predicates = [];
  let hasMediaType = false;
  for (const [param, values] of grouped) {
    if (RANGE_KEY[param]) { predicates.push(...rangeNodes(RANGE_KEY[param], values[0])); continue; }
    const key = KEY_MAP[param];
    if (!key) continue; // unknown/unsupported param — skip (predicate stays valid)
    if (key === 'MEDIA_TYPE') hasMediaType = true;
    const vals = UPPERCASE_VALUE.has(param) ? values.map((v) => v.toUpperCase()) : values;
    predicates.push(keyNode(key, vals, checklistKey));
  }

  // Always constrain to imaged records (the gallery's mediaType=StillImage).
  if (!hasMediaType) predicates.push({ type: 'equals', key: 'MEDIA_TYPE', value: 'StillImage' });

  // Free-text q -> fulltextSearch; geometry -> within.
  const q = params.get('q');
  if (q) predicates.push({ type: 'fulltextSearch', q });
  const geometry = params.get('geometry');
  if (geometry) predicates.push({ type: 'within', geometry });

  const predicate = predicates.length === 1 ? predicates[0] : { type: 'and', predicates };
  return { predicate, checklistKey };
}

/*
 * Full download-request body. sendNotification:false so GBIF doesn't email
 * (we poll the status endpoint ourselves).
 */
function buildDownloadRequest(searchUrl, { creator, email } = {}) {
  const { predicate, checklistKey } = buildPredicate(searchUrl);
  const body = {
    creator: creator || undefined,
    notificationAddresses: email ? [email] : [],
    sendNotification: false,
    format: 'DWCA',
    predicate,
  };
  if (checklistKey) body.checklistKey = checklistKey;
  return { body, slug: deriveSlug(searchUrl) };
}

module.exports = { buildPredicate, buildDownloadRequest, COL_XR_CHECKLIST };
